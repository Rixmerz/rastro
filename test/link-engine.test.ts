import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { EngineCore } from '../src/engine/engine.ts';
import { startFixtureServer, type FixtureServer } from './fixtures/server.ts';
import { isRoutine, readRoutine, type Routine } from '../src/routines/registry.ts';
import { dispatchRoutine, type CallFn } from '../src/routines/dispatch.ts';
import { parseRecipe } from '../src/link/recipe.ts';
import type { RoutineResult } from '../src/routines/result.ts';
import { sessionPaths } from '../src/core/paths.ts';

let home: string;
let flowsDir: string;
let server: FixtureServer;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'rastro-link-engine-'));
  flowsDir = join(home, 'flows');
  mkdirSync(flowsDir, { recursive: true });
  process.env.RASTRO_HOME = home;
  server = await startFixtureServer();
}, 30000);

afterAll(async () => {
  await server.close();
  rmSync(home, { recursive: true, force: true });
});

function routine(file: string): Routine {
  const entry = readRoutine(file);
  if (!isRoutine(entry)) throw new Error(`not a routine: ${file}`);
  return entry;
}

const noBrowser: CallFn = () => Promise.reject(new Error('the browser must not be used here'));

test(
  'a linked routine replays over http with a fresh token, and falls back only before a write',
  async () => {
    writeFileSync(
      join(flowsDir, 'rt-login.yaml'),
      `name: rt-login
steps:
  - open: ${server.origin}/rt/login
  - click: { role: button, name: Entrar }
    expect: { url: /rt/form }
`,
    );
    const file = join(flowsDir, 'add-note.yaml');
    writeFileSync(
      file,
      `name: add-note
tool:
  description: Add a note
  effect: write
  allowWrite: [127.0.0.1]
  login: rt-login
  loginWhen: { url: /rt/login }
params:
  title: { type: string, description: the note title }
steps:
  - open: ${server.origin}/rt/form
  - fill: { role: textbox, name: Título }
    value: "{{title}}"
  - click: { role: button, name: Guardar }
    expect: { url: /rt/notes/* }
`,
    );

    const session = 'link-1';
    const engine = await EngineCore.create(session);
    try {
      await engine.open({ timeoutMs: 3000 });
      // Starts logged out: the link run refreshes the login and must compile
      // only the attempt that worked.
      const linked = await engine.flowLink({ file, params: { title: 'Primera' } });
      expect(linked.text).toMatch(/linked 2 requests \(1 writes\)/);
      expect(linked.text).toContain('extracted per run: csrf');
    } finally {
      await engine.shutdown();
    }

    const recipeFile = join(flowsDir, 'add-note.link.yaml');
    const recipeText = readFileSync(recipeFile, 'utf8');
    const recipe = parseRecipe(recipeText);
    expect(recipe.requests.map((r) => `${r.method} ${new URL(r.url).pathname} ${r.expect}`)).toEqual(['GET /rt/form 2xx', 'POST /rt/note 3xx']);
    expect(recipe.requests[0]!.extract).toEqual({ csrf: { input: 'csrf' } });
    expect(recipe.requests[1]!.form).toEqual([
      { name: 'csrf', value: '{{csrf}}' },
      { name: 'title', value: '{{title}}' },
    ]);
    expect(recipeText).not.toContain('rt_auth');
    expect(statSync(recipeFile).mode & 0o777).toBe(0o600);
    const jarFile = sessionPaths(session).cookies;
    expect(statSync(jarFile).mode & 0o777).toBe(0o600);

    // Unverified recipe: auto still goes to the browser.
    const browserCalls: string[] = [];
    const fakeBrowser: CallFn = (_s, method) => {
      browserCalls.push(method);
      return Promise.resolve({ text: 'browser ran', data: { routine: 'add-note', ok: true, engine: 'browser', stepsRun: 3, writes: [], verified: true } });
    };
    await dispatchRoutine(routine(file), { title: 'x' }, session, { engine: 'auto', callFn: fakeBrowser, timeoutMs: 1000 });
    expect(browserCalls).toEqual(['routineRun']);

    // Explicit http: no browser, a new title, the server's fresh CSRF accepted.
    const before = server.notes().length;
    const http = await dispatchRoutine(routine(file), { title: 'Segunda' }, session, { engine: 'http', callFn: noBrowser, timeoutMs: 1000 });
    const result = http.data as RoutineResult;
    expect(result).toMatchObject({ ok: true, engine: 'http', stepsRun: 2 });
    expect(server.notes().slice(before)).toEqual([{ id: before + 1, title: 'Segunda' }]);
    expect(http.text).toContain('add-note ok · 2 steps · http');
    expect(routine(file).link).toMatchObject({ state: 'fresh', verified: true });

    // Verified: auto now replays over http on its own.
    const auto = await dispatchRoutine(routine(file), { title: 'Tercera' }, session, { engine: 'auto', callFn: noBrowser, timeoutMs: 1000 });
    expect((auto.data as RoutineResult).engine).toBe('http');
    expect(server.notes().at(-1)).toMatchObject({ title: 'Tercera' });

    // Session gone: the first GET is redirected to the login page, before any
    // write, so auto gives way to the browser and says why.
    writeFileSync(jarFile, '[]', { mode: 0o600 });
    browserCalls.length = 0;
    const count = server.notes().length;
    const fallback = await dispatchRoutine(routine(file), { title: 'Cuarta' }, session, { engine: 'auto', callFn: fakeBrowser, timeoutMs: 1000 });
    expect(browserCalls).toEqual(['routineRun']);
    expect((fallback.data as RoutineResult).fellBack).toMatch(/answered 302 → \/rt\/login where 2xx was recorded/);
    expect(fallback.text).toContain('gave way to the browser before any write');
    expect(server.notes().length).toBe(count);

    // Editing the flow stales the recipe: http refuses, auto uses the browser.
    writeFileSync(file, `${readFileSync(file, 'utf8')}  - wait: { ms: 1 }\n`);
    expect(routine(file).link?.state).toBe('stale');
    await expect(dispatchRoutine(routine(file), { title: 'x' }, session, { engine: 'http', callFn: noBrowser, timeoutMs: 1000 })).rejects.toThrow(/recipe is stale/);
    expect(existsSync(recipeFile)).toBe(true);
  },
  120000,
);
