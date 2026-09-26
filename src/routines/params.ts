// Validates a routine's caller-supplied parameters against the flow's typed
// declarations. Runs in the daemon (the CLI and the generic MCP tool bypass
// any client-side schema) and again in the MCP server, where it also feeds the
// generated input schema. Values leave here as strings: that is all a flow
// substitutes.

import { homedir } from 'node:os';
import { isAbsolute, join, normalize } from 'node:path';
import { RastroError } from '../core/types.ts';
import type { Flow, FlowParam } from '../flow/format.ts';
import { parseSecretRef, secretGet } from '../security/vault.ts';

/** A parameter the caller supplies: not sourced from the keyring. */
export function isCallerParam(def: FlowParam): boolean {
  return def.from === undefined;
}

/** A caller parameter with neither a value source nor a default. */
export function isRequired(def: FlowParam): boolean {
  return isCallerParam(def) && def.default === undefined;
}

function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

function coerce(name: string, def: FlowParam, raw: unknown): string {
  if (raw === null || typeof raw === 'object') {
    throw new RastroError(`param ${name}: expected a single value`);
  }
  const value = String(raw);
  const bad = (what: string): never => {
    throw new RastroError(`param ${name}: expected ${what}, got "${value}"`);
  };

  switch (def.type ?? 'string') {
    case 'integer':
      if (!/^-?\d+$/.test(value)) bad('an integer');
      break;
    case 'number':
      if (value.trim() === '' || !Number.isFinite(Number(value))) bad('a number');
      break;
    case 'boolean':
      if (value !== 'true' && value !== 'false') bad('true or false');
      break;
    case 'url': {
      let url: URL | undefined;
      try {
        url = new URL(value);
      } catch {
        bad('an http(s) URL');
      }
      if (url && url.protocol !== 'http:' && url.protocol !== 'https:') bad('an http(s) URL');
      break;
    }
    case 'path': {
      const expanded = expandHome(value);
      // A relative path would resolve against the daemon's cwd, which nobody
      // calling a tool can see or predict.
      if (!isAbsolute(expanded)) bad('an absolute path');
      return normalize(expanded);
    }
    case 'string':
      break;
  }

  if (def.enum && !def.enum.includes(value)) bad(`one of ${def.enum.join(', ')}`);
  return value;
}

/**
 * Checks `provided` against `flow.params` and returns the values to hand the
 * runner. Refuses unknown names, keyring-sourced names (the caller must not be
 * able to override a secret the routine resolves itself), invalid values and
 * missing required ones — all before the first step, never half-way through.
 */
export function validateRoutineParams(flow: Flow, provided: Record<string, unknown> | undefined): Record<string, string> {
  const declared = flow.params ?? {};
  const out: Record<string, string> = {};

  for (const [name, raw] of Object.entries(provided ?? {})) {
    const def = declared[name];
    if (def === undefined) {
      const known = Object.keys(declared).filter((k) => isCallerParam(declared[k]!));
      throw new RastroError(`unknown param ${name}`, known.length > 0 ? `this routine takes: ${known.join(', ')}` : 'this routine takes no params');
    }
    if (!isCallerParam(def)) {
      throw new RastroError(`param ${name} comes from the keyring and cannot be supplied`);
    }
    if (raw === undefined) continue;
    out[name] = coerce(name, def, raw);
  }

  const missing = Object.entries(declared)
    .filter(([name, def]) => isRequired(def) && out[name] === undefined)
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new RastroError(`missing param ${missing.join(', ')}`, 'supply it with --param name=value');
  }
  return out;
}

function fromKeyring(param: string, ref: string): string {
  const entry = parseSecretRef(ref);
  const value = entry === null ? null : secretGet(entry);
  if (value === null) throw new RastroError(`param ${param}: no secret for ${ref} in the keyring`, `store it: rastro secret set ${entry ?? '<name>'}`);
  return value;
}

/**
 * Every value a run of `flow` uses — validated caller values for a routine
 * (as given for a plain flow), defaults, and keyring values — plus the names
 * whose value is secret. The browser runner resolves the same things inside
 * the daemon; this is for the paths that never reach it (HTTP replay) and for
 * the link compiler, which needs the values to bind them back.
 */
export function resolveRunValues(flow: Flow, provided: Record<string, unknown>): { values: Record<string, string>; secret: string[] } {
  const values: Record<string, string> = flow.tool
    ? validateRoutineParams(flow, provided)
    : Object.fromEntries(Object.entries(provided).map(([k, v]) => [k, String(v)]));
  const secret = new Set<string>();
  for (const [name, def] of Object.entries(flow.params ?? {})) {
    if (def.from !== undefined) values[name] = fromKeyring(name, def.from);
    else if (values[name] === undefined && def.default !== undefined) values[name] = def.default;
    if (def.secret || def.from !== undefined) secret.add(name);
  }
  for (const [name, value] of Object.entries(values)) {
    if (parseSecretRef(value) !== null) {
      values[name] = fromKeyring(name, value);
      secret.add(name);
    }
  }
  return { values, secret: [...secret] };
}
