// Finds the routines on disk: flow files carrying a `tool:` block. Pure reads,
// no daemon. A file that fails to parse is reported, never thrown, so one bad
// edit cannot take down whatever is listing routines (the MCP server included).

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { routineDirs } from '../core/paths.ts';
import { RastroError } from '../core/types.ts';
import { parseFlow, stepKind, type Flow, type FlowStep, type ToolManifest } from '../flow/format.ts';
import { parseRecipe, recipePathFor, type Recipe } from '../link/recipe.ts';
import { contentHash, isVerified } from './state.ts';

/** Also the MCP tool-name rule, minus the length the client adds as a prefix. */
const ROUTINE_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const RESERVED_PREFIX = 'rastro_';

/** The HTTP recipe next to a routine, when `flow link` made one. */
export interface RoutineLink {
  file: string;
  /** `fresh`: compiled from these exact flow bytes. `stale`: the flow changed since. */
  state: 'fresh' | 'stale' | 'invalid';
  /** One HTTP run of these exact recipe bytes succeeded. */
  verified: boolean;
  hash?: string;
  recipe?: Recipe;
  error?: string;
}

export interface Routine {
  name: string;
  file: string;
  flow: Flow;
  tool: ToolManifest;
  hash: string;
  verified: boolean;
  warnings: string[];
  link?: RoutineLink;
}

function readLink(flowFile: string, flowHash: string): RoutineLink | undefined {
  const file = recipePathFor(flowFile);
  if (!existsSync(file)) return undefined;
  try {
    const text = readFileSync(file, 'utf8');
    const recipe = parseRecipe(text);
    const hash = contentHash(text);
    return {
      file,
      state: recipe.flowHash === flowHash ? 'fresh' : 'stale',
      verified: isVerified(hash, 'verified-links'),
      hash,
      recipe,
    };
  } catch (err) {
    return { file, state: 'invalid', verified: false, error: (err as Error).message };
  }
}

export function describeLink(link: RoutineLink | undefined): string | undefined {
  if (!link) return undefined;
  if (link.state === 'invalid') return `link invalid: ${link.error ?? ''}`;
  if (link.state === 'stale') return 'link stale (the flow changed; run flow link again)';
  return link.verified ? 'linked: runs over http' : 'linked, http unverified';
}

export interface RoutineProblem {
  name: string;
  file: string;
  error: string;
}

export interface RoutineCatalog {
  routines: Routine[];
  /** Files that look like routines but cannot be used as one. */
  problems: RoutineProblem[];
  /** Same name in a later directory; the earlier one won. */
  shadowed: { name: string; file: string; by: string }[];
}

function isFlowFile(file: string): boolean {
  return /\.ya?ml$/i.test(file) && !/\.link\.ya?ml$/i.test(file);
}

// Locators a site regenerates on every load: they replay once, then miss.
const VOLATILE_CSS = [/#ext-gen\d+/, /#yui_[\w-]+/, /#ember\d+/, /(nth-of-type\([^)]*\)[^,]*){2,}/];

function walkSteps(steps: FlowStep[], visit: (step: FlowStep) => void): void {
  for (const step of steps) {
    visit(step);
    if (stepKind(step) === 'if') {
      const branch = step as unknown as { then: FlowStep[]; else?: FlowStep[] };
      walkSteps(branch.then, visit);
      walkSteps(branch.else ?? [], visit);
    }
  }
}

export function lintRoutine(flow: Flow): string[] {
  const warnings: string[] = [];
  if (flow.name === 'recorded') warnings.push('flow is still named "recorded"');
  for (const [name, def] of Object.entries(flow.params ?? {})) {
    if (def.from === undefined && !def.description) warnings.push(`param ${name} has no description`);
  }
  let i = 0;
  walkSteps(flow.steps, (step) => {
    i++;
    const raw = step as unknown as Record<string, unknown>;
    for (const value of Object.values(raw)) {
      const css = (value as { css?: unknown } | null)?.css;
      if (typeof css === 'string' && VOLATILE_CSS.some((re) => re.test(css))) {
        warnings.push(`step ${i}: css locator looks generated per page load (${css})`);
      }
    }
  });
  return warnings;
}

/** Reads one file as a routine; `null` when it is a plain flow (no `tool:`). */
export function readRoutine(file: string): Routine | RoutineProblem | null {
  const name = basename(file).replace(/\.ya?ml$/i, '');
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    return { name, file, error: `unreadable: ${(err as Error).message}` };
  }

  let flow: Flow;
  try {
    flow = parseFlow(text);
  } catch (err) {
    // Only surface files that meant to be routines; a broken plain recording
    // is not this listing's business.
    if (!/^tool\s*:/m.test(text)) return null;
    return { name, file, error: (err as Error).message };
  }
  if (!flow.tool) return null;

  if (!ROUTINE_NAME.test(name)) {
    return { name, file, error: 'file name must be letters, digits, "-" or "_" to be a routine' };
  }
  if (name.startsWith(RESERVED_PREFIX)) {
    return { name, file, error: `names starting with ${RESERVED_PREFIX} are reserved for Rastro's own tools` };
  }

  const hash = contentHash(text);
  const routine: Routine = { name, file, flow, tool: flow.tool, hash, verified: isVerified(hash), warnings: lintRoutine(flow) };
  const link = readLink(file, hash);
  if (link) routine.link = link;
  return routine;
}

export function isRoutine(entry: Routine | RoutineProblem | null): entry is Routine {
  return entry !== null && 'flow' in entry;
}

export function loadRoutines(dirs: string[] = routineDirs()): RoutineCatalog {
  const catalog: RoutineCatalog = { routines: [], problems: [], shadowed: [] };
  const seen = new Map<string, string>();

  for (const dir of dirs) {
    let files: string[];
    try {
      files = readdirSync(dir).filter(isFlowFile).sort();
    } catch {
      continue;
    }
    for (const fileName of files) {
      const entry = readRoutine(join(dir, fileName));
      if (entry === null) continue;
      const winner = seen.get(entry.name);
      if (winner !== undefined) {
        catalog.shadowed.push({ name: entry.name, file: entry.file, by: winner });
        continue;
      }
      seen.set(entry.name, entry.file);
      if (isRoutine(entry)) catalog.routines.push(entry);
      else catalog.problems.push(entry);
    }
  }
  return catalog;
}

export function findRoutine(name: string, dirs?: string[]): Routine {
  const catalog = loadRoutines(dirs);
  const routine = catalog.routines.find((r) => r.name === name);
  if (routine) return routine;
  const problem = catalog.problems.find((p) => p.name === name);
  if (problem) throw new RastroError(`routine ${name} is unusable: ${problem.error}`);
  const known = catalog.routines.map((r) => r.name);
  throw new RastroError(`no routine ${name}${known.length > 0 ? ` (known: ${known.join(', ')})` : ''}`);
}
