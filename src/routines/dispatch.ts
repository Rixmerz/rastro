// Picks the engine a routine runs on and runs it. `browser` goes through the
// daemon (`routineRun`). `http` replays the routine's recipe in this process,
// with no daemon and no Chromium. `auto` uses the recipe only when it is fresh
// and verified, and gives way to the browser only while no write has been
// sent — after a write, a second attempt could duplicate it.

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { RastroError } from '../core/types.ts';
import type { RpcMethod, RpcResult } from '../core/types.ts';
import { ensurePrivateDir, sessionPaths } from '../core/paths.ts';
import { navigationHosts } from '../flow/format.ts';
import { CookieJar } from '../link/jar.ts';
import { isWriteRequest, type Recipe } from '../link/recipe.ts';
import { runRecipe } from '../link/run.ts';
import { SecretRegistry } from '../security/redact.ts';
import { assertInsideDirs } from '../security/sandbox.ts';
import { resolveRunValues } from './params.ts';
import type { Routine } from './registry.ts';
import { formatRoutineResult, type RoutineResult } from './result.ts';
import { markVerified, recordRun } from './state.ts';

export type EngineChoice = 'auto' | 'browser' | 'http';

export type CallFn = (
  session: string,
  method: RpcMethod,
  params: Record<string, unknown>,
  opts?: { timeoutMs?: number },
) => Promise<RpcResult>;

export interface DispatchOptions {
  engine: EngineChoice;
  callFn: CallFn;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

function expandHome(path: string): string {
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}

/** A recipe is replayed under the same write allowlist as the browser run:
 * a hand-edited recipe must not reach a host the routine never declared. */
function assertRecipeHosts(recipe: Recipe, allowed: string[]): void {
  for (const req of recipe.requests) {
    if (!isWriteRequest(req)) continue;
    let host: string;
    try {
      host = new URL(req.url.replace(/\{\{[^}]*\}\}/g, 'x')).hostname;
    } catch {
      throw new RastroError(`recipe request ${req.id} has no readable host`);
    }
    const ok = allowed.includes('*') || allowed.some((h) => host === h || host.endsWith(`.${h}`));
    if (!ok) throw new RastroError(`recipe request ${req.id} writes to ${host}, outside the routine's allowWrite`, 'add the host to tool.allowWrite or fix the recipe');
  }
}

async function runOverHttp(routine: Routine, params: Record<string, unknown>, session: string, fetchImpl?: typeof fetch): Promise<RoutineResult> {
  const link = routine.link!;
  const recipe = link.recipe!;
  const { values, secret } = resolveRunValues(routine.flow, params);
  assertRecipeHosts(recipe, routine.tool.allowWrite ?? navigationHosts(routine.flow.steps, values));

  const paths = sessionPaths(session);
  ensurePrivateDir(paths.root);
  const jar = CookieJar.load(paths.cookies);
  const uploadDirs = [paths.uploads, ...(routine.tool.allowUpload ?? []).map((d) => resolve(expandHome(d)))];

  const http = await runRecipe(recipe, {
    params: values,
    jar,
    assertUploadAllowed: (p) => assertInsideDirs(p, uploadDirs),
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  jar.save(paths.cookies);
  if (http.ok) markVerified(link.hash!, link.file, 'verified-links');

  const result: RoutineResult = {
    routine: routine.name,
    ok: http.ok,
    engine: 'http',
    stepsRun: http.requestsSent,
    writes: http.writes,
    verified: routine.verified,
  };
  if (http.finalUrl) result.finalUrl = http.finalUrl;
  if (!http.ok) {
    if (http.failedRequest) result.failedStep = http.failedRequest;
    result.reason = http.reason ?? 'unknown error';
    result.retrySafe = http.beforeWrite === true || (routine.tool.effect === 'read' && http.writes.every((w) => w.xhr === true));
  }

  // Nothing a replay prints may carry a secret the routine resolved.
  const registry = new SecretRegistry();
  for (const name of secret) registry.add(values[name]!);
  if (http.outputs) result.outputs = JSON.parse(registry.mask(JSON.stringify(http.outputs))) as Record<string, unknown>;
  if (result.reason) result.reason = registry.mask(result.reason);
  if (result.finalUrl) result.finalUrl = registry.mask(result.finalUrl);

  recordRun(routine.name, { at: new Date().toISOString(), ok: http.ok, engine: 'http', hash: link.hash!, ...(http.ok ? {} : { reason: result.reason ?? '' }) });
  return result;
}

function asRpc(result: RoutineResult): RpcResult {
  return { text: formatRoutineResult(result), data: result };
}

export async function dispatchRoutine(
  routine: Routine,
  params: Record<string, unknown>,
  session: string,
  opts: DispatchOptions,
): Promise<RpcResult> {
  const link = routine.link;
  const usable = link?.state === 'fresh' && link.recipe !== undefined;

  if (opts.engine === 'http') {
    if (!usable) {
      const why = !link ? 'this routine has no recipe' : link.state === 'stale' ? 'its recipe is stale' : `its recipe is invalid: ${link.error ?? ''}`;
      throw new RastroError(`cannot run ${routine.name} over http: ${why}`, `rastro flow link ${routine.name}`);
    }
    return asRpc(await runOverHttp(routine, params, session, opts.fetchImpl));
  }

  let fellBack: string | undefined;
  if (opts.engine === 'auto' && usable && link.verified) {
    const http = await runOverHttp(routine, params, session, opts.fetchImpl);
    if (http.ok || !http.retrySafe) return asRpc(http);
    fellBack = http.reason ?? 'unknown error';
  }

  const browser = await opts.callFn(session, 'routineRun', { file: routine.file, params }, { timeoutMs: opts.timeoutMs });
  if (fellBack === undefined) return browser;
  const data = browser.data as RoutineResult | null;
  if (!data) return browser;
  return asRpc({ ...data, fellBack });
}
