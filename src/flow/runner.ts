// Executes a parsed Flow against a live session: navigation and target steps
// go through the same action pipeline agent/human actions use (source
// 'flow'), so their effects get the same attribution, summary and history
// entry. `wait`/`assert`/`if` are pure control flow with no action of their
// own. No file I/O here — src/engine/flows.ts reads/writes flow files and
// calls this with an already-parsed `Flow`.

import type { Locator, Page } from 'playwright-core';
import type { RequestRecord, RpcResult } from '../core/types.ts';
import { RastroError } from '../core/types.ts';
import type { Condition, Expect, Flow, FlowStep, StepKind, Target } from './format.ts';
import { matchesRequestPattern, parseRequestPattern, stepKind, substitute } from './format.ts';
import { resolveBundle } from '../perception/locators.ts';
import { quote } from '../format/text.ts';
import type { Session } from '../engine/session.ts';
import type { SecretRegistry } from '../security/redact.ts';
import { parseSecretRef, secretGet } from '../security/vault.ts';
import type { RunActionInput } from '../engine/engine.ts';

/** The slice of `EngineCore` the runner needs; `EngineCore` satisfies this
 * structurally, so callers pass `{ core: engineCoreInstance }` directly. */
export interface FlowRunnerCore {
  readonly session: Session | undefined;
  readonly secrets: SecretRegistry;
  readonly store: { requests(q: { actionId?: number }): RequestRecord[] };
  readonly timeoutMs: number;
  open(params: Record<string, unknown>): Promise<RpcResult>;
  runAction(input: RunActionInput): Promise<RpcResult>;
}

export interface RunFlowOpts {
  from?: number;
  params?: Record<string, string>;
}

export interface RunFlowResult {
  ok: boolean;
  stepsRun: number;
  failedStep?: number;
  reason?: string;
  lines: string[];
}

type StepOutcome = { ok: true } | { ok: false; message: string };

function requirePage(core: FlowRunnerCore): Page {
  if (!core.session) throw new RastroError('no browser open', 'run rastro open <url>');
  return core.session.activePage();
}

function matchesUrlPattern(pathname: string, pattern: string): boolean {
  if (!pattern.includes('*')) return pathname === pattern;
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(pathname);
}

async function waitForUrlPattern(page: Page, pattern: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (matchesUrlPattern(new URL(page.url()).pathname, pattern)) return;
    if (Date.now() - start >= timeoutMs) throw new Error(`timed out waiting for url ${pattern}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function describeRequestMismatch(pattern: string, requests: RequestRecord[]): string {
  const { method, path } = parseRequestPattern(pattern);
  const candidate = requests.find(
    (r) => r.method.toUpperCase() === method && matchesUrlPattern(new URL(r.url).pathname, path),
  );
  if (!candidate) return `expected ${pattern}, got no matching request`;
  const got = candidate.status !== undefined ? String(candidate.status) : (candidate.failed ?? 'failed');
  return `expected ${pattern}, got ${got}`;
}

function describeTarget(target: Target): string {
  const role = target.role ?? target.tag ?? 'element';
  const name = target.name ?? target.label ?? target.text ?? target.placeholder ?? target.testId ?? '';
  return `${role} ${quote(name)}`;
}

async function resolve(page: Page, target: Target): Promise<Locator> {
  try {
    return await resolveBundle(page, target);
  } catch {
    throw new RastroError(`element not found: ${describeTarget(target)}`, 'run rastro view');
  }
}

function targetLabel(target: Target): string {
  return target.label ?? target.name ?? target.text ?? target.placeholder ?? target.testId ?? '';
}

// Mirrors format.ts's PARAM_PLACEHOLDER; kept local since that one isn't
// exported (it's an implementation detail of `substitute`).
const PARAM_REF = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

function referencedParams(raw: string): string[] {
  return [...raw.matchAll(PARAM_REF)].map((m) => m[1]!);
}

/**
 * Resolves the flow's parameters, including `secret:<name>` references against
 * the keyring. This runs inside the daemon on purpose: had the CLI resolved
 * them, the value would have to travel as an RPC parameter and would show up in
 * the argv of anything spawned in between. A missing entry throws here, before
 * the first step, rather than half-way through a login.
 */
function buildParamValues(
  flow: Flow,
  provided: Record<string, string> | undefined,
  secrets: SecretRegistry,
): Record<string, string> {
  const values: Record<string, string> = {};
  const fromKeyring = (name: string, ref: string): string => {
    const value = fromVault(name, ref);
    // Anything that came out of the keyring is a secret whether or not the
    // flow said so, so mark the param: `resolveValue` reads that flag to
    // decide how the action is recorded, and the registry masks the value in
    // every other output.
    const def = flow.params?.[name];
    if (def) def.secret = true;
    secrets.add(value);
    return value;
  };
  for (const [name, def] of Object.entries(flow.params ?? {})) {
    if (def.from !== undefined) values[name] = fromKeyring(name, def.from);
    else if (def.default !== undefined) values[name] = def.default;
  }
  for (const [name, raw] of Object.entries(provided ?? {})) {
    values[name] = parseSecretRef(raw) === null ? raw : fromKeyring(name, raw);
  }
  return values;
}

function fromVault(param: string, ref: string): string {
  const entry = parseSecretRef(ref);
  if (entry === null) throw new RastroError(`param ${param}: "${ref}" is not a secret reference`, 'use secret:<name>');
  const value = secretGet(entry);
  if (value === null) {
    throw new RastroError(`param ${param}: no secret «${entry}» in the keyring`, `store it: rastro secret set ${entry}`);
  }
  return value;
}

/** Substitutes `raw`'s params and, if any referenced param is `secret`,
 * registers its resolved value with the secret registry and reports the
 * value as secret so the recorded action masks it. */
function resolveValue(
  raw: string,
  flow: Flow,
  paramValues: Record<string, string>,
  secrets: SecretRegistry,
): { value: string; secret: boolean } {
  const names = referencedParams(raw);
  const secret = names.some((n) => flow.params?.[n]?.secret === true);
  const value = substitute(raw, paramValues);
  if (secret) {
    for (const name of names) {
      if (flow.params?.[name]?.secret && paramValues[name] !== undefined) secrets.add(paramValues[name]);
    }
  }
  return { value, secret };
}

async function checkExpect(core: FlowRunnerCore, expect: Expect, requests: RequestRecord[]): Promise<StepOutcome> {
  if (expect.url !== undefined) {
    const pathname = new URL(requirePage(core).url()).pathname;
    if (!matchesUrlPattern(pathname, expect.url)) {
      return { ok: false, message: `expected url ${expect.url}, got ${pathname}` };
    }
  }
  if (expect.requests) {
    for (const pattern of expect.requests) {
      if (!requests.some((r) => matchesRequestPattern(pattern, r))) {
        return { ok: false, message: describeRequestMismatch(pattern, requests) };
      }
    }
  }
  return { ok: true };
}

interface RunCtx {
  core: FlowRunnerCore;
  flow: Flow;
  paramValues: Record<string, string>;
  lines: string[];
  reqRef: { current: RequestRecord[] };
  countRef: { count: number };
}

async function runActionStep(ctx: RunCtx, step: FlowStep, kind: StepKind, label: string): Promise<StepOutcome> {
  const raw = step as unknown as Record<string, unknown>;
  const expect = raw['expect'] as Expect | undefined;
  const { core, flow, paramValues, lines, reqRef } = ctx;

  try {
    let result: RpcResult;

    switch (kind) {
      case 'open':
      case 'goto': {
        const url = substitute(raw[kind] as string, paramValues);
        if (!core.session) {
          // A flow is a script the caller chose to run, not an agent probing
          // an unfamiliar site: allow writes to the host it opens, the same
          // way `rastro open --allow-write` would for an interactive session.
          let allowWrite: string[] = [];
          try {
            allowWrite = [new URL(url).hostname];
          } catch {
            // malformed URL: runAction below will fail on the goto itself.
          }
          await core.open({ allowWrite });
        }
        result = await core.runAction({
          kind,
          source: 'flow',
          perform: async (page) => {
            await page.goto(url, { timeout: core.timeoutMs });
          },
        });
        break;
      }
      case 'back':
        result = await core.runAction({
          kind: 'back',
          source: 'flow',
          perform: async (page) => {
            await page.goBack({ timeout: core.timeoutMs });
          },
        });
        break;
      case 'forward':
        result = await core.runAction({
          kind: 'forward',
          source: 'flow',
          perform: async (page) => {
            await page.goForward({ timeout: core.timeoutMs });
          },
        });
        break;
      case 'reload':
        result = await core.runAction({
          kind: 'reload',
          source: 'flow',
          perform: async (page) => {
            await page.reload({ timeout: core.timeoutMs });
          },
        });
        break;
      case 'click':
      case 'dblclick':
      case 'hover':
      case 'check':
      case 'uncheck': {
        const target = raw[kind] as Target;
        result = await core.runAction({
          kind,
          source: 'flow',
          target,
          targetName: targetLabel(target),
          perform: async (page) => {
            const locator = await resolve(page, target);
            const timeout = core.timeoutMs;
            if (kind === 'click') await locator.click({ timeout });
            else if (kind === 'dblclick') await locator.dblclick({ timeout });
            else if (kind === 'hover') await locator.hover({ timeout });
            else if (kind === 'check') await locator.check({ timeout });
            else await locator.uncheck({ timeout });
          },
        });
        break;
      }
      case 'fill':
      case 'type':
      case 'select': {
        const target = raw[kind] as Target;
        const { value, secret } = resolveValue(raw['value'] as string, flow, paramValues, core.secrets);
        result = await core.runAction({
          kind,
          source: 'flow',
          target,
          targetName: targetLabel(target),
          value,
          secret,
          perform: async (page) => {
            const locator = await resolve(page, target);
            const timeout = core.timeoutMs;
            if (kind === 'fill') await locator.fill(value, { timeout });
            else if (kind === 'type') await locator.pressSequentially(value, { timeout });
            else await locator.selectOption(value, { timeout });
          },
        });
        break;
      }
      case 'press': {
        const key = raw['press'] as string;
        const target = raw['target'] as Target | undefined;
        const input: RunActionInput = {
          kind: 'press',
          source: 'flow',
          value: key,
          perform: async (page) => {
            if (target) {
              const locator = await resolve(page, target);
              await locator.press(key, { timeout: core.timeoutMs });
            } else {
              await page.keyboard.press(key);
            }
          },
        };
        if (target) {
          input.target = target;
          input.targetName = targetLabel(target);
        }
        result = await core.runAction(input);
        break;
      }
      default:
        return { ok: true };
    }

    lines.push(`[${label}] ${result.text}`);
    const actionId = (result.data as { action: number }).action;
    const requests = core.store.requests({ actionId });
    reqRef.current = requests;

    if (expect) return checkExpect(core, expect, requests);
    return { ok: true };
  } catch (err) {
    const message = err instanceof RastroError ? err.message : err instanceof Error ? err.message : String(err);
    return { ok: false, message };
  }
}

async function runWait(ctx: RunCtx, step: FlowStep, label: string): Promise<StepOutcome> {
  const wait = (step as unknown as Record<string, unknown>)['wait'] as { text?: string; url?: string; ms?: number };
  try {
    if (wait.text !== undefined) {
      await requirePage(ctx.core).getByText(wait.text).first().waitFor({ state: 'visible', timeout: ctx.core.timeoutMs });
    }
    if (wait.url !== undefined) {
      await waitForUrlPattern(requirePage(ctx.core), wait.url, ctx.core.timeoutMs);
    }
    if (wait.ms !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, wait.ms));
    }
    ctx.lines.push(`[${label}] wait`);
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

async function runAssert(ctx: RunCtx, step: FlowStep, label: string): Promise<StepOutcome> {
  const condition = (step as unknown as Record<string, unknown>)['assert'] as Condition;
  try {
    if (condition.text !== undefined) {
      await requirePage(ctx.core).getByText(condition.text).first().waitFor({ state: 'visible', timeout: 1000 });
    } else if (condition.url !== undefined) {
      const pathname = new URL(requirePage(ctx.core).url()).pathname;
      if (!matchesUrlPattern(pathname, condition.url)) throw new Error(`expected url ${condition.url}, got ${pathname}`);
    } else if (condition.request !== undefined) {
      if (!ctx.reqRef.current.some((r) => matchesRequestPattern(condition.request!, r))) {
        throw new Error(describeRequestMismatch(condition.request, ctx.reqRef.current));
      }
    }
    ctx.lines.push(`[${label}] assert`);
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

async function evaluateCondition(core: FlowRunnerCore, condition: Condition, prevRequests: RequestRecord[]): Promise<boolean> {
  if (condition.text !== undefined) {
    if (!core.session) return false;
    try {
      await core.session.activePage().getByText(condition.text).first().waitFor({ state: 'visible', timeout: 1000 });
      return true;
    } catch {
      return false;
    }
  }
  if (condition.url !== undefined) {
    if (!core.session) return false;
    return matchesUrlPattern(new URL(core.session.activePage().url()).pathname, condition.url);
  }
  if (condition.request !== undefined) {
    return prevRequests.some((r) => matchesRequestPattern(condition.request!, r));
  }
  return false;
}

async function runSteps(
  ctx: RunCtx,
  steps: FlowStep[],
  labelPrefix: string | undefined,
  startIndex: number,
): Promise<{ ok: true } | { ok: false; failLabel: string; message: string }> {
  for (let i = startIndex; i < steps.length; i++) {
    const step = steps[i]!;
    const label = labelPrefix ? `${labelPrefix}.${i + 1}` : `${i + 1}`;
    const kind = stepKind(step);
    ctx.countRef.count++;

    if (kind === 'if') {
      const ifStep = step as unknown as { if: Condition; then: FlowStep[]; else?: FlowStep[] };
      const taken = await evaluateCondition(ctx.core, ifStep.if, ctx.reqRef.current);
      ctx.lines.push(`[${label}] if ${taken ? 'then' : 'else'}`);
      const branch = taken ? ifStep.then : (ifStep.else ?? []);
      const sub = await runSteps(ctx, branch, label, 0);
      if (!sub.ok) return sub;
      continue;
    }

    const outcome =
      kind === 'wait' ? await runWait(ctx, step, label)
      : kind === 'assert' ? await runAssert(ctx, step, label)
      : await runActionStep(ctx, step, kind, label);

    if (!outcome.ok) return { ok: false, failLabel: label, message: outcome.message };
  }
  return { ok: true };
}

export async function runFlow(
  ctxIn: { core: FlowRunnerCore },
  flow: Flow,
  opts: RunFlowOpts,
): Promise<RunFlowResult> {
  const ctx: RunCtx = {
    core: ctxIn.core,
    flow,
    paramValues: buildParamValues(flow, opts.params, ctxIn.core.secrets),
    lines: [],
    reqRef: { current: [] },
    countRef: { count: 0 },
  };

  const startIndex = (opts.from ?? 1) - 1;
  const outcome = await runSteps(ctx, flow.steps, undefined, startIndex);

  if (!outcome.ok) {
    const message = `step ${outcome.failLabel} failed: ${outcome.message}`;
    ctx.lines.push(message);
    const numericStep = Number(outcome.failLabel.split('.')[0]);
    const result: RunFlowResult = { ok: false, stepsRun: ctx.countRef.count, reason: message, lines: ctx.lines };
    if (Number.isFinite(numericStep)) result.failedStep = numericStep;
    return result;
  }

  ctx.lines.push(`flow ${quote(flow.name)} passed (${ctx.countRef.count} steps)`);
  return { ok: true, stepsRun: ctx.countRef.count, lines: ctx.lines };
}
