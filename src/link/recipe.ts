// HTTP recipe: the requests a flow's run caused, as templates plus the rules
// that pull each run-specific value out of an earlier response. Holds no
// captured value that could be a credential — see `assertNoCredentials` in
// compile.ts, which runs before a recipe is ever written.

import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

/** Where an extracted value comes from, in the response of the request that
 * carries the rule (the final hop, after redirects). */
export type ExtractRule =
  | { json: string }
  | { input: string }
  | { regex: string; from: 'body' | 'url' | 'location' }
  | { query: string };

export interface RecipePart {
  name: string;
  value?: string;
  /** `{{param}}` naming a local file, read at run time through the upload sandbox. */
  file?: string;
  filename?: string;
  contentType?: string;
}

export interface RecipeRequest {
  id: string;
  method: string;
  /** Origin and path; a `{{var}}` in the path is URL-encoded when filled. */
  url: string;
  /** Kept apart from `url` so filled values are encoded, whatever they hold. */
  query?: { name: string; value: string }[];
  headers?: Record<string, string>;
  form?: { name: string; value: string }[];
  json?: unknown;
  multipart?: RecipePart[];
  raw?: string;
  /** Status class of the first hop as recorded: `2xx`, `3xx`... */
  expect?: string;
  /** Sent by page script, not by a form or a navigation. */
  xhr?: boolean;
  extract?: Record<string, ExtractRule>;
}

export interface Recipe {
  flow: string;
  /** sha256 of the flow file this was compiled from: a mismatch means stale. */
  flowHash: string;
  params: string[];
  requests: RecipeRequest[];
  warnings?: string[];
}

const ruleSchema = z.union([
  z.strictObject({ json: z.string() }),
  z.strictObject({ input: z.string() }),
  z.strictObject({ regex: z.string(), from: z.enum(['body', 'url', 'location']) }),
  z.strictObject({ query: z.string() }),
]);

const partSchema = z.strictObject({
  name: z.string(),
  value: z.string().optional(),
  file: z.string().optional(),
  filename: z.string().optional(),
  contentType: z.string().optional(),
});

const requestSchema = z.strictObject({
  id: z.string(),
  method: z.string(),
  url: z.string(),
  query: z.array(z.strictObject({ name: z.string(), value: z.string() })).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  form: z.array(z.strictObject({ name: z.string(), value: z.string() })).optional(),
  json: z.unknown().optional(),
  multipart: z.array(partSchema).optional(),
  raw: z.string().optional(),
  expect: z.string().regex(/^[1-5]xx$/).optional(),
  xhr: z.boolean().optional(),
  extract: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), ruleSchema).optional(),
});

const recipeSchema = z.strictObject({
  flow: z.string(),
  flowHash: z.string().regex(/^[0-9a-f]{64}$/),
  params: z.array(z.string()),
  requests: z.array(requestSchema).min(1),
  warnings: z.array(z.string()).optional(),
});

export function parseRecipe(text: string): Recipe {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    throw new Error(`invalid YAML: ${(err as Error).message}`, { cause: err });
  }
  const parsed = recipeSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`recipe${issue && issue.path.length > 0 ? `.${issue.path.join('.')}` : ''}: ${issue?.message ?? 'invalid'}`);
  }
  for (const req of parsed.data.requests) {
    const bodies = [req.form, req.json, req.multipart, req.raw].filter((b) => b !== undefined);
    if (bodies.length > 1) throw new Error(`recipe request ${req.id}: more than one body`);
  }
  return parsed.data as Recipe;
}

export function stringifyRecipe(recipe: Recipe): string {
  return stringifyYaml(recipe, { lineWidth: 0 });
}

/** The recipe file that belongs to a flow file: `x.yaml` → `x.link.yaml`. */
export function recipePathFor(flowFile: string): string {
  return flowFile.replace(/\.ya?ml$/i, '') + '.link.yaml';
}

// `{{name}}`, `{{name|number}}` (a JSON number once filled) and
// `{{cookie:NAME}}` (read from the jar when the request is built, so a
// double-submit token is never frozen into the file).
const VAR = /\{\{\s*(cookie:[^}\s]+|[A-Za-z_][A-Za-z0-9_]*)(\|number)?\s*\}\}/g;

export type Resolve = (name: string) => string | undefined;

function lookup(resolve: Resolve, name: string): string {
  const value = resolve(name);
  if (value === undefined) throw new Error(`no value for {{${name}}}`);
  return value;
}

/** Fills every `{{...}}`; an unknown name is an error, never an empty string.
 * `encode` applies to each inserted value (a URL path needs it). */
export function fill(template: string, resolve: Resolve, encode: (v: string) => string = (v) => v): string {
  return template.replace(VAR, (_m, name: string) => encode(lookup(resolve, name)));
}

/** Like `fill` over a JSON value; a string that is exactly `{{x|number}}`
 * becomes a number again, so a bound numeric field keeps its type. */
export function fillDeep(value: unknown, resolve: Resolve): unknown {
  if (typeof value === 'string') {
    const whole = /^\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\|number\s*\}\}$/.exec(value);
    if (whole) return Number(lookup(resolve, whole[1]!));
    return fill(value, resolve);
  }
  if (Array.isArray(value)) return value.map((v) => fillDeep(v, resolve));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillDeep(v, resolve)]));
  }
  return value;
}

/** Anything but GET/HEAD/OPTIONS counts as a write: conservative on purpose. */
export function isWriteRequest(req: { method: string }): boolean {
  return !['GET', 'HEAD', 'OPTIONS'].includes(req.method.toUpperCase());
}

/** Hosts a recipe talks to: the only cookies its replay needs. */
export function recipeHosts(recipe: Recipe): string[] {
  const hosts = new Set<string>();
  for (const req of recipe.requests) {
    try {
      hosts.add(new URL(req.url.replace(/\{\{[^}]*\}\}/g, 'x')).hostname);
    } catch {
      // a URL the runner could not use either; nothing to scope by.
    }
  }
  return [...hosts];
}

/** Reads a recipe file's hosts, or none when it cannot be parsed. */
export function recipeFileHosts(file: string): string[] {
  try {
    return recipeHosts(parseRecipe(readFileSync(file, 'utf8')));
  } catch {
    return [];
  }
}
