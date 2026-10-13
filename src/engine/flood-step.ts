// The worker half of a flood: inside one session, reach a state, activate one
// element through the normal action pipeline (source `flood`), and report
// what it caused. The coordinator (src/flood/coordinator.ts) decides what to
// try next; this file never does.

import { z } from 'zod';
import type { Locator, Page } from 'playwright-core';
import type { ActionKind, ActionRecord, AriaNode, RpcResult } from '../core/types.ts';
import { RastroError } from '../core/types.ts';
import { interactiveItems, findRef } from '../perception/view.ts';
import { captureBundle } from '../perception/locators.ts';
import { elementKeys, stateHash, structureHash, type FloodElement } from '../flood/state.ts';
import { fillerFor } from '../flood/policy.ts';
import type { SeedState, StateView, StepRequest, StepResult } from '../flood/protocol.ts';
import type { EngineCore, RunActionInput } from './engine.ts';

const StepParamsSchema = z.object({
  start: z.string(),
  path: z.array(z.string()),
  key: z.string().optional(),
  expect: z.string().optional(),
  fill: z.boolean().optional(),
  timeoutMs: z.number().positive().optional(),
});

const SeedStateSchema = z.object({
  cookies: z.array(
    z.object({
      name: z.string(),
      value: z.string(),
      domain: z.string(),
      path: z.string(),
      expires: z.number(),
      httpOnly: z.boolean(),
      secure: z.boolean(),
      sameSite: z.enum(['Strict', 'Lax', 'None']),
    }),
  ),
  origins: z.array(z.object({ origin: z.string(), localStorage: z.array(z.object({ name: z.string(), value: z.string() })) })),
});

const TEXT_ROLES = new Set(['textbox', 'searchbox', 'spinbutton']);

/** Form fields a submit is preceded by; passwords, files and choices are left alone. */
const FILLABLE =
  'input:not([type]), input[type=text], input[type=email], input[type=search], input[type=tel], input[type=url], input[type=number], input[type=date], input[type=time], input[type=datetime-local], input[type=month], input[type=week], textarea';

interface Described extends StateView {
  withRefs: FloodElement[];
}

function describeTree(url: string, title: string, tree: AriaNode[]): Described {
  const withRefs = elementKeys(interactiveItems(tree));
  // The snapshot gives a link's href as written (`/products/2`); the map
  // needs where it goes.
  for (const el of withRefs) {
    if (el.url === undefined) continue;
    try {
      el.url = new URL(el.url, url).href;
    } catch {
      // not a URL; left as written
    }
  }
  const elements = withRefs.map(({ ref: _ref, ...rest }) => rest);
  return { url, title, hash: stateHash(url, withRefs), structure: structureHash(withRefs), elements, withRefs };
}

function kindFor(role: string): ActionKind {
  if (TEXT_ROLES.has(role)) return 'fill';
  if (role === 'combobox') return 'select';
  return 'click';
}

async function prefillForm(locator: Locator, timeout: number): Promise<void> {
  const form = locator.locator('xpath=ancestor::form[1]');
  if ((await form.count()) === 0) return;
  const fields = form.locator(FILLABLE);
  const count = Math.min(await fields.count(), 20);
  for (let i = 0; i < count; i++) {
    const field = fields.nth(i);
    try {
      if (!(await field.isVisible()) || !(await field.isEditable())) continue;
      if ((await field.inputValue()) !== '') continue;
      const info = await field.evaluate((el: Element) => ({
        type: el.getAttribute('type') ?? undefined,
        name: `${el.getAttribute('name') ?? ''} ${el.getAttribute('placeholder') ?? ''} ${el.id}`,
      }));
      await field.fill(fillerFor(info.type, info.name), { timeout });
    } catch {
      // A field that refuses a value is the page's business; the submit still runs.
    }
  }
}

/** The input to `runAction` that activates `key` in whatever page is current
 * when the action starts. The key is resolved against the action's own
 * "before" snapshot, so the ref it clicks is the one that snapshot minted. */
function activation(key: string, role: string, fill: boolean, timeout: number): RunActionInput {
  return {
    kind: kindFor(role),
    source: 'flood',
    perform: async (page: Page, ctx) => {
      const el = elementKeys(interactiveItems(ctx.beforeTree)).find((e) => e.key === key);
      if (!el) throw new RastroError(`flood: element ${key} is not on the page`);
      ctx.targetName = el.name;
      const locator = page.locator(`aria-ref=${el.ref}`);
      try {
        ctx.target = await captureBundle(locator, findRef(ctx.beforeTree, el.ref) ?? undefined);
      } catch {
        // best effort, as in `act`
      }
      if (TEXT_ROLES.has(el.role)) {
        if (ctx.target?.inputType === 'password') {
          await locator.click({ timeout });
          return;
        }
        const value = fillerFor(ctx.target?.inputType, el.name);
        ctx.value = value;
        await locator.fill(value, { timeout });
        await locator.press('Enter', { timeout });
        return;
      }
      if (el.role === 'combobox') {
        const picked = await locator
          .evaluate((node: Element) => {
            if (!(node instanceof HTMLSelectElement) || node.options.length < 2) return null;
            const next = Array.from(node.options).find((o, i) => i !== node.selectedIndex && !o.disabled);
            return next ? next.value : null;
          })
          .catch(() => null);
        if (picked !== null) {
          ctx.value = picked;
          await locator.selectOption(picked, { timeout });
          return;
        }
      }
      if (fill && el.role === 'button') await prefillForm(locator, timeout);
      await locator.click({ timeout });
    },
  };
}

function headerValue(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === name) return v;
  return undefined;
}

export async function floodStep(core: EngineCore, raw: Record<string, unknown>): Promise<RpcResult> {
  const parsed = StepParamsSchema.safeParse(raw);
  if (!parsed.success) throw new RastroError(`invalid params: ${parsed.error.message}`);
  const params = parsed.data;
  const timeout = params.timeoutMs ?? 5_000;
  const fill = params.fill ?? true;

  const actions: number[] = [];
  const requests: StepRequest[] = [];
  const dialogs: string[] = [];
  const downloads: string[] = [];
  let tabsOpened = 0;
  let blocked: string | undefined;

  const collect = (phase: StepRequest['phase'], action: ActionRecord): void => {
    const until = action.t1 ?? core.now();
    for (const r of core.store.requests({ since: action.t0, until })) {
      if (r.actionId !== action.id) continue;
      const masked = core.masked(r);
      const req: StepRequest = { id: r.id, action: action.id, phase, method: r.method, url: r.url, resourceType: r.resourceType };
      if (r.status !== undefined) req.status = r.status;
      if (r.failed !== undefined) req.failed = r.failed;
      if (r.mimeType !== undefined) req.mimeType = r.mimeType;
      const retryAfter = headerValue(r.responseHeaders, 'retry-after');
      if (retryAfter !== undefined) req.retryAfter = retryAfter;
      if (masked.postData !== undefined) req.body = masked.postData.slice(0, 4096);
      requests.push(req);
    }
    for (const ev of core.store.events({ actionId: action.id })) {
      const d = ev.data;
      if (ev.type === 'blocked_write') {
        const req: StepRequest = {
          id: `b${String(ev.id)}`,
          action: action.id,
          phase,
          method: String(d.method),
          url: String(d.url),
          resourceType: 'write',
          blocked: true,
        };
        if (typeof d.body === 'string') req.body = d.body.slice(0, 4096);
        requests.push(req);
      } else if (ev.type === 'dialog') {
        dialogs.push(core.secrets.mask(String(d.message ?? '')));
      } else if (ev.type === 'tab_open') {
        tabsOpened += 1;
      } else if (ev.type === 'download') {
        downloads.push(String(d.filename ?? ''));
      }
    }
    if (action.summary?.blocked) blocked = action.summary.blocked;
  };

  const run = async (phase: StepRequest['phase'], input: RunActionInput): Promise<{ action?: ActionRecord; error?: string }> => {
    const lastBefore = core.store.lastAction()?.id ?? 0;
    let error: string | undefined;
    try {
      await core.runAction(input);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    const action = core.store.lastAction();
    if (!action || action.id <= lastBefore) return { error: error ?? 'no action recorded' };
    actions.push(action.id);
    collect(phase, action);
    await closePopups(core);
    return error === undefined ? { action } : { action, error };
  };

  const describe = async (): Promise<Described> => {
    const { url, title, tree } = await core.snapshotNow();
    return describeTree(url, title, tree);
  };

  const reach = async (): Promise<string | undefined> => {
    const nav = await run('reach', {
      kind: 'goto',
      source: 'flood',
      perform: async (page) => {
        await page.goto(params.start, { timeout: Math.max(timeout, 15_000) });
      },
    });
    if (nav.error !== undefined) return nav.error;
    for (const key of params.path) {
      const view = await describe();
      const el = view.withRefs.find((e) => e.key === key);
      if (!el) return `path element ${key} is gone`;
      const step = await run('reach', activation(key, el.role, fill, timeout));
      if (step.error !== undefined) return step.error;
    }
    return undefined;
  };

  await core.ensureAlive();
  let before = await describe();
  let reused = params.key !== undefined && params.expect !== undefined && before.hash === params.expect;
  let reachError: string | undefined;
  if (!reused) reachError = await reach();
  if (reachError === undefined) {
    before = await describe();
    // Standing in the right state but missing the element (a menu that
    // closed): reach it properly once.
    if (reused && params.key !== undefined && !before.withRefs.some((e) => e.key === params.key)) {
      reused = false;
      reachError = await reach();
      if (reachError === undefined) before = await describe();
    }
  }

  const strip = ({ withRefs: _w, ...view }: Described): StateView => view;
  const result: StepResult = {
    reached: reachError === undefined,
    reused,
    before: strip(before),
    after: strip(before),
    navigated: false,
    requests,
    dialogs,
    tabsOpened,
    downloads,
    actions,
  };
  if (reachError !== undefined) result.reachError = core.secrets.mask(reachError);

  if (reachError === undefined && params.key !== undefined) {
    const el = before.withRefs.find((e) => e.key === params.key);
    if (!el) {
      result.reached = false;
      result.reachError = `element ${params.key} is not on the page`;
    } else {
      const done = await run('activate', activation(params.key, el.role, fill, timeout));
      if (done.action) {
        result.activated = { action: done.action.id, kind: done.action.kind };
        if (done.error !== undefined) result.activated.error = core.secrets.mask(done.error);
        result.navigated = (done.action.urlAfter ?? done.action.urlBefore) !== done.action.urlBefore;
      }
      result.after = strip(await describe());
    }
  }
  if (blocked !== undefined) result.blocked = blocked;

  const what = params.key === undefined ? `visit ${params.start}` : `activate ${params.key}`;
  return {
    text: `${what} · ${result.reached ? 'reached' : `unreachable: ${result.reachError ?? ''}`} · ${String(requests.length)} requests`,
    data: core.masked(result),
  };
}

/** Popups a click opened are recorded (tab_open) and then closed, so the next
 * step starts from the one tab the flood drives. */
async function closePopups(core: EngineCore): Promise<void> {
  const session = core.session;
  if (!session) return;
  for (const tab of session.allTabs()) {
    if (tab.id === session.activeTabId) continue;
    await tab.page.close().catch(() => {});
  }
}

/** The seed session's cookies and storage, for the workers. Raw: it stays on
 * the local socket between two of the user's own processes, and no command
 * prints it. */
export async function floodExport(core: EngineCore): Promise<RpcResult> {
  if (!core.session) return { text: 'no browser open: workers start logged out', data: { cookies: [], origins: [] } satisfies SeedState };
  const state = (await core.session.context.storageState()) as SeedState;
  return { text: `${String(state.cookies.length)} cookies, ${String(state.origins.length)} origins`, data: state };
}

export async function floodImport(core: EngineCore, raw: Record<string, unknown>): Promise<RpcResult> {
  const parsed = SeedStateSchema.safeParse(raw.state);
  if (!parsed.success) throw new RastroError(`invalid seed state: ${parsed.error.message}`);
  const state = parsed.data;
  await core.ensureAlive();
  const context = core.session!.context;
  if (state.cookies.length > 0) await context.addCookies(state.cookies);
  const origins = state.origins.filter((o) => o.localStorage.length > 0);
  if (origins.length > 0) {
    // Set on first load of each origin, and only where the app has not
    // written its own value since.
    await context.addInitScript((list: SeedState['origins']) => {
      const mine = list.find((o) => o.origin === location.origin);
      if (!mine) return;
      for (const { name, value } of mine.localStorage) {
        if (localStorage.getItem(name) === null) localStorage.setItem(name, value);
      }
    }, origins);
  }
  return { text: `seeded ${String(state.cookies.length)} cookies, ${String(origins.length)} origins`, data: { cookies: state.cookies.length, origins: origins.length } };
}
