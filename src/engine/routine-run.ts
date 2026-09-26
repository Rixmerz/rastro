// Runs a routine in the browser, inside the daemon: the routine's write and
// upload allowlists applied for the run only, one login refresh when a step
// fails on a login page and nothing has been written yet, and a structured
// result that says whether a retry is safe. Lives in the daemon because only
// the daemon can scope the session's lists and knows which requests the run
// sent.

import { readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { RastroError } from '../core/types.ts';
import { resolveFlowRef } from '../core/paths.ts';
import { navigationHosts, parseFlow, type Flow } from '../flow/format.ts';
import { evaluateCondition, runFlow, type RunFlowResult } from '../flow/runner.ts';
import { validateRoutineParams } from '../routines/params.ts';
import { contentHash, isVerified, markVerified, recordRun } from '../routines/state.ts';
import { bareOf, isWriteMethod, type RoutineResult, type WriteRecord } from '../routines/result.ts';
import { recipeFileHosts, recipePathFor } from '../link/recipe.ts';
import type { EngineCore } from './engine.ts';

function expandHome(path: string): string {
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

/** A `login:` reference: a sibling of the routine first, then the usual lookup. */
function resolveLoginFile(ref: string, routineFile: string): string {
  if (!ref.includes('/') && !/\.ya?ml$/i.test(ref)) {
    const sibling = join(dirname(routineFile), `${ref}.yaml`);
    if (existsSync(sibling)) return sibling;
  }
  return resolveFlowRef(ref);
}

/**
 * Every write the run sent, by time rather than by attribution: a POST that
 * lands after an action's quiet window is left unattributed, and missing it
 * here would tell the caller a retry is safe when it is not. Background
 * traffic (beacons, polling) and writes the guard blocked never count.
 */
function writesOf(core: EngineCore, firstAction: number): WriteRecord[] {
  const start = core.store.actions({ from: firstAction, limit: 1 })[0]?.t0;
  if (start === undefined) return [];
  const writes: WriteRecord[] = [];
  for (const req of core.store.requests({ since: start })) {
    if (!isWriteMethod(req.method) || req.redirectedFrom !== undefined || req.bucket === 'background') continue;
    if (req.failed !== undefined && /BLOCKED_BY_CLIENT/i.test(req.failed)) continue;
    const write: WriteRecord = { method: req.method.toUpperCase(), path: bareOf(req.url) };
    if (req.resourceType !== 'document') write.xhr = true;
    if (req.status !== undefined) write.status = req.status;
    const location = req.responseHeaders?.['location'] ?? req.responseHeaders?.['Location'];
    if (location) write.location = new URL(location, req.url).href;
    writes.push(write);
  }
  return writes;
}

function nextActionId(core: EngineCore): number {
  return (core.store.lastAction()?.id ?? 0) + 1;
}

function currentUrl(core: EngineCore): string | undefined {
  try {
    return core.session?.activePage().url();
  } catch {
    return undefined;
  }
}

export interface RoutineRunInput {
  file: string;
  params?: Record<string, unknown>;
}

export async function runRoutineInBrowser(core: EngineCore, input: RoutineRunInput): Promise<RoutineResult> {
  const text = readFileSync(input.file, 'utf8');
  const hash = contentHash(text);
  const flow: Flow = parseFlow(text);
  const name = basename(input.file).replace(/\.ya?ml$/i, '');
  if (!flow.tool) throw new RastroError(`${name} is a flow, not a routine`, 'add a tool: block to expose it');
  const tool = flow.tool;
  const values = validateRoutineParams(flow, input.params);

  const allowWrite = tool.allowWrite ?? navigationHosts(flow.steps, values);
  const allowUpload = (tool.allowUpload ?? []).map((d) => resolve(expandHome(d)));

  // Scope the lists to this run. `open` on a live session *replaces* them,
  // so the previous ones are saved and put back whatever happens.
  const hadSession = core.session !== undefined;
  const previous = hadSession
    ? { allowWrite: [...core.session!.allowWrite], allowUpload: core.session!.uploadDirs.slice(1) }
    : { allowWrite: [] as string[], allowUpload: [] as string[] };
  await core.open({ allowWrite, allowUpload });

  const firstAction = nextActionId(core);
  let attemptFirst = firstAction;
  let loginRefreshed = false;
  let run: RunFlowResult;
  try {
    run = await runFlow({ core }, flow, { params: values });

    if (!run.ok && tool.login !== undefined && tool.loginWhen !== undefined && writesOf(core, firstAction).length === 0) {
      if (await evaluateCondition(core, tool.loginWhen, [])) {
        const loginFlow = parseFlow(readFileSync(resolveLoginFile(tool.login, input.file), 'utf8'));
        // The login form usually posts to its own host (an SSO one, often), so
        // widen the list for the login run by that flow's own hosts.
        const loginHosts = loginFlow.tool?.allowWrite ?? navigationHosts(loginFlow.steps, {});
        core.session?.applyOptions({ allowWrite: [...new Set([...allowWrite, ...loginHosts])] });
        const login = await runFlow({ core }, loginFlow, {});
        core.session?.applyOptions({ allowWrite });
        if (!login.ok) {
          run = { ...run, reason: `login flow ${tool.login} failed: ${login.reason ?? 'unknown error'}` };
        } else {
          loginRefreshed = true;
          attemptFirst = nextActionId(core);
          run = await runFlow({ core }, flow, { params: values });
        }
      }
    }
  } finally {
    core.session?.applyOptions(previous);
  }

  const lastAction = core.store.lastAction()?.id ?? 0;
  const writes = writesOf(core, firstAction);
  if (run.ok) {
    markVerified(hash, input.file);
    // A good browser run refreshes the jar the HTTP replay of this flow uses.
    const recipeFile = recipePathFor(input.file);
    if (existsSync(recipeFile)) await core.exportCookieJar(recipeFileHosts(recipeFile));
  }

  const result: RoutineResult = {
    routine: name,
    ok: run.ok,
    engine: 'browser',
    stepsRun: run.stepsRun,
    writes,
    verified: run.ok || isVerified(hash),
  };
  const finalUrl = currentUrl(core);
  if (finalUrl) result.finalUrl = finalUrl;
  if (lastAction >= firstAction) result.actions = { first: firstAction, last: lastAction };
  if (loginRefreshed) {
    result.loginRefreshed = true;
    if (lastAction >= attemptFirst) result.attemptActions = { first: attemptFirst, last: lastAction };
  }
  if (!run.ok) {
    const match = /^step (\S+) failed: ([\s\S]*)$/.exec(run.reason ?? '');
    if (match) {
      result.failedStep = match[1]!;
      result.reason = match[2]!;
    } else {
      result.reason = run.reason ?? 'unknown error';
    }
    result.retrySafe = writes.length === 0;
  }

  recordRun(name, { at: new Date().toISOString(), ok: run.ok, engine: 'browser', hash, ...(run.ok ? {} : { reason: result.reason ?? '' }) });
  return result;
}
