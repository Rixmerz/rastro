// The shape a routine run reports back, and its text form. Shared by the
// daemon (browser runs), the HTTP runner and the MCP server, so an agent reads
// the same thing whichever engine ran.

export interface WriteRecord {
  method: string;
  /** Path without the query: a query can carry a session key (Moodle's sesskey). */
  path: string;
  /** Sent by page script rather than a form: usually page chatter (template
   * loads, state polls), still counted for retry safety but not listed. */
  xhr?: boolean;
  status?: number;
  /** Redirect target, when the write answered with one: usually the created thing. */
  location?: string;
}

export interface RoutineResult {
  routine: string;
  ok: boolean;
  engine: 'browser' | 'http';
  stepsRun: number;
  finalUrl?: string;
  writes: WriteRecord[];
  /** Action ids of the run, as trace evidence (browser engine only). */
  actions?: { first: number; last: number };
  /** The final attempt's actions, when a login refresh made two: what `flow
   * link` compiles, since the failed attempt and the login are not the routine. */
  attemptActions?: { first: number; last: number };
  failedStep?: string;
  reason?: string;
  /** False once any write went out: retrying could duplicate it. */
  retrySafe?: boolean;
  loginRefreshed?: boolean;
  /** Set when an HTTP attempt gave way to the browser before any write. */
  fellBack?: string;
  /** What `read` and `capture` steps produced, by name. */
  outputs?: Record<string, unknown>;
  /** This exact file is now (or already was) verified. */
  verified: boolean;
}

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function isWriteMethod(method: string): boolean {
  return !READ_METHODS.has(method.toUpperCase());
}

export function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

/** The path alone, for anything printed about a request. */
export function bareOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url.split('?')[0] ?? url;
  }
}

function formatWrite(w: WriteRecord): string {
  const status = w.status === undefined ? '' : ` ${w.status}`;
  const location = w.location ? ` → ${pathOf(w.location)}` : '';
  return `${w.method} ${w.path}${status}${location}`;
}

/** Outputs as text: a string as its own block, a list one JSON line per
 * element, anything else as one JSON line. */
export function formatOutputs(outputs: Record<string, unknown> | undefined): string[] {
  const lines: string[] = [];
  for (const [name, value] of Object.entries(outputs ?? {})) {
    if (typeof value === 'string') {
      lines.push(`${name}:`, value);
    } else if (Array.isArray(value)) {
      lines.push(`${name}: ${value.length} item${value.length === 1 ? '' : 's'}`, ...value.map((v) => JSON.stringify(v)));
    } else {
      lines.push(`${name}: ${JSON.stringify(value)}`);
    }
  }
  return lines;
}

function evidence(result: RoutineResult): string | undefined {
  if (!result.actions) return undefined;
  const { first, last } = result.actions;
  return first === last ? `#${first}` : `#${first}-#${last}`;
}

export function formatRoutineResult(result: RoutineResult): string {
  const lines: string[] = [];
  const via = result.engine === 'http' ? ' · http' : '';
  const ev = evidence(result);

  if (result.ok) {
    lines.push(`${result.routine} ok · ${result.stepsRun} steps${via}`);
    if (result.finalUrl) lines.push(`→ ${result.finalUrl}`);
    lines.push(...formatOutputs(result.outputs));
  } else {
    lines.push(`${result.routine} failed${result.failedStep ? ` at step ${result.failedStep}` : ''}${via}: ${result.reason ?? 'unknown error'}`);
    if (result.finalUrl) lines.push(`page: ${result.finalUrl}`);
  }

  if (result.loginRefreshed) lines.push('login refreshed and retried once');
  if (result.fellBack) lines.push(`http replay gave way to the browser before any write: ${result.fellBack}`);

  const listed = result.writes.filter((w) => !w.xhr);
  const chatter = result.writes.length - listed.length;
  if (result.writes.length > 0) {
    const parts = listed.map(formatWrite);
    if (chatter > 0) parts.push(`${listed.length > 0 ? '+ ' : ''}${chatter} xhr POST${chatter === 1 ? '' : 's'} from page scripts`);
    lines.push(`writes: ${parts.join(' · ')}`);
  } else if (!result.ok) {
    lines.push('writes sent: none');
  }

  if (!result.ok) {
    lines.push(result.retrySafe ? 'retry is safe' : 'a write was sent: do NOT retry before checking what it did');
    if (ev) lines.push(`evidence: ${ev} · inspect with rastro_view or rastro_effects ${result.actions!.last}`);
  } else if (ev) {
    lines.push(`evidence: ${ev}`);
  }
  if (result.ok && !result.verified) lines.push('note: this version of the routine is not verified yet');
  return lines.join('\n');
}
