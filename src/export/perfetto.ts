// Pure Chrome Trace Event Format (JSON object form) serialization, loadable
// by Perfetto and the DevTools Performance panel. No I/O.

import type { ActionRecord, RequestRecord, TraceEvent } from '../core/types.ts';

const PID = 1;
const TID_ACTIONS = 1;
const TID_NETWORK = 2;
const TID_PAGE = 3;

const NON_REQUEST_INSTANT_TYPES = new Set([
  'console',
  'exception',
  'dialog',
  'navigation',
  'download',
  'blocked_write',
  'blocked_state',
  'crash',
  'tab_open',
  'tab_close',
]);

export interface PerfettoInput {
  requests: RequestRecord[];
  actions: ActionRecord[];
  events: TraceEvent[];
  sessionName: string;
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function metadataEvents(): Record<string, unknown>[] {
  return [
    { name: 'process_name', ph: 'M', pid: PID, tid: 0, args: { name: 'rastro' } },
    { name: 'thread_name', ph: 'M', pid: PID, tid: TID_ACTIONS, args: { name: 'actions' } },
    { name: 'thread_name', ph: 'M', pid: PID, tid: TID_NETWORK, args: { name: 'network' } },
    { name: 'thread_name', ph: 'M', pid: PID, tid: TID_PAGE, args: { name: 'page' } },
  ];
}

function actionEvents(action: ActionRecord): Record<string, unknown>[] {
  const name = `#${action.id} ${action.kind}${action.targetName ? ` ${action.targetName}` : ''}`;
  return [
    {
      name,
      cat: 'action',
      ph: 'B',
      ts: action.t0 * 1000,
      pid: PID,
      tid: TID_ACTIONS,
      args: { source: action.source, url: action.urlBefore },
    },
    {
      name,
      cat: 'action',
      ph: 'E',
      ts: (action.t1 ?? action.t0) * 1000,
      pid: PID,
      tid: TID_ACTIONS,
      args: { source: action.source, url: action.urlAfter ?? action.urlBefore },
    },
  ];
}

function requestEndMs(req: RequestRecord): number {
  return req.timing.endMs ?? req.timing.responseMs ?? req.t;
}

function requestEvents(req: RequestRecord): Record<string, unknown>[] {
  const bucket = req.bucket ?? 'unattributed';
  const name = `${req.method} ${pathOf(req.url)}`;
  const args = { status: req.status ?? (req.failed !== undefined ? 0 : undefined), resourceType: req.resourceType, bucket };
  return [
    {
      name,
      cat: `net,${bucket}`,
      ph: 'b',
      id: req.id,
      ts: req.t * 1000,
      pid: PID,
      tid: TID_NETWORK,
      args,
    },
    {
      name,
      cat: `net,${bucket}`,
      ph: 'e',
      id: req.id,
      ts: requestEndMs(req) * 1000,
      pid: PID,
      tid: TID_NETWORK,
      args,
    },
  ];
}

function flowEvents(req: RequestRecord, actions: ActionRecord[]): Record<string, unknown>[] {
  if (req.actionId === null) return [];
  const action = actions.find((a) => a.id === req.actionId);
  if (!action) return [];
  const id = `flow_${req.id}`;
  return [
    {
      name: 'attribution',
      cat: 'flow',
      ph: 's',
      id,
      bp: 'e',
      ts: action.t0 * 1000,
      pid: PID,
      tid: TID_ACTIONS,
    },
    {
      name: 'attribution',
      cat: 'flow',
      ph: 'f',
      id,
      bp: 'e',
      ts: req.t * 1000,
      pid: PID,
      tid: TID_NETWORK,
    },
  ];
}

function traceEventInstant(event: TraceEvent): Record<string, unknown> | undefined {
  if (!NON_REQUEST_INSTANT_TYPES.has(event.type)) return undefined;
  return {
    name: event.type,
    cat: 'page',
    ph: 'i',
    s: 't',
    ts: event.t * 1000,
    pid: PID,
    tid: TID_PAGE,
    args: event.data,
  };
}

export function toPerfetto(input: PerfettoInput): { traceEvents: Record<string, unknown>[]; metadata: Record<string, unknown> } {
  const traceEvents: Record<string, unknown>[] = [...metadataEvents()];

  for (const action of input.actions) {
    traceEvents.push(...actionEvents(action));
  }
  for (const req of input.requests) {
    traceEvents.push(...requestEvents(req));
    traceEvents.push(...flowEvents(req, input.actions));
  }
  for (const event of input.events) {
    const instant = traceEventInstant(event);
    if (instant) traceEvents.push(instant);
  }

  traceEvents.sort((a, b) => (a['ts'] as number) - (b['ts'] as number));

  return {
    traceEvents,
    metadata: { source: 'rastro', session: input.sessionName },
  };
}
