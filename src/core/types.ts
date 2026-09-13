// Shared contracts. Every module depends on these shapes; change them only
// together with every consumer.

export type EventBucket = 'attributed' | 'background' | 'unattributed';

export type EventType =
  | 'action_start'
  | 'action_end'
  | 'request'
  | 'response'
  | 'request_failed'
  | 'redirect'
  | 'ws_open'
  | 'ws_close'
  | 'ws_frames'
  | 'navigation'
  | 'console'
  | 'exception'
  | 'dialog'
  | 'download'
  | 'tab_open'
  | 'tab_close'
  | 'cookie_diff'
  | 'storage_diff'
  | 'dom_delta'
  | 'blocked_write'
  | 'blocked_state'
  | 'crash';

export interface TraceEvent {
  id: number;
  /** Milliseconds since session start (monotonic). */
  t: number;
  type: EventType;
  actionId: number | null;
  bucket: EventBucket | null;
  tabId: string;
  /** Request id ('r12') when the event concerns a request. */
  requestId: string | null;
  data: Record<string, unknown>;
}

export type NewTraceEvent = Omit<TraceEvent, 'id'>;

export type InitiatorType = 'parser' | 'script' | 'preload' | 'redirect' | 'other' | 'signedExchange' | 'preflight';

export interface Initiator {
  type: InitiatorType;
  url?: string;
  line?: number;
  /** True when any frame or async parent in the CDP stack is a setInterval. */
  stackHasInterval: boolean;
  /** Request id ('rN') of the request that initiated this one, if known. */
  parentRequestId?: string;
}

export type RequestOrigin = 'page' | 'worker' | 'other';

export interface RequestTiming {
  startMs: number;
  responseMs?: number;
  endMs?: number;
}

export interface RequestRecord {
  /** Public id: 'r' + sequence. */
  id: string;
  cdpId: string;
  tabId: string;
  /** ms since session start when the request was sent. */
  t: number;
  method: string;
  url: string;
  /** CDP resource type lowercased: document, xhr, fetch, script, image, ping, websocket, eventsource, other... */
  resourceType: string;
  status?: number;
  statusText?: string;
  failed?: string;
  initiator: Initiator;
  requestHeaders: Record<string, string>;
  responseHeaders?: Record<string, string>;
  postData?: string;
  bodyHash?: string;
  bodySize?: number;
  mimeType?: string;
  timing: RequestTiming;
  origin: RequestOrigin;
  /** Public id of the request this one was redirected from. */
  redirectedFrom?: string;
  isNavigation: boolean;
  actionId: number | null;
  bucket: EventBucket | null;
}

export interface LocatorBundle {
  role?: string;
  name?: string;
  text?: string;
  testId?: string;
  id?: string;
  label?: string;
  placeholder?: string;
  css?: string;
  tag?: string;
  inputType?: string;
  /** Frame URL when the element lives in a child frame. */
  frame?: string;
}

export type ActionSource = 'agent' | 'human' | 'flow';

export type ActionKind =
  | 'open'
  | 'goto'
  | 'back'
  | 'forward'
  | 'reload'
  | 'click'
  | 'dblclick'
  | 'fill'
  | 'type'
  | 'press'
  | 'select'
  | 'check'
  | 'uncheck'
  | 'hover'
  | 'scroll'
  | 'upload'
  | 'submit'
  | 'replay';

export interface CookieDiff {
  added: number;
  changed: number;
  removed: number;
}

export interface EffectSummary {
  navigatedTo?: string;
  requests: number;
  failed: { status: number | 'failed'; count: number }[];
  cookies: CookieDiff;
  newElements: number;
  consoleErrors: number;
  dialogs: string[];
  tabsOpened: string[];
  downloads: string[];
  blockedWrites: string[];
  blocked?: string;
  /** Set when the quiet window hit maxWindowMs before the page settled. */
  windowCutMs?: number;
  hiddenBackground: number;
  hiddenUnattributed: number;
}

export interface ActionRecord {
  id: number;
  source: ActionSource;
  kind: ActionKind;
  tabId: string;
  ref?: string;
  target?: LocatorBundle;
  /** Accessible name or text of the target, as seen by the user. */
  targetName?: string;
  /** Stored masked when secret is true. */
  value?: string;
  secret: boolean;
  t0: number;
  t1?: number;
  urlBefore: string;
  urlAfter?: string;
  summary?: EffectSummary;
  error?: string;
  /** Snapshot ids (see SnapshotRecord). */
  snapshotBefore?: number;
  snapshotAfter?: number;
}

/** Node of Playwright's ariaSnapshotJSON({ mode: 'ai' }) output. */
export interface AriaNode {
  role: string;
  name?: string;
  ref?: string;
  url?: string;
  text?: string;
  level?: number;
  checked?: boolean | 'mixed';
  disabled?: boolean;
  expanded?: boolean;
  selected?: boolean;
  pressed?: boolean | 'mixed';
  active?: boolean;
  cursor?: string;
  children?: AriaNode[];
  [key: string]: unknown;
}

export interface SnapshotRecord {
  id: number;
  t: number;
  tabId: string;
  url: string;
  title: string;
  tree: AriaNode[];
}

export interface SessionRecord {
  name: string;
  startedAt: string;
  mode: 'agent' | 'human';
  chromiumVersion?: string;
}

export interface CookieRecord {
  name: string;
  value: string;
  domain: string;
  path: string;
  httpOnly: boolean;
  secure: boolean;
  expires: number;
}

/** What every RPC method returns. `text` is what the CLI prints. */
export interface RpcResult {
  text: string;
  data: unknown;
  /** Files written by the call (exports, full bodies, large outputs). */
  files?: string[];
}

export interface RpcRequest {
  id: number;
  method: string;
  params: Record<string, unknown>;
}

export type RpcResponse =
  | { id: number; ok: true; result: RpcResult }
  | { id: number; ok: false; error: { message: string; hint?: string } };

export class RastroError extends Error {
  readonly hint: string | undefined;
  constructor(message: string, hint?: string) {
    super(message);
    this.name = 'RastroError';
    this.hint = hint;
  }
}

export interface OpenParams {
  url?: string;
  headed?: boolean;
  allowWrite?: string[];
  /** Absolute directories `upload` may read from, besides the session uploads dir. */
  allowUpload?: string[];
  dialogs?: 'accept' | 'dismiss';
  pwTrace?: boolean;
  quietMs?: number;
  maxWindowMs?: number;
  timeoutMs?: number;
}

export interface ViewParams {
  region?: string;
  all?: boolean;
  urls?: boolean;
  find?: string;
}

export interface ActParams {
  ref: string;
  kind: ActionKind;
  value?: string;
  secret?: boolean;
}

export type RpcMethod =
  | 'open'
  | 'goto'
  | 'back'
  | 'forward'
  | 'reload'
  | 'view'
  | 'act'
  | 'detail'
  | 'history'
  | 'effects'
  | 'trace'
  | 'request'
  | 'snapshot'
  | 'screenshot'
  | 'console'
  | 'cookies'
  | 'storage'
  | 'tabs'
  | 'eval'
  | 'replay'
  | 'export'
  | 'recordStart'
  | 'recordStop'
  | 'flowSave'
  | 'flowRun'
  | 'flowExport'
  | 'flowImport'
  | 'status'
  | 'close';

export type Engine = {
  [M in RpcMethod]: (params: Record<string, unknown>) => Promise<RpcResult>;
};
