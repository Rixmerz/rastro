import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { EngineCore } from '../src/engine/engine.ts';
import { startFixtureServer, type FixtureServer } from './fixtures/server.ts';
import { contentHash } from '../src/routines/state.ts';
import type { RoutineResult } from '../src/routines/result.ts';

let home: string;
let flowsDir: string;
let server: FixtureServer;
let seq = 0;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'rastro-routine-engine-'));
  flowsDir = join(home, 'flows');
  mkdirSync(flowsDir, { recursive: true });
  process.env.RASTRO_HOME = home;
  server = await startFixtureServer();
}, 30000);

afterAll(async () => {
  await server.close();
  rmSync(home, { recursive: true, force: true });
});

function writeLoginFlow(): void {
  writeFileSync(
    join(flowsDir, 'rt-login.yaml'),
    `name: rt-login
steps:
  - open: ${server.origin}/rt/login
  - click: { role: button, name: Entrar }
    expect: { url: /rt/form }
`,
  );
}

function writeRoutine(name: string, extraSteps: string, loginWhen: string): { file: string; text: string } {
  const text = `name: ${name}
tool:
  description: Add a note
  effect: write
  allowWrite: [127.0.0.1]
  login: rt-login
  loginWhen: { url: "${loginWhen}" }
params:
  title: { type: string, description: the note title }
steps:
  - open: ${server.origin}/rt/form
  - fill: { role: textbox, name: Título }
    value: "{{title}}"
  - click: { role: button, name: Guardar }
    expect: { url: /rt/notes/* }
${extraSteps}`;
  const file = join(flowsDir, `${name}.yaml`);
  writeFileSync(file, text);
  return { file, text };
}

async function freshEngine(): Promise<EngineCore> {
  seq += 1;
  const engine = await EngineCore.create(`routine-${seq}`);
  // A narrow allowlist of the caller's own, which the run must restore; and a
  // short timeout so the step that hits the login page fails fast.
  await engine.open({ allowWrite: ['a.example'], timeoutMs: 3000 });
  return engine;
}

test(
  'an expired login is refreshed once, the note is written, and the session lists come back',
  async () => {
    writeLoginFlow();
    const { file, text } = writeRoutine('add-note', '', '/rt/login');
    const engine = await freshEngine();
    try {
      const before = server.notes().length;
      const res = await engine.routineRun({ file, params: { title: 'Primera' } });
      const result = res.data as RoutineResult;

      expect(result.ok).toBe(true);
      expect(result.loginRefreshed).toBe(true);
      expect(server.notes().slice(before)).toEqual([{ id: before + 1, title: 'Primera' }]);
      expect(result.writes).toContainEqual({
        method: 'POST',
        path: '/rt/note',
        status: 303,
        location: `${server.origin}/rt/notes/${before + 1}`,
      });
      expect(result.finalUrl).toBe(`${server.origin}/rt/notes/${before + 1}`);
      expect(res.text).toContain('login refreshed and retried once');

      expect(engine.session!.allowWrite).toEqual(['a.example']);
      expect(existsSync(join(home, 'routines', 'verified', contentHash(text)))).toBe(true);
    } finally {
      await engine.shutdown();
    }
  },
  90000,
);

test(
  'a failure after a write is never retried, even on a page that looks like a login',
  async () => {
    writeLoginFlow();
    // loginWhen matches the page the failure lands on, so only the
    // "no retry after a write" rule stands between this and a duplicate note.
    const { file } = writeRoutine('add-note-broken', '  - click: { role: button, name: Inexistente }\n', '/rt/notes/*');
    const engine = await freshEngine();
    try {
      // Log in first, so the write happens in the first attempt. The write
      // guard would block this post under the caller's own list, so widen it
      // for the login and put it back.
      await engine.open({ allowWrite: ['a.example', '127.0.0.1'] });
      await engine.goto({ url: `${server.origin}/rt/login` });
      const page = engine.session!.activePage();
      await page.getByRole('button', { name: 'Entrar' }).click();
      await page.waitForURL(/\/rt\/form$/);
      await engine.open({ allowWrite: ['a.example'] });

      const before = server.notes().length;
      const res = await engine.routineRun({ file, params: { title: 'Una sola' } });
      const result = res.data as RoutineResult;

      expect(result.ok).toBe(false);
      expect(result.failedStep).toBe('4');
      expect(result.retrySafe).toBe(false);
      expect(result.loginRefreshed).toBeUndefined();
      expect(server.notes().length).toBe(before + 1);
      expect(res.text).toContain('do NOT retry');
      expect(engine.session!.allowWrite).toEqual(['a.example']);
    } finally {
      await engine.shutdown();
    }
  },
  90000,
);

test(
  'an invalid param is refused before the first step',
  async () => {
    const { file } = writeRoutine('add-note-params', '', '/rt/login');
    const engine = await freshEngine();
    try {
      server.resetHits();
      await expect(engine.routineRun({ file, params: { title: 'x', extra: 'y' } })).rejects.toThrow(/unknown param extra/);
      expect(server.hits().filter((h) => h.path.startsWith('/rt/'))).toEqual([]);
    } finally {
      await engine.shutdown();
    }
  },
  60000,
);

test(
  'a multipart form posted into an iframe keeps its body in the trace',
  async () => {
    seq += 1;
    const engine = await EngineCore.create(`routine-${seq}`);
    try {
      await engine.open({ url: `${server.origin}/iframe-upload`, allowWrite: ['127.0.0.1'] });
      const file = join(home, 'sample.txt');
      writeFileSync(file, 'contenido\n');
      const page = engine.session!.activePage();
      await page.setInputFiles('#f', file);
      await page.click('#b');
      const start = Date.now();
      let body: string | undefined;
      while (body === undefined && Date.now() - start < 10000) {
        body = engine.store.requests({}).find((r) => r.method === 'POST' && r.url.endsWith('/iframe-upload'))?.postData;
        if (body === undefined) await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(body).toContain('name="title"');
      expect(body).toContain('filename="sample.txt"');
    } finally {
      await engine.shutdown();
    }
  },
  60000,
);
