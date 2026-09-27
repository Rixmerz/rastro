import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { EngineCore } from '../src/engine/engine.ts';
import { startFixtureServer, type FixtureServer } from './fixtures/server.ts';
import { isRoutine, readRoutine } from '../src/routines/registry.ts';
import { dispatchRoutine, type CallFn } from '../src/routines/dispatch.ts';
import { parseRecipe } from '../src/link/recipe.ts';
import type { RoutineResult } from '../src/routines/result.ts';

let home: string;
let flowsDir: string;
let server: FixtureServer;
let seq = 0;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'rastro-read-'));
  flowsDir = join(home, 'flows');
  mkdirSync(flowsDir, { recursive: true });
  process.env.RASTRO_HOME = home;
  server = await startFixtureServer();
}, 30000);

afterAll(async () => {
  await server.close();
  rmSync(home, { recursive: true, force: true });
});

async function engine(): Promise<EngineCore> {
  seq += 1;
  const e = await EngineCore.create(`read-${seq}`);
  await e.open({ timeoutMs: 3000 });
  return e;
}

test(
  'read returns the text view cannot show, by region and by word',
  async () => {
    const e = await engine();
    try {
      await e.goto({ url: `${server.origin}/mail` });
      const view = await e.view({});
      expect(view.text).not.toContain('Quedo atenta');

      const main = await e.read({});
      expect(main.text).toContain('Hola profe, ¿qué nota me puso en la EV.2?');
      expect(main.text).toContain('· main ·');
      expect(main.text).not.toContain('Capacitación');

      const aside = await e.read({ region: 'aside' });
      expect(aside.text).toContain('Capacitación');
      expect(aside.text).not.toContain('Quedo atenta');

      const found = await e.read({ find: 'saludos' });
      expect(found.text).toContain('Quedo atenta. Saludos, Nicol');

      await expect(e.read({ region: 'dialog' })).rejects.toThrow(/no dialog region/);
      const capped = await e.read({ max: 10 });
      expect(capped.text).toMatch(/more characters cut/);
    } finally {
      await e.shutdown();
    }
  },
  60000,
);

test(
  'a flow reads page text and captures a JSON response as outputs',
  async () => {
    const e = await engine();
    try {
      const file = join(flowsDir, 'leer.yaml');
      writeFileSync(
        file,
        `name: leer
steps:
  - open: ${server.origin}/mail
  - read: { region: main }
    as: cuerpo
  - goto: ${server.origin}/api/me
  - capture: { request: "GET /api/me 2xx", json: user }
    as: quien
`,
      );
      const res = await e.flowRun({ file });
      const data = res.data as { ok: boolean; outputs: Record<string, unknown> };
      expect(data.ok).toBe(true);
      expect(data.outputs['cuerpo']).toContain('Quedo atenta');
      expect(data.outputs['quien']).toBe('demo');
      expect(res.text).toContain('quien:\ndemo');

      writeFileSync(file, `name: leer\nsteps:\n  - open: ${server.origin}/mail\n  - capture: { request: "GET /api/nope 2xx" }\n    as: nada\n`);
      const miss = await e.flowRun({ file });
      expect((miss.data as { ok: boolean }).ok).toBe(false);
      expect(miss.text).toMatch(/capture nada: no GET \/api\/nope 2xx/);
    } finally {
      await e.shutdown();
    }
  },
  60000,
);

test(
  'a capture replays over HTTP with its output; a page read is not linkable',
  async () => {
    const file = join(flowsDir, 'quien-soy.yaml');
    writeFileSync(
      file,
      `name: quien-soy
tool:
  description: Who the site thinks I am
  effect: read
steps:
  - open: ${server.origin}/api/me
  - capture: { request: "GET /api/me 2xx", json: user }
    as: quien
`,
    );
    const e = await engine();
    try {
      const linked = await e.flowLink({ file });
      expect(linked.text).toMatch(/linked 1 requests/);
      const recipe = parseRecipe(readFileSync(join(flowsDir, 'quien-soy.link.yaml'), 'utf8'));
      expect(recipe.outputs).toEqual([{ as: 'quien', request: 'GET /api/me 2xx', json: 'user' }]);

      const readsPage = join(flowsDir, 'lee-pagina.yaml');
      writeFileSync(readsPage, `name: lee-pagina\nsteps:\n  - open: ${server.origin}/mail\n  - read: {}\n    as: texto\n`);
      await expect(e.flowLink({ file: readsPage })).rejects.toThrow(/reads page text/);
    } finally {
      await e.shutdown();
    }

    const entry = readRoutine(file);
    if (!isRoutine(entry)) throw new Error('not a routine');
    const noBrowser: CallFn = () => Promise.reject(new Error('the browser must not be used'));
    const http = await dispatchRoutine(entry, {}, `read-${seq}`, { engine: 'http', callFn: noBrowser, timeoutMs: 1000 });
    const result = http.data as RoutineResult;
    expect(result).toMatchObject({ ok: true, engine: 'http', outputs: { quien: 'demo' } });
    expect(http.text).toContain('quien:\ndemo');
  },
  90000,
);

test(
  'a read routine whose capture fails is safe to retry despite page-script POSTs; a write routine is not',
  async () => {
    const make = (name: string, effect: string): string => {
      const file = join(flowsDir, `${name}.yaml`);
      writeFileSync(
        file,
        `name: ${name}
tool:
  description: Reads a value that never comes
  effect: ${effect}
  allowWrite: [127.0.0.1]
steps:
  - open: ${server.origin}/chatty
  - capture: { request: "GET /api/nope 2xx" }
    as: nada
`,
      );
      return file;
    };
    const e = await engine();
    try {
      const read = (await e.routineRun({ file: make('lee-chatty', 'read') })).data as RoutineResult;
      expect(read.ok).toBe(false);
      expect(read.writes.some((w) => w.xhr === true)).toBe(true);
      expect(read.retrySafe).toBe(true);

      const write = (await e.routineRun({ file: make('escribe-chatty', 'write') })).data as RoutineResult;
      expect(write.retrySafe).toBe(false);
    } finally {
      await e.shutdown();
    }
  },
  90000,
);
