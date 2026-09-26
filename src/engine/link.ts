// `flow link`: runs a flow in the browser (or takes an earlier run by action
// range) and compiles the requests it caused into an HTTP recipe next to the
// flow. Runs in the daemon, the only place that holds the raw trace and the
// secret registry the credential check needs.

import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { RequestRecord, RpcResult } from '../core/types.ts';
import { RastroError } from '../core/types.ts';
import { parseFlow, stepKind, type FlowStep } from '../flow/format.ts';
import { runFlow } from '../flow/runner.ts';
import { compileRecipe, NotLinkable } from '../link/compile.ts';
import { recipeHosts, recipePathFor, stringifyRecipe } from '../link/recipe.ts';
import { resolveRunValues } from '../routines/params.ts';
import { contentHash } from '../routines/state.ts';
import type { EngineCore } from './engine.ts';
import { runRoutineInBrowser } from './routine-run.ts';

export interface FlowLinkInput {
  file: string;
  params?: Record<string, unknown> | undefined;
  from?: number | undefined;
  to?: number | undefined;
}

function uploadParams(steps: FlowStep[], values: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const step of steps) {
    const raw = step as unknown as Record<string, unknown>;
    const kind = stepKind(step);
    if (kind === 'upload') {
      const param = /^\{\{\s*([A-Za-z0-9_]+)\s*\}\}$/.exec(raw['value'] as string)?.[1];
      if (param && values[param]) out[basename(values[param])] = param;
    } else if (kind === 'if') {
      Object.assign(out, uploadParams(raw['then'] as FlowStep[], values), uploadParams((raw['else'] as FlowStep[] | undefined) ?? [], values));
    }
  }
  return out;
}

function expectedRequests(steps: FlowStep[]): string[] {
  const out: string[] = [];
  for (const step of steps) {
    const raw = step as unknown as Record<string, unknown>;
    out.push(...(((raw['expect'] as { requests?: string[] } | undefined)?.requests) ?? []));
    if (stepKind(step) === 'if') {
      out.push(...expectedRequests(raw['then'] as FlowStep[]), ...expectedRequests((raw['else'] as FlowStep[] | undefined) ?? []));
    }
  }
  return out;
}

export async function linkFlow(core: EngineCore, input: FlowLinkInput): Promise<RpcResult> {
  const text = readFileSync(input.file, 'utf8');
  const flow = parseFlow(text);
  const provided = input.params ?? {};
  const { values, secret } = resolveRunValues(flow, provided);

  let first: number;
  let last: number;
  if (input.from !== undefined) {
    first = input.from;
    last = input.to ?? core.store.lastAction()?.id ?? input.from;
  } else if (flow.tool) {
    const result = await runRoutineInBrowser(core, { file: input.file, params: provided });
    if (!result.ok || !result.actions) {
      throw new RastroError(`the run failed, nothing was linked: ${result.reason ?? 'unknown error'}`, 'fix the flow, or link an earlier good run with --from/--to');
    }
    ({ first, last } = result.attemptActions ?? result.actions);
  } else {
    first = (core.store.lastAction()?.id ?? 0) + 1;
    const result = await runFlow({ core }, flow, { params: Object.fromEntries(Object.entries(provided).map(([k, v]) => [k, String(v)])) });
    if (!result.ok) throw new RastroError(`the run failed, nothing was linked: ${result.reason ?? 'unknown error'}`);
    last = core.store.lastAction()?.id ?? first;
  }

  // By time window, not attribution: on a real site the one request that
  // matters can land unattributed (Moodle's file upload did, inside the very
  // click that sent it), and a recipe without it replays a form with no file.
  // Only traffic already classified as background stays out.
  const actions = core.store.actions({ from: first, to: last });
  const start = actions[0]?.t0;
  if (start === undefined) throw new RastroError(`no actions #${first}-#${last} in this session`, 'check rastro history for the run to link');
  const end = actions.at(-1)!.t1 ?? Number.MAX_SAFE_INTEGER;
  const requests: RequestRecord[] = core.store.requests({ since: start, until: end }).filter((r) => r.bucket !== 'background');
  for (const name of secret) core.secrets.add(values[name]!);

  const cookies = core.session ? (await core.session.context.cookies()).map((c) => ({ name: c.name, value: c.value })) : [];
  const callerParams = Object.entries(flow.params ?? {})
    .filter(([, def]) => def.from === undefined)
    .map(([name]) => name);

  let recipe;
  try {
    recipe = compileRecipe({
      flow: basename(input.file).replace(/\.ya?ml$/i, ''),
      flowHash: contentHash(text),
      requests,
      body: (r) => (r.bodyHash ? (core.readBody(r.bodyHash)?.toString('utf8') ?? null) : null),
      params: values,
      callerParams,
      secretParams: secret,
      uploads: uploadParams(flow.steps, values),
      cookies,
      containsSecret: (t) => core.secrets.mask(t) !== t,
      expected: expectedRequests(flow.steps),
    });
  } catch (err) {
    if (err instanceof NotLinkable) throw new RastroError(`not linkable: ${err.message}`, 'the flow keeps running in the browser');
    throw err;
  }

  const out = recipePathFor(input.file);
  writeFileSync(out, stringifyRecipe(recipe), { mode: 0o600 });
  await core.exportCookieJar(recipeHosts(recipe));

  const writes = recipe.requests.filter((r) => !['GET', 'HEAD', 'OPTIONS'].includes(r.method)).length;
  const extracted = recipe.requests.flatMap((r) => Object.keys(r.extract ?? {}));
  const lines = [
    `linked ${recipe.requests.length} requests (${writes} writes) from actions #${first}-#${last}`,
    extracted.length > 0 ? `extracted per run: ${extracted.join(', ')}` : 'nothing extracted per run',
    ...(recipe.warnings ?? []).map((w) => `warning: ${w}`),
    `saved to ${out}`,
    `unverified until one http run succeeds: rastro routine run ${recipe.flow} --engine http`,
  ];
  return { text: lines.join('\n'), data: { file: out, requests: recipe.requests.length, writes, extracted, warnings: recipe.warnings ?? [] }, files: [out] };
}
