// Implements the six RPC methods engine.ts stubs out: human capture
// (recordStart/recordStop) and the flow file operations (flowSave/flowRun/
// flowExport/flowImport). Human capture drives the same `runAction` pipeline
// as agent actions and flow steps, just with `source: 'human'` and a
// pre-resolved locator bundle from the in-page capture script instead of a
// `ref`.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ensurePrivateDir } from '../core/paths.ts';
import { basename } from 'node:path';
import { z } from 'zod';
import type { Page } from 'playwright-core';
import type { ActionRecord, LocatorBundle, RequestRecord, RpcResult } from '../core/types.ts';
import { RastroError } from '../core/types.ts';
import { actionsToFlow, parseFlow, stringifyFlow, type Flow, type FlowStep } from '../flow/format.ts';
import { flowToPlaywright } from '../flow/export-playwright.ts';
import { importChromeRecording } from '../flow/import-chrome.ts';
import { installRastroCapture } from '../flow/capture-script.ts';
import { runFlow, type FlowRunnerCore } from '../flow/runner.ts';
import type { EngineCore } from './engine.ts';

const RecordStartSchema = z.object({
  url: z.string().optional(),
  continue: z.string().optional(),
  at: z.number().optional(),
});
const RecordStopSchema = z.object({ save: z.string().optional() });
const FlowSaveSchema = z.object({
  file: z.string(),
  from: z.number().optional(),
  to: z.number().optional(),
  name: z.string().optional(),
});
const FlowRunSchema = z.object({
  file: z.string(),
  from: z.number().optional(),
  params: z.record(z.string(), z.string()).optional(),
});
const FlowExportSchema = z.object({ file: z.string(), out: z.string().optional(), format: z.literal('playwright') });
const FlowImportSchema = z.object({ file: z.string(), out: z.string() });

function parse<T>(schema: z.ZodType<T>, params: Record<string, unknown>): T {
  const result = schema.safeParse(params);
  if (!result.success) throw new RastroError(`invalid params: ${result.error.message}`);
  return result.data;
}

/** Renumbers a step list's `id`s sequentially, used when combining a
 * continued flow's untouched prefix with newly captured steps. */
function renumberSteps(steps: FlowStep[]): FlowStep[] {
  return steps.map((step, i) => ({ ...step, id: `s${i + 1}` }));
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

/** Depth-first search for the first `open`/`goto` step's host, used to size
 * the write-guard allowlist when auto-launching a session that has no
 * `url` of its own to go by (a `continue`d recording). */
function firstNavigationHost(steps: FlowStep[]): string | undefined {
  for (const step of steps) {
    const raw = step as unknown as Record<string, unknown>;
    if (typeof raw['open'] === 'string') return hostOf(raw['open']);
    if (typeof raw['goto'] === 'string') return hostOf(raw['goto']);
    for (const branch of ['then', 'else'] as const) {
      if (Array.isArray(raw[branch])) {
        const host = firstNavigationHost(raw[branch] as FlowStep[]);
        if (host) return host;
      }
    }
  }
  return undefined;
}

function attributedByAction(core: FlowRunnerCore, actions: ActionRecord[]): Map<number, RequestRecord[]> {
  const map = new Map<number, RequestRecord[]>();
  for (const action of actions) map.set(action.id, core.store.requests({ actionId: action.id }));
  return map;
}

interface CapturedEvent {
  kind: string;
  bundle: LocatorBundle;
  value?: string;
  isPassword: boolean;
  ts: number;
}

const CAPTURE_KIND_MAP: Record<string, ActionRecord['kind']> = {
  click: 'click',
  select: 'select',
  check: 'check',
  uncheck: 'uncheck',
  fill: 'fill',
  press: 'press',
  submit: 'submit',
};

export class FlowController {
  private readonly core: EngineCore;
  private bindingInstalled = false;
  private capturing = false;
  private captureQueue: Promise<void> = Promise.resolve();
  private recordedIds: number[] = [];
  private continuedFlow: Flow | undefined;
  private continuedSteps: FlowStep[] = [];

  // R4: browser-clock (`event.ts`, Date.now() in the page) offset from
  // engine-clock (`action.t0`), calibrated once from the first captured
  // event. Lets later events' *real* arrival order be recovered even though
  // the capture queue only gets around to starting their `runAction` call
  // well after they actually happened on the page (a fast human/synthetic
  // driver queues fill+blur+click faster than one action's quiet-wait).
  private clockOffset: number | undefined;
  private lastHumanActionId: number | undefined;

  constructor(core: EngineCore) {
    this.core = core;
  }

  // --- human capture -----------------------------------------------------

  async recordStart(rawParams: Record<string, unknown>): Promise<RpcResult> {
    const params = parse(RecordStartSchema, rawParams);
    const headed = process.env.RASTRO_RECORD_HEADLESS !== '1';

    this.continuedFlow = undefined;
    this.continuedSteps = [];
    if (params.continue) {
      this.continuedFlow = parseFlow(readFileSync(params.continue, 'utf8'));
      const at = params.at ?? this.continuedFlow.steps.length + 1;
      this.continuedSteps = this.continuedFlow.steps.slice(0, Math.max(0, at - 1));
    }

    if (!this.core.session) {
      // Recording is an intentional, human-driven session: allow writes to
      // the host being recorded, the same reasoning as the flow runner's
      // auto-launch (see runner.ts). The host comes from `url` when given,
      // else from the continued flow's own first navigation.
      const host = params.url ? hostOf(params.url) : firstNavigationHost(this.continuedSteps);
      await this.core.open({ headed, allowWrite: host ? [host] : [] });
    } else if (headed) {
      // A session opened earlier is headless, and a human cannot drive what
      // they cannot see. Switching costs a relaunch (headed is a property of
      // the browser process), so ask for it explicitly and pass nothing else:
      // the existing allowlist and dialog policy must survive.
      await this.core.open({ headed });
    }

    this.recordedIds = [];
    this.clockOffset = undefined;
    this.lastHumanActionId = undefined;
    if (params.url) {
      // The initial navigation is "the first action recorded after start"
      // (recordStop's contract): a flow saved from this session needs it to
      // be able to open the page on its own when run standalone later.
      const openRes = await this.core.open({ url: params.url });
      const openId = (openRes.data as { action: number } | null)?.action;
      if (openId !== undefined) this.recordedIds.push(openId);
    }

    if (this.continuedSteps.length > 0) {
      const result = await runFlow({ core: this.core }, { ...this.continuedFlow!, steps: this.continuedSteps }, {});
      if (!result.ok) throw new RastroError(`continue failed: ${result.reason ?? 'unknown error'}`, 'fix the flow before continuing');
      // A prefix `fill` step leaves the field focused without blurring it;
      // left alone, that field fires its `change` event whenever the human
      // driver next moves focus — after capturing has started — and gets
      // mis-recorded as a human edit nobody made. Flush it now, before
      // capture is listening.
      await this.core
        .ensureAlive()
        .then((page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur()))
        .catch(() => {});
    }

    await this.installCapture();
    this.capturing = true;
    return { text: 'recording started', data: null };
  }

  async recordStop(rawParams: Record<string, unknown>): Promise<RpcResult> {
    const params = parse(RecordStopSchema, rawParams);
    this.capturing = false;
    await this.captureQueue;

    const actions = this.recordedIds
      .map((id) => this.core.store.getAction(id))
      .filter((a): a is ActionRecord => a !== null);
    const name = this.continuedFlow?.name ?? 'recorded';
    const captured = actionsToFlow(name, actions, attributedByAction(this.core, actions));

    const steps = renumberSteps([...this.continuedSteps, ...captured.steps]);
    const mergedParams = { ...(this.continuedFlow?.params ?? {}), ...(captured.params ?? {}) };
    const flow: Flow = Object.keys(mergedParams).length > 0 ? { name, params: mergedParams, steps } : { name, steps };

    let savedPath: string | undefined;
    if (params.save) {
      ensurePrivateDir(dirname(params.save));
      writeFileSync(params.save, stringifyFlow(flow), { mode: 0o600 });
      savedPath = params.save;
    }

    const stepCount = captured.steps.length;
    this.recordedIds = [];
    this.continuedFlow = undefined;
    this.continuedSteps = [];

    const text = `recorded ${stepCount} steps` + (savedPath ? `\nsaved to ${savedPath}` : '');
    return { text, data: { steps: stepCount, file: savedPath ?? null } };
  }

  private async installCapture(): Promise<void> {
    const session = this.core.session;
    if (!session) return;

    if (!this.bindingInstalled) {
      // S9: a hostile cross-origin iframe can call an exposed binding too;
      // only trust gestures reported from the page's own top-level frame.
      await session.context.exposeBinding('__rastroCapture', (source, event: unknown) => {
        if (source.frame !== source.page.mainFrame()) return;
        const captured = event as CapturedEvent;
        // Capture events are serialized through this queue in arrival order
        // (each `.then()` waits for the previous handler, including its full
        // `runAction` call), so `handleCaptureEvent` sees them one at a time.
        this.captureQueue = this.captureQueue.then(() => this.handleCaptureEvent(captured, source.page)).catch(() => {});
      });
      await session.context.addInitScript(installRastroCapture);
      // R15: `addInitScript` can lose the race with a popup's very first
      // navigation (the same CDP-attach timing gap noted for the recorder),
      // leaving a freshly opened tab without a working listener even though
      // `installCapture`'s own per-tab loop below only ever covers tabs that
      // already existed. Reapply on every navigation of every tab opened
      // from here on — safe to repeat, since `installRastroCapture` re-arms
      // (tears down and re-adds) rather than skipping when already run.
      session.context.on('page', (page) => {
        const install = (): void => {
          void page.evaluate(installRastroCapture).catch(() => {});
        };
        install();
        page.on('domcontentloaded', install);
      });
      this.bindingInstalled = true;
    }

    for (const tab of session.allTabs()) {
      await tab.page.evaluate(installRastroCapture).catch(() => {});
    }
  }

  private async handleCaptureEvent(event: CapturedEvent, sourcePage: Page): Promise<void> {
    if (!this.capturing) return;
    const kind = CAPTURE_KIND_MAP[event.kind];
    if (!kind) return;

    const targetName =
      event.bundle.label ?? event.bundle.name ?? event.bundle.text ?? event.bundle.placeholder ?? event.bundle.testId ?? '';

    // S9: never trust the page's own `isPassword` flag to decide masking —
    // recheck against the resolved bundle's `inputType`, which the capture
    // script derives from the element's actual `type` attribute.
    const secret = event.bundle.inputType === 'password';

    // R15: record the gesture against the tab it actually came from, not
    // whatever tab happens to be "active" (e.g. a popup opened mid-flow).
    const session = this.core.session;
    const tabId = session?.tabIdForPage(sourcePage);
    const previousActiveTabId = session?.activeTabId;
    if (session && tabId !== undefined && tabId !== session.activeTabId) session.activeTabId = tabId;

    const prevActionId = this.lastHumanActionId;
    let result: RpcResult;
    try {
      result = await this.core.runAction({
        kind,
        source: 'human',
        target: event.bundle,
        targetName,
        value: event.value,
        secret,
        perform: async () => {},
      });
    } finally {
      if (session && previousActiveTabId !== undefined) session.activeTabId = previousActiveTabId;
    }

    const id = (result.data as { action: number } | null)?.action;
    if (id === undefined) return;
    this.recordedIds.push(id);

    // R4: a new capture event closes the previous human action's window
    // immediately. `action.t0` reflects when this queue *got around* to
    // starting the action's `runAction` call, which can be seconds after
    // the gesture actually happened on the page if an earlier action's
    // quiet-wait was still running (a fast fill-then-click lands both
    // events' DOM notifications before the fill's own window closes). The
    // page's own clock (`event.ts`) does not have that lag, so it's used
    // to recover each event's real arrival order and reassign anything
    // that happened at or after this event away from the previous action.
    const action = this.core.store.getAction(id);
    if (action) {
      if (this.clockOffset === undefined) {
        this.clockOffset = event.ts - action.t0;
      } else {
        const arrival = event.ts - this.clockOffset;
        this.core.store.updateAction(id, { t0: arrival });
        if (prevActionId !== undefined) this.closePreviousWindow(prevActionId, id, arrival);
      }
    }
    this.lastHumanActionId = id;
  }

  /** Reassigns anything still attributed to `fromId` that happened at or
   * after `cutoff` to `toId` instead — the effect of ending `fromId`'s
   * window right when the next human gesture arrived. */
  private closePreviousWindow(fromId: number, toId: number, cutoff: number): void {
    for (const req of this.core.store.requests({ actionId: fromId })) {
      if (req.t >= cutoff) this.core.store.setRequestAttribution(req.id, toId, 'attributed');
    }
    for (const ev of this.core.store.events({ actionId: fromId })) {
      if (ev.t >= cutoff) this.core.store.setEventAttribution([ev.id], toId, 'attributed');
    }

    // A navigation is a fact recorded on the action itself (`urlAfter`), not
    // an event in the store: `fromId`'s `runAction` call didn't read the
    // page's URL until its own (overlapped) quiet-wait resolved, by which
    // point the click had already navigated — so it wrongly carries that
    // navigation as its own, while `toId` (whose "before" snapshot already
    // saw the post-navigation URL, since it started even later) shows no
    // change at all. Move the transition to the action that actually caused
    // it.
    const from = this.core.store.getAction(fromId);
    const to = this.core.store.getAction(toId);
    if (from?.urlAfter !== undefined && from.urlAfter !== from.urlBefore && to && to.urlBefore === to.urlAfter) {
      this.core.store.updateAction(fromId, { urlAfter: from.urlBefore });
      this.core.store.updateAction(toId, { urlBefore: from.urlBefore, urlAfter: from.urlAfter });
    }
  }

  // --- flow file operations ------------------------------------------------

  async flowSave(rawParams: Record<string, unknown>): Promise<RpcResult> {
    const params = parse(FlowSaveSchema, rawParams);
    const actions = this.core.store.actions({ from: params.from, to: params.to });
    const name = params.name ?? basename(params.file).replace(/\.ya?ml$/i, '');
    const flow = actionsToFlow(name, actions, attributedByAction(this.core, actions));
    ensurePrivateDir(dirname(params.file));
    writeFileSync(params.file, stringifyFlow(flow), { mode: 0o600 });
    return { text: `saved ${flow.steps.length} steps to ${params.file}`, data: { file: params.file, steps: flow.steps.length } };
  }

  async flowRun(rawParams: Record<string, unknown>): Promise<RpcResult> {
    const params = parse(FlowRunSchema, rawParams);
    const flow = parseFlow(readFileSync(params.file, 'utf8'));
    const opts: { from?: number; params?: Record<string, string> } = {};
    if (params.from !== undefined) opts.from = params.from;
    if (params.params !== undefined) opts.params = params.params;
    const result = await runFlow({ core: this.core }, flow, opts);
    return { text: result.lines.join('\n'), data: result };
  }

  async flowExport(rawParams: Record<string, unknown>): Promise<RpcResult> {
    const params = parse(FlowExportSchema, rawParams);
    const flow = parseFlow(readFileSync(params.file, 'utf8'));
    const code = flowToPlaywright(flow);
    const out = params.out ?? `${params.file.replace(/\.ya?ml$/i, '')}.spec.ts`;
    ensurePrivateDir(dirname(out));
    writeFileSync(out, code, { mode: 0o600 });
    return { text: out, data: { file: out }, files: [out] };
  }

  async flowImport(rawParams: Record<string, unknown>): Promise<RpcResult> {
    const params = parse(FlowImportSchema, rawParams);
    const json: unknown = JSON.parse(readFileSync(params.file, 'utf8'));
    const flow = importChromeRecording(json);
    ensurePrivateDir(dirname(params.out));
    writeFileSync(params.out, stringifyFlow(flow), { mode: 0o600 });
    return { text: params.out, data: { file: params.out }, files: [params.out] };
  }
}
