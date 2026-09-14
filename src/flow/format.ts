// Flow format: parsing (YAML -> validated Flow), serialization (Flow -> YAML)
// and the pure derivations (expectations, request-pattern matching, param
// substitution) used to build a flow from recorded actions. No I/O: the
// caller reads and writes files; everything here works on strings and data.

import { z } from 'zod';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { ActionKind, ActionRecord, LocatorBundle, RequestRecord } from '../core/types.ts';

export type Target = LocatorBundle;

export interface Expect {
  url?: string;
  requests?: string[];
}

export interface Condition {
  text?: string;
  url?: string;
  request?: string;
}

interface StepBase {
  id?: string;
  note?: string;
}

export type FlowStep = StepBase &
  (
    | { open: string }
    | { goto: string }
    | { back: true }
    | { forward: true }
    | { reload: true }
    | { click: Target; expect?: Expect }
    | { dblclick: Target; expect?: Expect }
    | { hover: Target; expect?: Expect }
    | { check: Target; expect?: Expect }
    | { uncheck: Target; expect?: Expect }
    | { fill: Target; value: string; expect?: Expect }
    | { type: Target; value: string; expect?: Expect }
    | { select: Target; value: string; expect?: Expect }
    | { press: string; target?: Target; expect?: Expect }
    | { wait: { text?: string; url?: string; ms?: number } }
    | { assert: Condition }
    | { if: Condition; then: FlowStep[]; else?: FlowStep[] }
  );

export interface FlowParam {
  secret?: boolean;
  default?: string;
  /** `secret:<name>` — the daemon resolves it against the keyring at run time,
   * so the value never travels through argv or the flow file. */
  from?: string;
}

export interface Flow {
  name: string;
  params?: Record<string, FlowParam>;
  steps: FlowStep[];
}

export type StepKind =
  | 'open'
  | 'goto'
  | 'back'
  | 'forward'
  | 'reload'
  | 'click'
  | 'dblclick'
  | 'hover'
  | 'check'
  | 'uncheck'
  | 'fill'
  | 'type'
  | 'select'
  | 'press'
  | 'wait'
  | 'assert'
  | 'if';

const STEP_KINDS: readonly StepKind[] = [
  'open', 'goto', 'back', 'forward', 'reload', 'click', 'dblclick', 'hover', 'check',
  'uncheck', 'fill', 'type', 'select', 'press', 'wait', 'assert', 'if',
];

export function stepKind(step: FlowStep): StepKind {
  const obj = step as unknown as Record<string, unknown>;
  for (const kind of STEP_KINDS) {
    if (kind in obj) return kind;
  }
  throw new Error('step has no recognizable kind');
}

// ---------------------------------------------------------------------------
// Parsing (YAML -> Flow), with per-step error paths.
// ---------------------------------------------------------------------------

const LOCATOR_FIELDS = ['role', 'name', 'text', 'testId', 'id', 'label', 'placeholder', 'css'] as const;

const targetSchema = z.strictObject({
  role: z.string().optional(),
  name: z.string().optional(),
  text: z.string().optional(),
  testId: z.string().optional(),
  id: z.string().optional(),
  label: z.string().optional(),
  placeholder: z.string().optional(),
  css: z.string().optional(),
  tag: z.string().optional(),
  inputType: z.string().optional(),
  frame: z.string().optional(),
});

const expectSchema = z.strictObject({
  url: z.string().optional(),
  requests: z.array(z.string()).optional(),
});

const conditionSchema = z.strictObject({
  text: z.string().optional(),
  url: z.string().optional(),
  request: z.string().optional(),
});

const waitSchema = z.strictObject({
  text: z.string().optional(),
  url: z.string().optional(),
  ms: z.number().optional(),
});

const paramSchema = z.strictObject({
  secret: z.boolean().optional(),
  default: z.string().optional(),
  from: z.string().regex(/^secret:/, 'only "secret:<name>" sources are supported').optional(),
});

// S8 (CWE-94): a param name is emitted as a bare identifier into generated
// Playwright code (`const <name> = process.env...`) and substituted into
// flow values — reject anything that isn't a valid JS identifier so it can
// never inject code there.
const PARAM_NAME_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

const paramsSchema = z.record(
  z.string().regex(PARAM_NAME_RE, 'must be a valid identifier'),
  paramSchema,
);

function requireObject(raw: unknown, path: string): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${path}: expected a step object`);
  }
  return raw as Record<string, unknown>;
}

function parseStringValue(raw: unknown, path: string): string {
  if (typeof raw !== 'string') throw new Error(`${path}: expected a string`);
  return raw;
}

function parseUrlValue(raw: unknown, path: string): string {
  if (typeof raw !== 'string' || raw.length === 0) throw new Error(`${path}: expected a non-empty URL string`);
  return raw;
}

function parseTrueValue(raw: unknown, path: string): true {
  if (raw !== true) throw new Error(`${path}: expected true`);
  return true;
}

function parseTarget(raw: unknown, path: string): Target {
  const obj = requireObject(raw, path);
  const parsed = targetSchema.safeParse(obj);
  if (!parsed.success) throw new Error(`${path}: invalid target (${parsed.error.issues[0]?.message ?? 'invalid'})`);
  const hasLocator = LOCATOR_FIELDS.some((field) => parsed.data[field] !== undefined);
  if (!hasLocator) throw new Error(`${path}: target needs at least one locator field`);
  return parsed.data;
}

function parseExpect(raw: unknown, path: string): Expect | undefined {
  const obj = requireObject(raw, path);
  const parsed = expectSchema.safeParse(obj);
  if (!parsed.success) throw new Error(`${path}: invalid expect (${parsed.error.issues[0]?.message ?? 'invalid'})`);
  for (const pattern of parsed.data.requests ?? []) {
    try {
      parseRequestPattern(pattern);
    } catch (err) {
      throw new Error(`${path}.requests: ${(err as Error).message}`, { cause: err });
    }
  }
  return parsed.data;
}

function parseCondition(raw: unknown, path: string): Condition {
  const obj = requireObject(raw, path);
  const parsed = conditionSchema.safeParse(obj);
  if (!parsed.success) throw new Error(`${path}: invalid condition (${parsed.error.issues[0]?.message ?? 'invalid'})`);
  const { text, url, request } = parsed.data;
  if (text === undefined && url === undefined && request === undefined) {
    throw new Error(`${path}: condition needs text, url or request`);
  }
  return parsed.data;
}

function parseWait(raw: unknown, path: string): { text?: string; url?: string; ms?: number } {
  const obj = requireObject(raw, path);
  const parsed = waitSchema.safeParse(obj);
  if (!parsed.success) throw new Error(`${path}: invalid wait (${parsed.error.issues[0]?.message ?? 'invalid'})`);
  if (parsed.data.text === undefined && parsed.data.url === undefined && parsed.data.ms === undefined) {
    throw new Error(`${path}: wait needs text, url or ms`);
  }
  return parsed.data;
}

function detectKind(obj: Record<string, unknown>, path: string): StepKind {
  const present = STEP_KINDS.filter((kind) => kind in obj);
  if (present.length === 0) {
    throw new Error(`${path}: missing step kind (one of ${STEP_KINDS.join(', ')})`);
  }
  if (present.length > 1) {
    throw new Error(`${path}: step has more than one kind (${present.join(', ')})`);
  }
  return present[0]!;
}

function parseStep(raw: unknown, path: string): FlowStep {
  const obj = requireObject(raw, path);
  const kind = detectKind(obj, path);
  const stepPath = `${path}.${kind}`;

  let step: FlowStep;
  switch (kind) {
    case 'open':
      step = { open: parseUrlValue(obj['open'], stepPath) };
      break;
    case 'goto':
      step = { goto: parseUrlValue(obj['goto'], stepPath) };
      break;
    case 'back':
      step = { back: parseTrueValue(obj['back'], stepPath) };
      break;
    case 'forward':
      step = { forward: parseTrueValue(obj['forward'], stepPath) };
      break;
    case 'reload':
      step = { reload: parseTrueValue(obj['reload'], stepPath) };
      break;
    case 'click':
      step = { click: parseTarget(obj['click'], stepPath) };
      break;
    case 'dblclick':
      step = { dblclick: parseTarget(obj['dblclick'], stepPath) };
      break;
    case 'hover':
      step = { hover: parseTarget(obj['hover'], stepPath) };
      break;
    case 'check':
      step = { check: parseTarget(obj['check'], stepPath) };
      break;
    case 'uncheck':
      step = { uncheck: parseTarget(obj['uncheck'], stepPath) };
      break;
    case 'fill':
      step = { fill: parseTarget(obj['fill'], stepPath), value: parseStringValue(obj['value'], `${path}.value`) };
      break;
    case 'type':
      step = { type: parseTarget(obj['type'], stepPath), value: parseStringValue(obj['value'], `${path}.value`) };
      break;
    case 'select':
      step = { select: parseTarget(obj['select'], stepPath), value: parseStringValue(obj['value'], `${path}.value`) };
      break;
    case 'press': {
      const key = parseStringValue(obj['press'], stepPath);
      const target = obj['target'] !== undefined ? parseTarget(obj['target'], `${path}.target`) : undefined;
      step = target ? { press: key, target } : { press: key };
      break;
    }
    case 'wait':
      step = { wait: parseWait(obj['wait'], stepPath) };
      break;
    case 'assert':
      step = { assert: parseCondition(obj['assert'], stepPath) };
      break;
    case 'if': {
      const condition = parseCondition(obj['if'], stepPath);
      const thenRaw = obj['then'];
      if (!Array.isArray(thenRaw)) throw new Error(`${path}.then: expected a list of steps`);
      const thenSteps = thenRaw.map((s, i) => parseStep(s, `${path}.then[${i}]`));
      const elseRaw = obj['else'];
      if (elseRaw === undefined) {
        step = { if: condition, then: thenSteps };
      } else {
        if (!Array.isArray(elseRaw)) throw new Error(`${path}.else: expected a list of steps`);
        const elseSteps = elseRaw.map((s, i) => parseStep(s, `${path}.else[${i}]`));
        step = { if: condition, then: thenSteps, else: elseSteps };
      }
      break;
    }
  }

  if (obj['expect'] !== undefined) {
    const expect = parseExpect(obj['expect'], `${path}.expect`);
    if (expect) (step as StepBase & { expect?: Expect }).expect = expect;
  }
  if (obj['id'] !== undefined) step.id = parseStringValue(obj['id'], `${path}.id`);
  if (obj['note'] !== undefined) step.note = parseStringValue(obj['note'], `${path}.note`);

  return step;
}

export function parseFlow(text: string): Flow {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    throw new Error(`invalid YAML: ${(err as Error).message}`, { cause: err });
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('flow: expected a document with name, params and steps');
  }
  const obj = raw as Record<string, unknown>;

  if (typeof obj['name'] !== 'string' || obj['name'].length === 0) {
    throw new Error('name: expected a non-empty string');
  }

  let params: Record<string, FlowParam> | undefined;
  if (obj['params'] !== undefined) {
    const parsed = paramsSchema.safeParse(obj['params']);
    if (!parsed.success) throw new Error(`params: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
    params = parsed.data;
  }

  const stepsRaw = obj['steps'];
  if (!Array.isArray(stepsRaw)) throw new Error('steps: expected a list of steps');
  const steps = stepsRaw.map((s, i) => parseStep(s, `steps[${i}]`));

  return params ? { name: obj['name'], params, steps } : { name: obj['name'], steps };
}

// ---------------------------------------------------------------------------
// Serialization (Flow -> YAML), with a stable per-step key order.
// ---------------------------------------------------------------------------

// Keys other than the kind key itself, in the order they should appear.
const REST_KEY_ORDER = ['target', 'value', 'then', 'else', 'expect', 'id', 'note'] as const;

function orderStep(step: FlowStep): Record<string, unknown> {
  const raw = step as unknown as Record<string, unknown>;
  const kind = stepKind(step);
  const ordered: Record<string, unknown> = { [kind]: raw[kind] };
  for (const key of REST_KEY_ORDER) {
    const value = raw[key];
    if (value === undefined) continue;
    ordered[key] = key === 'then' || key === 'else' ? (value as FlowStep[]).map(orderStep) : value;
  }
  return ordered;
}

export function stringifyFlow(flow: Flow): string {
  const doc: Record<string, unknown> = { name: flow.name };
  if (flow.params) doc['params'] = flow.params;
  doc['steps'] = flow.steps.map(orderStep);
  return stringifyYaml(doc);
}

// ---------------------------------------------------------------------------
// Param substitution.
// ---------------------------------------------------------------------------

const PARAM_PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

export function substitute(value: string, params: Record<string, string>): string {
  return value.replace(PARAM_PLACEHOLDER, (_match, name: string) => {
    if (!(name in params)) throw new Error(`unknown param ${name}`);
    return params[name]!;
  });
}

// ---------------------------------------------------------------------------
// Request patterns: "METHOD /path STATUS" where STATUS is a 3-digit code or
// a status class ("2xx"). Path may contain "*" as a glob wildcard.
// ---------------------------------------------------------------------------

export interface RequestPattern {
  method: string;
  path: string;
  status: { exact?: number; klass?: 1 | 2 | 3 | 4 | 5 };
}

export function parseRequestPattern(pattern: string): RequestPattern {
  const parts = pattern.trim().split(/\s+/);
  if (parts.length !== 3) throw new Error(`invalid request pattern: ${pattern}`);
  const [method, path, statusToken] = parts as [string, string, string];

  const klassMatch = /^([1-5])xx$/.exec(statusToken);
  if (klassMatch) {
    return { method: method.toUpperCase(), path, status: { klass: Number(klassMatch[1]) as 1 | 2 | 3 | 4 | 5 } };
  }
  if (/^\d{3}$/.test(statusToken)) {
    return { method: method.toUpperCase(), path, status: { exact: Number(statusToken) } };
  }
  throw new Error(`invalid request pattern status: ${pattern}`);
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

function pathnameOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

export function matchesRequestPattern(
  pattern: string,
  request: { method: string; url: string; status?: number },
): boolean {
  const parsed = parseRequestPattern(pattern);
  if (parsed.method !== request.method.toUpperCase()) return false;

  const pathname = pathnameOf(request.url);
  const pathMatches = parsed.path.includes('*') ? globToRegExp(parsed.path).test(pathname) : pathname === parsed.path;
  if (!pathMatches) return false;

  if (request.status === undefined) return false;
  if (parsed.status.exact !== undefined) return request.status === parsed.status.exact;
  return Math.floor(request.status / 100) === parsed.status.klass;
}

// ---------------------------------------------------------------------------
// Deriving expectations and flows from recorded actions.
// ---------------------------------------------------------------------------

const INTERESTING_RESOURCE_TYPES = new Set(['document', 'xhr', 'fetch']);

/**
 * A document request is only interesting when it's a non-GET or an error
 * response (a plain GET navigation is the action itself, not an effect worth
 * asserting); an xhr/fetch call is always interesting, since it's the API
 * traffic a UI action is expected to trigger.
 */
function isInterestingRequest(request: RequestRecord): boolean {
  if (request.failed !== undefined) return false;
  if (!INTERESTING_RESOURCE_TYPES.has(request.resourceType)) return false;
  if (request.resourceType === 'xhr' || request.resourceType === 'fetch') return true;
  return request.method.toUpperCase() !== 'GET' || (request.status !== undefined && request.status >= 400);
}

const MAX_EXPECTED_REQUESTS = 5;

export function expectationFromEffects(action: ActionRecord, attributed: RequestRecord[]): Expect | undefined {
  const expect: Expect = {};

  if (action.urlAfter !== undefined) {
    const afterPath = pathnameOf(action.urlAfter);
    let beforePathAndSearch: string;
    try {
      const before = new URL(action.urlBefore);
      beforePathAndSearch = before.pathname + before.search;
    } catch {
      beforePathAndSearch = action.urlBefore;
    }
    if (afterPath !== beforePathAndSearch) expect.url = afterPath;
  }

  const formatted: string[] = [];
  for (const request of attributed) {
    if (formatted.length >= MAX_EXPECTED_REQUESTS) break;
    if (request.status === undefined || !isInterestingRequest(request)) continue;
    const klass = `${Math.floor(request.status / 100)}xx`;
    const entry = `${request.method.toUpperCase()} ${pathnameOf(request.url)} ${klass}`;
    if (!formatted.includes(entry)) formatted.push(entry);
  }
  if (formatted.length > 0) expect.requests = formatted;

  return expect.url !== undefined || expect.requests !== undefined ? expect : undefined;
}

const INTERACTIVE_KINDS: ReadonlySet<ActionKind> = new Set([
  'click', 'dblclick', 'hover', 'check', 'uncheck', 'fill', 'type', 'select', 'press',
]);

function withTarget(
  kind: 'click' | 'dblclick' | 'hover' | 'check' | 'uncheck',
  target: Target,
  expect: Expect | undefined,
): FlowStep {
  const step: Record<string, unknown> = { [kind]: target };
  if (expect) step['expect'] = expect;
  return step as unknown as FlowStep;
}

function withValue(kind: 'fill' | 'type' | 'select', target: Target, value: string, expect: Expect | undefined): FlowStep {
  const step: Record<string, unknown> = { [kind]: target, value };
  if (expect) step['expect'] = expect;
  return step as unknown as FlowStep;
}

function withPress(key: string, target: Target | undefined, expect: Expect | undefined): FlowStep {
  const step: Record<string, unknown> = { press: key };
  if (target) step['target'] = target;
  if (expect) step['expect'] = expect;
  return step as unknown as FlowStep;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export function actionsToFlow(
  name: string,
  actions: ActionRecord[],
  attributedByAction: Map<number, RequestRecord[]>,
): Flow {
  const params: Record<string, FlowParam> = {};
  const steps: FlowStep[] = [];
  let secretCounter = 0;
  let stepIndex = 0;

  for (const action of actions) {
    if (action.error !== undefined) continue;

    const expect = INTERACTIVE_KINDS.has(action.kind)
      ? expectationFromEffects(action, attributedByAction.get(action.id) ?? [])
      : undefined;

    let step: FlowStep | undefined;

    switch (action.kind) {
      case 'open':
        step = { open: action.urlAfter ?? action.urlBefore };
        break;
      case 'goto':
        step = { goto: action.urlAfter ?? action.urlBefore };
        break;
      case 'back':
        step = { back: true };
        break;
      case 'reload':
        step = { reload: true };
        break;
      case 'click':
      case 'dblclick':
      case 'hover':
      case 'check':
      case 'uncheck':
        if (action.target) step = withTarget(action.kind, action.target, expect);
        break;
      case 'fill':
      case 'type':
      case 'select': {
        if (!action.target) break;
        let value = action.value ?? '';
        if (action.secret) {
          const base = action.target.label ?? action.target.name;
          const slug = base ? slugify(base) : '';
          // A slug can start with a digit (a label like "2FA code"), which
          // isn't a valid identifier — parseFlow's PARAM_NAME_RE would then
          // reject the very flow this just generated.
          const paramName = (slug && !/^[0-9]/.test(slug) ? slug : slug ? `p_${slug}` : '') || `secret${++secretCounter}`;
          params[paramName] = { secret: true };
          value = `{{${paramName}}}`;
        }
        step = withValue(action.kind, action.target, value, expect);
        break;
      }
      case 'press':
        step = withPress(action.value ?? '', action.target, expect);
        break;
      default:
        // forward, scroll, upload, submit, replay have no flow-step equivalent.
        break;
    }

    if (!step) continue;
    step.id = `s${++stepIndex}`;
    steps.push(step);
  }

  return Object.keys(params).length > 0 ? { name, params, steps } : { name, steps };
}
