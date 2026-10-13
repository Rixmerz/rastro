// The script that pours: one shared frontier, N worker sessions draining it
// shallowest-first, a per-host rate every worker obeys, and the map that
// grows as the water rises. No model anywhere in the loop.

import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RpcMethod, RpcResult } from '../core/types.ts';
import { RastroError } from '../core/types.ts';
import { ensurePrivateDir } from '../core/paths.ts';
import { Frontier, type FloodItem } from './frontier.ts';
import { HostLimiter, parseRetryAfter, realClock, type Clock } from './rate.ts';
import { denyReason, hostOf, isExternal, parseRobots } from './policy.ts';
import { PathLearner } from './templates.ts';
import { addEndpoint, formatMapMd, isEndpoint, mergeEndpoints, newMap, summaryLine, type FloodLimits, type FloodMap, type MapState, type PathOf } from './map.ts';
import type { SeedState, StateView, StepRequest, StepResult } from './protocol.ts';

export type CallFn = (
  session: string,
  method: RpcMethod,
  params: Record<string, unknown>,
  opts?: { timeoutMs?: number; spawn?: boolean },
) => Promise<RpcResult>;

export interface FloodOptions extends FloodLimits {
  name: string;
  url: string;
  /** Session whose cookies and storage the workers start with. */
  session: string;
  dir: string;
  mdBudget: number;
  quietMs?: number;
  /** Per-action timeout inside a worker. */
  actionTimeoutMs: number;
}

export interface FloodDeps {
  call: CallFn;
  clock?: Clock;
  /** robots.txt fetcher; resolves undefined when there is none. */
  fetchText?: (url: string) => Promise<string | undefined>;
  log?: (line: string) => void;
}

export interface ResumeFrom {
  map: FloodMap;
  /** Only re-flood below this state. */
  from?: string;
}

/** Regions whose controls repeat on every page: activated once per flood. */
const CHROME_REGIONS = new Set(['header', 'nav', 'footer']);
const BOT_BLOCKS = new Set(['captcha', 'bot-block', '2fa']);
const SEED = 'seed';

function limitsOf(o: FloodOptions): FloodLimits {
  return {
    depth: o.depth,
    budget: o.budget,
    timeMs: o.timeMs,
    workers: o.workers,
    rate: o.rate,
    concurrency: o.concurrency,
    ignoreRobots: o.ignoreRobots,
    skip: o.skip,
    include: o.include,
    fill: o.fill,
  };
}

export function workerName(flood: string, i: number): string {
  return `flood-${flood}-w${String(i)}`;
}

export function mapPaths(dir: string): { json: string; md: string; stop: string; pid: string; log: string } {
  return { json: join(dir, 'map.json'), md: join(dir, 'map.md'), stop: join(dir, 'stop'), pid: join(dir, 'pid'), log: join(dir, 'flood.log') };
}

export function readMap(dir: string): FloodMap {
  const file = mapPaths(dir).json;
  if (!existsSync(file)) throw new RastroError(`no flood map in ${dir}`, 'run rastro flood <url> --name <name> first');
  return JSON.parse(readFileSync(file, 'utf8')) as FloodMap;
}

async function defaultFetchText(url: string): Promise<string | undefined> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5_000), redirect: 'follow' });
    if (!res.ok) return undefined;
    return await res.text();
  } catch {
    return undefined;
  }
}

interface Worker {
  name: string;
  /** Hash of the state its page is in, when known. */
  current?: string;
}

class Flood {
  readonly map: FloodMap;
  private readonly frontier = new Frontier();
  private readonly limiter: HostLimiter;
  private readonly clock: Clock;
  private readonly log: (line: string) => void;
  private readonly fetchText: (url: string) => Promise<string | undefined>;
  private readonly robots = new Map<string, Promise<(path: string) => boolean>>();
  /** Slugs learned from the links seen so far. */
  private readonly learner = new PathLearner();
  private readonly pathOf: PathOf = (url) => {
    try {
      const u = new URL(url);
      const names = [...new Set([...u.searchParams.keys()])].sort();
      const query = names.length > 0 ? `?${names.map((n) => `${n}=`).join('&')}` : '';
      return { host: u.host, path: `${this.learner.templatePath(u.host, u.pathname)}${query}` };
    } catch {
      return { host: '', path: url };
    }
  };
  /** Target URLs of links already queued; compared by their template as it
   * is now, so a slug learned later still catches them. */
  private readonly linkClaims: string[] = [];
  /** `stateTemplate::key` of elements queued, and chrome keys flood-wide. */
  private readonly keyClaims = new Set<string>();
  private readonly hostBlocks = new Map<string, number>();
  private readonly reachFailures = new Map<string, number>();
  private readonly deadline: number;
  private inflight = 0;
  /** Activations taken but not finished, so N workers never overshoot the budget. */
  private inflightActivations = 0;
  private waiters: (() => void)[] = [];
  private stopReason: string | undefined;
  private lastSave = 0;
  private seedState: SeedState = { cookies: [], origins: [] };

  private readonly opts: FloodOptions;
  private readonly deps: FloodDeps;

  constructor(opts: FloodOptions, deps: FloodDeps, resume?: ResumeFrom) {
    this.opts = opts;
    this.deps = deps;
    this.clock = deps.clock ?? realClock;
    this.log = deps.log ?? (() => {});
    this.fetchText = deps.fetchText ?? defaultFetchText;
    this.limiter = new HostLimiter({ rate: opts.rate, concurrency: opts.concurrency }, this.clock);
    this.deadline = this.clock.now() + opts.timeMs;
    const workers = Array.from({ length: opts.workers }, (_, i) => workerName(opts.name, i + 1));
    if (resume) {
      this.map = resume.map;
      this.map.status = 'running';
      delete this.map.stopReason;
      delete this.map.finishedAt;
      this.map.limits = limitsOf(opts);
      this.map.workers = workers;
      this.restore(resume.from);
    } else {
      this.map = newMap(opts.name, opts.url, opts.session, limitsOf(opts), workers);
      this.frontier.push({ state: SEED, depth: 0, retries: 0 });
    }
  }

  // --- resume -------------------------------------------------------------

  private restore(from: string | undefined): void {
    for (const s of this.map.states) {
      for (const el of s.elements) {
        if (el.outcome === 'skipped:duplicate-link' || el.outcome === 'skipped:seen') continue;
        if (el.url !== undefined) this.learner.observe(el.url);
        if (el.role === 'link' && el.url !== undefined) this.linkClaims.push(el.url);
        this.keyClaims.add(this.claimKey(s, el.key, el.region));
      }
    }
    const inside = from === undefined ? () => true : this.subtree(from);
    const keep: FloodMap['unexplored'] = [];
    for (const u of this.map.unexplored) {
      if (u.depth <= this.opts.depth && inside(u.state)) {
        this.frontier.push({ state: u.state, depth: u.depth, retries: 0, ...(u.key !== undefined ? { key: u.key } : {}) });
        const el = this.findState(u.state)?.elements.find((e) => e.key === u.key);
        if (el) el.outcome = 'queued';
      } else {
        keep.push(u);
      }
    }
    this.map.unexplored = keep;
  }

  private subtree(root: string): (state: string) => boolean {
    const parents = new Map(this.map.states.map((s) => [s.id, s.parent]));
    return (state) => {
      for (let cur: string | undefined = state; cur !== undefined; cur = parents.get(cur)) {
        if (cur.toLowerCase() === root.toLowerCase()) return true;
      }
      return false;
    };
  }

  // --- states and elements ----------------------------------------------

  private findState(id: string): MapState | undefined {
    return this.map.states.find((s) => s.id === id);
  }

  /** A state's identity: its URL template, slugs learned so far folded, and
   * its structure. */
  private stateKey(url: string, structure: string): string {
    return `${this.learner.template(url)}#${structure}`;
  }

  private claimKey(state: MapState, key: string, region: string): string {
    return CHROME_REGIONS.has(region) ? `*::${key}` : `${state.urlTemplate}::${key}`;
  }

  private async robotsAllow(url: string): Promise<boolean> {
    if (this.opts.ignoreRobots) return true;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return true;
    }
    let pred = this.robots.get(parsed.origin);
    if (!pred) {
      pred = this.fetchText(`${parsed.origin}/robots.txt`).then((text) => (text === undefined ? () => true : parseRobots(text)));
      this.robots.set(parsed.origin, pred);
    }
    return (await pred)(`${parsed.pathname}${parsed.search}`);
  }

  private async addState(view: StateView, depth: number, path: MapState['path'], parent?: MapState, via?: string): Promise<MapState> {
    for (const el of view.elements) if (el.url !== undefined) this.learner.observe(el.url);
    const state: MapState = {
      id: `S${String(this.map.states.length + 1)}`,
      depth,
      url: view.url,
      urlTemplate: this.learner.template(view.url),
      title: view.title,
      hash: view.hash,
      structure: view.structure,
      path,
      status: depth > this.opts.depth ? 'unvisited' : 'ok',
      elements: view.elements.map((e) => ({ ...e, outcome: 'pending' })),
      load: [],
    };
    if (parent) state.parent = parent.id;
    if (via !== undefined) state.via = via;
    this.map.states.push(state);
    const seedHost = hostOf(this.opts.url);
    for (const el of state.elements) {
      // Claimed first: a nav link or a logout button seen on every page is
      // classified (and listed) once, on the first page it shows up on.
      const claim = this.claimKey(state, el.key, el.region);
      if (this.keyClaims.has(claim)) {
        el.outcome = 'skipped:seen';
        continue;
      }
      this.keyClaims.add(claim);
      if (el.disabled) {
        el.outcome = 'skipped:disabled';
        continue;
      }
      // The 2nd to 20th «Add to basket» of a list do to their item what the
      // first does to its own: one is enough to learn the call.
      if (el.role !== 'link' && !el.key.endsWith('|0')) {
        el.outcome = 'skipped:repeat';
        continue;
      }
      const deny = denyReason(el.name, { skip: this.opts.skip, include: this.opts.include });
      if (deny !== undefined) {
        el.outcome = `skipped:${deny}`;
        continue;
      }
      if (el.role === 'link' && el.url !== undefined) {
        if (isExternal(el.url, seedHost)) {
          el.outcome = 'external';
          this.map.external.push({ state: state.id, name: el.name, url: el.url });
          continue;
        }
        if (!(await this.robotsAllow(el.url))) {
          el.outcome = 'skipped:robots';
          continue;
        }
        const template = this.learner.template(el.url);
        if (this.linkClaims.some((u) => this.learner.template(u) === template)) {
          el.outcome = 'skipped:duplicate-link';
          continue;
        }
        this.linkClaims.push(el.url);
      }
      if (depth > this.opts.depth) {
        this.map.unexplored.push({ state: state.id, key: el.key, depth });
      } else {
        el.outcome = 'queued';
        this.frontier.push({ state: state.id, key: el.key, depth, retries: 0 });
      }
    }
    this.notify();
    return state;
  }

  // --- the loop -----------------------------------------------------------

  private notify(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();
  }

  private idle(): Promise<void> {
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private hostFor(item: FloodItem): string {
    return item.state === SEED ? hostOf(this.opts.url) : hostOf(this.findState(item.state)?.url ?? this.opts.url);
  }

  private hostStopped(host: string): boolean {
    return this.map.hosts.some((h) => h.host === host && h.status !== 'ok');
  }

  private checkStop(): void {
    if (this.stopReason !== undefined) return;
    if (existsSync(mapPaths(this.opts.dir).stop)) this.stopReason = 'stopped';
    else if (this.clock.now() >= this.deadline) this.stopReason = 'time';
    else if (this.map.stats.activations >= this.opts.budget) this.stopReason = 'budget';
    if (this.stopReason !== undefined) this.notify();
  }

  private async openWorker(w: Worker): Promise<void> {
    const open: Record<string, unknown> = { allowWrite: [], dialogs: 'dismiss', timeoutMs: Math.max(this.opts.actionTimeoutMs, 15_000) };
    if (this.opts.quietMs !== undefined) open.quietMs = this.opts.quietMs;
    await this.deps.call(w.name, 'open', open);
    if (this.seedState.cookies.length > 0 || this.seedState.origins.length > 0) {
      await this.deps.call(w.name, 'floodImport', { state: this.seedState });
    }
    delete w.current;
  }

  private async workerLoop(w: Worker): Promise<void> {
    for (;;) {
      this.checkStop();
      if (this.stopReason !== undefined) return;
      const preferred = w.current === undefined ? undefined : this.map.states.find((s) => s.hash === w.current)?.id;
      const item = this.frontier.pop(preferred, (i) => !this.hostStopped(this.hostFor(i)));
      if (!item) {
        if (this.inflight === 0) return;
        await this.idle();
        continue;
      }
      const activation = item.key !== undefined;
      if (activation && this.map.stats.activations + this.inflightActivations >= this.opts.budget) {
        // The budget is spoken for by steps still running; if one of them
        // fails to count, this item gets its turn after all.
        this.frontier.putBack(item);
        if (this.inflight === 0) {
          this.stopReason = 'budget';
          return;
        }
        await this.idle();
        continue;
      }
      this.inflight += 1;
      if (activation) this.inflightActivations += 1;
      try {
        await this.runItem(w, item);
      } finally {
        this.inflight -= 1;
        if (activation) this.inflightActivations -= 1;
        this.notify();
      }
      this.maybeSave();
    }
  }

  private async runItem(w: Worker, item: FloodItem): Promise<void> {
    const state = item.state === SEED ? undefined : this.findState(item.state);
    const host = this.hostFor(item);
    const reuse = state !== undefined && w.current === state.hash;
    const cost = reuse ? 1 : 2 + (state?.path.keys.length ?? 0);
    const params: Record<string, unknown> = {
      start: state?.path.start ?? this.opts.url,
      path: state?.path.keys ?? [],
      fill: this.opts.fill,
      timeoutMs: this.opts.actionTimeoutMs,
    };
    if (state) params.expect = state.hash;
    if (item.key !== undefined) params.key = item.key;

    await this.limiter.acquire(host, cost);
    let result: StepResult;
    try {
      const res = await this.deps.call(w.name, 'floodStep', params, { timeoutMs: 120_000 });
      result = res.data as StepResult;
    } catch (err) {
      this.limiter.release(host);
      const message = err instanceof Error ? err.message : String(err);
      this.log(`${w.name}: ${message}`);
      this.map.stats.errors += 1;
      if (item.retries < 1) {
        // A worker that died (or a daemon that went away) gets a fresh
        // browser and the item one more chance.
        await this.openWorker(w).catch((e: unknown) => this.log(`${w.name}: reopen failed: ${e instanceof Error ? e.message : String(e)}`));
        this.frontier.requeue(item);
      } else {
        this.markElement(state, item.key, { outcome: 'error', error: message });
      }
      return;
    }
    this.limiter.release(host);
    this.map.stats.actions += result.actions.length;
    if (item.key !== undefined) this.map.stats.activations += 1;
    w.current = result.after.hash;
    this.pace(result.requests);
    await this.absorb(w, item, state, result);
  }

  private pace(requests: StepRequest[]): void {
    for (const req of requests) {
      if (req.status !== 429 && req.status !== 503) continue;
      const host = hostOf(req.url);
      this.limiter.penalize(host, parseRetryAfter(req.retryAfter));
      this.log(`${host}: ${String(req.status)}, slowing down to ${this.limiter.rateOf(host).toFixed(2)}/s`);
    }
  }

  private markElement(state: MapState | undefined, key: string | undefined, patch: { outcome: string; error?: string }): void {
    const el = state?.elements.find((e) => e.key === key);
    if (!el) return;
    el.outcome = patch.outcome;
    if (patch.error !== undefined) el.error = patch.error;
  }

  private botBlock(host: string, state: MapState | undefined, reason: string): void {
    const n = (this.hostBlocks.get(host) ?? 0) + 1;
    this.hostBlocks.set(host, n);
    this.limiter.pause(host, 30_000);
    this.log(`${host}: blocked (${reason}), pausing`);
    if (state && state.status === 'ok') {
      state.status = 'blocked';
      state.reason = reason;
    }
    if (n >= 2) {
      // Two in a row: this host is done for this flood. What is left for it
      // goes to unexplored, where `flood resume` can pick it up another day.
      this.setHost(host, 'stopped', `${reason} twice in a row`);
      for (const it of this.frontier.drain((i) => this.hostFor(i) === host)) this.leaveUnexplored(it);
    }
  }

  private setHost(host: string, status: string, reason?: string): void {
    let h = this.map.hosts.find((x) => x.host === host);
    if (!h) {
      h = { host, status, rate: this.limiter.rateOf(host) };
      this.map.hosts.push(h);
    }
    h.status = status;
    if (reason !== undefined) h.reason = reason;
  }

  private leaveUnexplored(item: FloodItem): void {
    if (item.state === SEED) return;
    const u: FloodMap['unexplored'][number] = { state: item.state, depth: item.depth };
    if (item.key !== undefined) u.key = item.key;
    this.map.unexplored.push(u);
    this.markElement(this.findState(item.state), item.key, { outcome: 'pending' });
  }

  private async absorb(w: Worker, item: FloodItem, state: MapState | undefined, result: StepResult): Promise<void> {
    const host = this.hostFor(item);
    if (result.blocked !== undefined && BOT_BLOCKS.has(result.blocked)) this.botBlock(host, state, result.blocked);
    else this.hostBlocks.set(host, 0);

    if (state === undefined) {
      // The seed visit.
      if (!result.reached) {
        this.stopReason = `seed unreachable: ${result.reachError ?? ''}`;
        return;
      }
      const seed = await this.addState(result.before, 0, { start: this.opts.url, keys: [] });
      for (const req of result.requests) {
        if (isEndpoint(req)) seed.load.push(addEndpoint(this.map, req, w.name, { state: seed.id }, this.pathOf));
      }
      seed.load = [...new Set(seed.load)];
      return;
    }
    if (state.status === 'unvisited') state.status = 'ok';

    const el = state.elements.find((e) => e.key === item.key);
    if (!el) return;
    if (!result.reached) {
      const failures = (this.reachFailures.get(state.id) ?? 0) + 1;
      this.reachFailures.set(state.id, failures);
      el.outcome = 'unreachable';
      if (result.reachError !== undefined) el.error = result.reachError;
      if (failures >= 2 && state.status === 'ok') {
        state.status = 'unreachable';
        if (result.reachError !== undefined) state.reason = result.reachError;
        for (const it of this.frontier.drain((i) => i.state === state.id)) {
          this.markElement(state, it.key, { outcome: 'unreachable' });
        }
      }
      return;
    }
    this.reachFailures.set(state.id, 0);

    if (result.activated) el.action = { worker: w.name, id: result.activated.action };
    const trigger = { state: state.id, key: el.key, name: el.name };
    const endpoints = result.requests.filter((r) => r.phase === 'activate' && isEndpoint(r)).map((r) => addEndpoint(this.map, r, w.name, trigger, this.pathOf));
    if (endpoints.length > 0) el.endpoints = [...new Set(endpoints)];

    if (result.activated?.error !== undefined) {
      el.outcome = 'error';
      el.error = result.activated.error;
      this.map.stats.errors += 1;
      return;
    }
    if (result.blocked !== undefined) {
      el.outcome = `blocked:${result.blocked}`;
      return;
    }
    if (result.after.url.startsWith('chrome-error:')) {
      // The navigation failed in the browser: most often a form post the
      // write guard aborted, which leaves Chromium on its error page.
      el.outcome = result.requests.some((r) => r.phase === 'activate' && r.blocked) ? 'blocked-write' : 'error';
      if (el.outcome === 'error') el.error = 'navigation failed';
      delete w.current;
      return;
    }
    if (result.after.url !== '' && isExternal(result.after.url, hostOf(this.opts.url))) {
      el.outcome = 'external';
      this.map.external.push({ state: state.id, name: el.name, url: result.after.url });
      delete w.current;
      return;
    }
    if (result.after.hash === result.before.hash || result.after.hash === state.hash || this.stateKey(result.after.url, result.after.structure) === this.stateKey(state.url, state.structure)) {
      el.outcome = 'same';
      el.to = state.id;
      return;
    }
    const key = this.stateKey(result.after.url, result.after.structure);
    let target = this.map.states.find((s) => s.hash === result.after.hash || this.stateKey(s.url, s.structure) === key);
    if (!target) {
      const path = result.navigated ? { start: result.after.url, keys: [] } : { start: state.path.start, keys: [...state.path.keys, el.key] };
      target = await this.addState(result.after, state.depth + 1, path, state, el.name);
    }
    el.outcome = 'done';
    el.to = target.id;
  }

  // --- output -----------------------------------------------------------

  private maybeSave(): void {
    const now = this.clock.now();
    if (now - this.lastSave < 2_000) return;
    this.lastSave = now;
    this.save();
    this.log(this.progress());
  }

  progress(): string {
    const level = this.frontier.level;
    return `level ${level === undefined ? '-' : String(level)} · ${String(this.map.states.length)} states · ${String(this.map.stats.activations)}/${String(this.opts.budget)} activations · ${String(this.map.endpoints.length)} endpoints · queue ${String(this.frontier.size)}`;
  }

  save(): void {
    this.map.updatedAt = new Date().toISOString();
    mergeEndpoints(this.map, this.pathOf);
    for (const s of this.map.states) s.urlTemplate = this.learner.template(s.url);
    for (const h of this.map.hosts) h.rate = this.limiter.rateOf(h.host);
    const paths = mapPaths(this.opts.dir);
    writeFileSync(`${paths.json}.tmp`, `${JSON.stringify(this.map, null, 1)}\n`, { mode: 0o600 });
    renameSync(`${paths.json}.tmp`, paths.json);
    writeFileSync(paths.md, `${formatMapMd(this.map, this.opts.mdBudget)}\n`, { mode: 0o600 });
  }

  // --- run ------------------------------------------------------------------

  async run(): Promise<FloodMap> {
    ensurePrivateDir(this.opts.dir);
    rmSync(mapPaths(this.opts.dir).stop, { force: true });
    if (!this.map.states.length && !(await this.robotsAllow(this.opts.url))) {
      throw new RastroError(`robots.txt disallows ${this.opts.url}`, 'pass --ignore-robots only for a site you are allowed to crawl');
    }
    try {
      const res = await this.deps.call(this.opts.session, 'floodExport', {}, { spawn: false, timeoutMs: 15_000 });
      this.seedState = res.data as SeedState;
      this.map.seed.seeded = this.seedState.cookies.length > 0 || this.seedState.origins.length > 0;
    } catch {
      this.log(`session ${this.opts.session} is not running: workers start logged out`);
    }

    const workers: Worker[] = this.map.workers.map((name) => ({ name }));
    await Promise.all(workers.map((w) => this.openWorker(w)));
    this.save();
    try {
      await Promise.all(workers.map((w) => this.workerLoop(w)));
    } finally {
      this.finish();
      await Promise.all(workers.map((w) => this.deps.call(w.name, 'close', {}, { spawn: false, timeoutMs: 15_000 }).catch(() => undefined)));
    }
    return this.map;
  }

  private finish(): void {
    for (const it of this.frontier.drain()) this.leaveUnexplored(it);
    const beyondDepth = this.map.states.some((s) => s.status === 'unvisited');
    if (this.stopReason === 'stopped') this.map.status = 'stopped';
    else if (this.stopReason !== undefined) {
      this.map.status = this.stopReason.startsWith('seed') ? 'failed' : 'limit';
      this.map.stopReason = this.stopReason;
    } else if (beyondDepth || this.map.unexplored.length > 0) {
      this.map.status = 'limit';
      this.map.stopReason = this.map.hosts.some((h) => h.status !== 'ok') ? 'host stopped' : 'depth';
    } else {
      this.map.status = 'done';
    }
    this.map.finishedAt = new Date().toISOString();
    this.save();
    this.log(summaryLine(this.map));
  }
}

export async function runFlood(opts: FloodOptions, deps: FloodDeps, resume?: ResumeFrom): Promise<FloodMap> {
  return new Flood(opts, deps, resume).run();
}
