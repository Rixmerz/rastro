import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { secretRemove, secretSet } from '../src/security/vault.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createEngine, EngineCore } from '../src/engine/engine.ts';
import { startFixtureServer } from './fixtures/server.ts';
import type { FixtureServer } from './fixtures/server.ts';
import { parseFlow, stringifyFlow, type Flow } from '../src/flow/format.ts';

let home: string;
let flowsDir: string;
let server: FixtureServer;
let sessionSeq = 0;
let flowSeq = 0;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'rastro-flows-'));
  flowsDir = join(home, 'flows');
  mkdirSync(flowsDir, { recursive: true });
  process.env.RASTRO_HOME = home;
  // No display in this environment (and injecting input into a live desktop
  // session is off-limits here regardless): force recordStart's browser
  // headless so it can actually launch.
  process.env.RASTRO_RECORD_HEADLESS = '1';
  server = await startFixtureServer();
}, 30000);

afterAll(async () => {
  await server.close();
  rmSync(home, { recursive: true, force: true });
});

function nextSession(prefix: string): string {
  sessionSeq += 1;
  return `${prefix}-${sessionSeq}`;
}

function flowPath(prefix: string): string {
  flowSeq += 1;
  return join(flowsDir, `${prefix}-${flowSeq}.yaml`);
}

function writeFlow(prefix: string, flow: Flow): string {
  const file = flowPath(prefix);
  writeFileSync(file, stringifyFlow(flow));
  return file;
}

/** Waits for the Nth action to exist *and* be finished (`t1` set): a fresh
 * action row appears the instant `runAction` starts it, well before its
 * quiet-wait settles, so counting rows alone would let a fast synthetic
 * driver fire the next DOM event while the previous action is still open. */
async function waitForActionCount(
  engine: { history(p: Record<string, unknown>): Promise<{ data: unknown }> },
  n: number,
  timeoutMs = 15000,
): Promise<void> {
  const start = Date.now();
  for (;;) {
    const actions = (await engine.history({})).data as { t1?: number; error?: string }[];
    const nth = actions[n - 1];
    if (nth && (nth.t1 !== undefined || nth.error !== undefined)) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting for ${n} actions, got ${actions.length}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

// ---------------------------------------------------------------------------
// Human capture: recordStart/recordStop driven by Playwright's own page API
// (never real input injection) on the session's live page.
// ---------------------------------------------------------------------------

describe('human capture', () => {
  test(
    'records fill/select/check/click as human actions without leaking the password',
    async () => {
      const engine = await EngineCore.create(nextSession('capture'));
      // Under a directory that does not exist yet: the flow home is created on
      // first save, and `rastro flow save <name>` on a fresh machine would
      // otherwise fail with ENOENT.
      const savePath = join(home, 'fresh-flow-home', 'captured.yaml');
      try {
        await engine.recordStart({ url: `${server.origin}/record` });
        const page = engine.session!.activePage();

        // Each capture event goes through the full action pipeline (its own
        // quiet-wait) before the next one's window opens, exactly like two
        // real human gestures never overlap; wait for each to be recorded
        // before driving the next one so a fast synthetic driver doesn't
        // fire the next DOM event inside the previous action's window.
        //
        // `fill()` only dispatches `input`, not `change` (a real user fires
        // `change` by moving focus away); `.blur()` reproduces that.
        await page.fill('input[name="nombre"]', 'Ana');
        await page.locator('input[name="nombre"]').blur();
        await waitForActionCount(engine, 2);
        await page.fill('input[name="clave"]', 'hunter2');
        await page.locator('input[name="clave"]').blur();
        await waitForActionCount(engine, 3);
        await page.selectOption('select[name="pais"]', { label: 'AR' });
        await waitForActionCount(engine, 4);
        await page.check('input[name="acepto"]');
        await waitForActionCount(engine, 5);
        await page.click('[data-testid="guardar"]');
        await page.waitForURL('**/record/done');

        // 1 (initial open) + 5 human actions.
        await waitForActionCount(engine, 6);

        const stopRes = await engine.recordStop({ save: savePath });
        // The initial navigation counts as the first recorded action, plus
        // the 5 human ones.
        expect(stopRes.text).toContain('recorded 6 steps');
        expect(stopRes.text).toContain(`saved to ${savePath}`);

        const historyRes = await engine.history({});
        expect(historyRes.text).toContain('[human] fill «Nombre»');
        expect(historyRes.text).toContain('[human] fill «Clave»');
        expect(historyRes.text).toContain('•••');
        expect(historyRes.text).not.toContain('hunter2');
        expect(historyRes.text).toContain('[human] select «País»');
        expect(historyRes.text).toContain('[human] check «Acepto»');
        expect(historyRes.text).toContain('[human] click «Guardar»');

        const savedYaml = readFileSync(savePath, 'utf8');
        expect(savedYaml).not.toContain('hunter2');

        const flow = parseFlow(savedYaml);
        expect(flow.steps).toHaveLength(6);
        const clickStep = flow.steps[flow.steps.length - 1] as unknown as {
          click: unknown;
          expect?: { url?: string; requests?: string[] };
        };
        expect(clickStep.expect?.url).toBe('/record/done');
        expect(clickStep.expect?.requests).toContain('POST /api/save 2xx');
      } finally {
        await engine.shutdown();
      }

      // Run the captured flow in a fresh session, supplying the secret param.
      const replay = await createEngine(nextSession('replay'));
      try {
        const result = await replay.flowRun({ file: savePath, params: { clave: 'hunter2' } });
        const data = result.data as { ok: boolean; lines: string[] };
        expect(data.ok, data.lines.join('\n')).toBe(true);
      } finally {
        await replay.shutdown();
      }
    },
    30000,
  );
});

// ---------------------------------------------------------------------------
// R4: a fast fill-then-click overlaps two human windows; the click's own
// effects must land on the click step, not the fill it followed.
// ---------------------------------------------------------------------------

describe('human capture: overlapping fast gestures (R4)', () => {
  test(
    'fill, fill, blur, click without waiting attributes the POST and navigation to the click',
    async () => {
      const engine = await EngineCore.create(nextSession('overlap'));
      const savePath = join(home, 'overlap.yaml');
      try {
        await engine.recordStart({ url: `${server.origin}/record` });
        const page = engine.session!.activePage();

        // No waits between these: the fill's own quiet-wait (up to 5s) is
        // still running its internal poll when the clave field's change and
        // the click's DOM notifications arrive, exactly the overlap a fast
        // real human gesture produces.
        await page.fill('input[name="nombre"]', 'Ana');
        await page.fill('input[name="clave"]', 'hunter2');
        await page.locator('input[name="clave"]').blur();
        await page.click('[data-testid="guardar"]');
        await page.waitForURL('**/record/done');

        // 1 (initial open) + fill nombre + fill clave + click.
        await waitForActionCount(engine, 4);

        const stopRes = await engine.recordStop({ save: savePath });
        expect(stopRes.text).toContain('recorded 4 steps');

        const flow = parseFlow(readFileSync(savePath, 'utf8'));
        const clickStep = flow.steps[flow.steps.length - 1] as unknown as {
          click: unknown;
          expect?: { url?: string; requests?: string[] };
        };
        expect(clickStep.expect?.url).toBe('/record/done');
        expect(clickStep.expect?.requests).toContain('POST /api/save 2xx');

        // Neither fill step should have inherited the click's effects.
        const fillSteps = flow.steps.filter(
          (s) => 'fill' in (s as unknown as Record<string, unknown>),
        ) as unknown as { expect?: { url?: string; requests?: string[] } }[];
        expect(fillSteps.length).toBeGreaterThan(0);
        for (const step of fillSteps) expect(step.expect).toBeUndefined();
      } finally {
        await engine.shutdown();
      }

      // The saved flow replays clean in a fresh session: the expectation
      // sits on the step that can actually satisfy it.
      const replay = await createEngine(nextSession('overlap-replay'));
      try {
        const result = await replay.flowRun({ file: savePath, params: { clave: 'hunter2' } });
        const data = result.data as { ok: boolean; lines: string[] };
        expect(data.ok, data.lines.join('\n')).toBe(true);
      } finally {
        await replay.shutdown();
      }
    },
    30000,
  );
});

// ---------------------------------------------------------------------------
// R15: a gesture inside a popup records against the popup's own tab.
// ---------------------------------------------------------------------------

describe('human capture: popup gestures record against their own tab (R15)', () => {
  test(
    'a click inside a popup is recorded with the popup tab id, not the opener',
    async () => {
      const engine = await EngineCore.create(nextSession('popup-capture'));
      try {
        await engine.recordStart({ url: `${server.origin}/popup` });
        const opener = engine.session!.activePage();

        const [popup] = await Promise.all([opener.waitForEvent('popup'), opener.click('#abrir')]);
        await popup.waitForLoadState();
        await waitForActionCount(engine, 2); // open + click "Abrir"

        await popup.click('h1');
        await waitForActionCount(engine, 3);

        const openerTabId = engine.session!.tabIdForPage(opener);
        const popupTabId = engine.session!.tabIdForPage(popup);
        expect(popupTabId).toBeDefined();
        expect(popupTabId).not.toBe(openerTabId);

        const historyRes = await engine.history({});
        const actions = historyRes.data as { tabId: string }[];
        expect(actions[actions.length - 1]!.tabId).toBe(popupTabId);
      } finally {
        await engine.shutdown();
      }
    },
    30000,
  );
});

// ---------------------------------------------------------------------------
// S9 (CWE-346): a forged capture call from a child frame is dropped, and
// masking never trusts the page's own `isPassword` flag.
// ---------------------------------------------------------------------------

describe('capture trust boundary (S9)', () => {
  test(
    'a __rastroCapture call from a child frame is ignored',
    async () => {
      const engine = await EngineCore.create(nextSession('frame-forge'));
      try {
        await engine.recordStart({ url: `${server.origin}/captcha` });
        const page = engine.session!.activePage();
        await waitForActionCount(engine, 1); // just the open

        const child = page.frames().find((f) => f !== page.mainFrame());
        expect(child).toBeDefined();
        await child!.evaluate(() => {
          (window as unknown as { __rastroCapture: (e: unknown) => void }).__rastroCapture({
            kind: 'click',
            bundle: { role: 'button', name: 'Forged' },
            isPassword: false,
            ts: Date.now(),
          });
        });

        // Give the (should-be-rejected) call a moment to land if it weren't filtered.
        await new Promise((resolve) => setTimeout(resolve, 200));
        await engine.recordStop({});
        const historyRes = await engine.history({});
        const actions = historyRes.data as { targetName?: string }[];
        expect(actions.some((a) => a.targetName === 'Forged')).toBe(false);
      } finally {
        await engine.shutdown();
      }
    },
    30000,
  );

  test(
    'secret masking is decided from the bundle inputType, not a forged isPassword flag',
    async () => {
      const engine = await EngineCore.create(nextSession('mask-trust'));
      try {
        await engine.recordStart({ url: `${server.origin}/record` });
        const page = engine.session!.activePage();
        await waitForActionCount(engine, 1);

        await page.evaluate(() => {
          (window as unknown as { __rastroCapture: (e: unknown) => void }).__rastroCapture({
            kind: 'fill',
            bundle: { role: 'textbox', name: 'Clave', inputType: 'password' },
            value: 'realsecret123',
            isPassword: false,
            ts: Date.now(),
          });
        });
        await waitForActionCount(engine, 2);

        const historyRes = await engine.history({});
        expect(historyRes.text).not.toContain('realsecret123');
        expect(historyRes.text).toContain('•••');
      } finally {
        await engine.shutdown();
      }
    },
    30000,
  );
});

// ---------------------------------------------------------------------------
// Flow runner semantics: expectations, from, if/else.
// ---------------------------------------------------------------------------

// The fixture's POST /login redirects (302) on success and returns 401 on a
// wrong password — never 2xx — so callers pick the pattern that matches what
// they're testing.
function loginFlow(name: string, requestPattern: string): Flow {
  return {
    name,
    params: { password: { secret: true } },
    steps: [
      { open: `${server.origin}/login`, id: 's1' },
      { fill: { label: 'Email' }, value: 'a@b.com', id: 's2' },
      { fill: { label: 'Contraseña' }, value: '{{password}}', id: 's3' },
      {
        click: { role: 'button', name: 'Entrar' },
        expect: { requests: [requestPattern] },
        id: 's4',
      },
    ],
  };
}

describe('flow expectations', () => {
  test(
    'a failed request expectation reports the actual status',
    async () => {
      const engine = await createEngine(nextSession('login-fail'));
      try {
        const file = writeFlow('login', loginFlow('login-fail', 'POST /login 2xx'));
        const result = await engine.flowRun({ file, params: { password: 'wrong' } });
        const data = result.data as { ok: boolean; reason?: string; failedStep?: number };
        expect(data.ok).toBe(false);
        expect(data.failedStep).toBe(4);
        expect(data.reason).toBe('step 4 failed: expected POST /login 2xx, got 401');
      } finally {
        await engine.shutdown();
      }
    },
    30000,
  );

  test(
    'passes when the request expectation is met',
    async () => {
      const engine = await createEngine(nextSession('login-ok'));
      try {
        const file = writeFlow('login', loginFlow('login-ok', 'POST /login 3xx'));
        const result = await engine.flowRun({ file, params: { password: 'right' } });
        const data = result.data as { ok: boolean; lines: string[] };
        expect(data.ok, data.lines.join('\n')).toBe(true);
      } finally {
        await engine.shutdown();
      }
    },
    30000,
  );
});

describe('flow run from', () => {
  test(
    'running from step 2 on an already-open page skips the unreachable open step',
    async () => {
      const engine = await createEngine(nextSession('from'));
      try {
        await engine.open({ url: `${server.origin}/login`, allowWrite: ['127.0.0.1'] });

        const flow: Flow = {
          name: 'from-mid',
          params: { password: { secret: true } },
          steps: [
            // Unreachable: proves this step is skipped, not just fast.
            { open: 'http://127.0.0.1:1/unreachable', id: 's1' },
            { fill: { label: 'Email' }, value: 'a@b.com', id: 's2' },
            { fill: { label: 'Contraseña' }, value: '{{password}}', id: 's3' },
            {
              click: { role: 'button', name: 'Entrar' },
              expect: { requests: ['POST /login 3xx'] },
              id: 's4',
            },
          ],
        };
        const file = writeFlow('from', flow);
        const result = await engine.flowRun({ file, from: 2, params: { password: 'right' } });
        const data = result.data as { ok: boolean; lines: string[] };
        expect(data.ok, data.lines.join('\n')).toBe(true);
      } finally {
        await engine.shutdown();
      }
    },
    30000,
  );
});

describe('flow conditionals', () => {
  test(
    'if-branch runs when the condition text is visible',
    async () => {
      const engine = await createEngine(nextSession('if-then'));
      try {
        const flow: Flow = {
          name: 'cond-then',
          steps: [
            { open: `${server.origin}/login`, id: 's1' },
            {
              if: { text: 'Iniciar sesión' },
              then: [{ fill: { label: 'Email' }, value: 'a@b.com', id: 's2a' }],
              else: [{ goto: `${server.origin}/help`, id: 's2b' }],
              id: 's2',
            },
          ],
        };
        const file = writeFlow('cond-then', flow);
        const result = await engine.flowRun({ file, params: {} });
        const data = result.data as { ok: boolean; lines: string[] };
        expect(data.ok, data.lines.join('\n')).toBe(true);
        expect(data.lines.some((l) => l.includes('[2] if then'))).toBe(true);
      } finally {
        await engine.shutdown();
      }
    },
    30000,
  );

  test(
    'else-branch runs when the condition text is absent',
    async () => {
      const engine = await createEngine(nextSession('if-else'));
      try {
        const flow: Flow = {
          name: 'cond-else',
          steps: [
            { open: `${server.origin}/login`, id: 's1' },
            {
              if: { text: 'texto que no existe en la página' },
              then: [{ fill: { label: 'Email' }, value: 'a@b.com', id: 's2a' }],
              else: [{ goto: `${server.origin}/help`, id: 's2b' }],
              id: 's2',
            },
          ],
        };
        const file = writeFlow('cond-else', flow);
        const result = await engine.flowRun({ file, params: {} });
        const data = result.data as { ok: boolean; lines: string[] };
        expect(data.ok, data.lines.join('\n')).toBe(true);
        expect(data.lines.some((l) => l.includes('[2] if else'))).toBe(true);
      } finally {
        await engine.shutdown();
      }
    },
    30000,
  );
});

// ---------------------------------------------------------------------------
// Continue recording: replay a prefix, then keep capturing.
// ---------------------------------------------------------------------------

describe('continue recording', () => {
  test(
    'recordStart with continue/at replays the prefix then captures the rest',
    async () => {
      const prefix: Flow = {
        name: 'continued',
        steps: [
          { open: `${server.origin}/record`, id: 's1' },
          { fill: { label: 'Nombre' }, value: 'Beto', id: 's2' },
        ],
      };
      const prefixFile = writeFlow('continue', prefix);

      const engine = await EngineCore.create(nextSession('continue'));
      try {
        await engine.recordStart({ continue: prefixFile, at: 3 });

        // The prefix (open + fill) ran through the runner: one action.
        await waitForActionCount(engine, 2);

        const page = engine.session!.activePage();
        await page.selectOption('select[name="pais"]', { label: 'CL' });
        await waitForActionCount(engine, 3);
        await page.click('[data-testid="guardar"]');
        await page.waitForURL('**/record/done');

        await waitForActionCount(engine, 4);

        const savePath = join(home, 'continued.yaml');
        await engine.recordStop({ save: savePath });

        const flow = parseFlow(readFileSync(savePath, 'utf8'));
        expect(flow.steps).toHaveLength(4);
        expect(flow.steps[0]).toMatchObject({ open: `${server.origin}/record`, id: 's1' });
        expect(flow.steps[1]).toMatchObject({ fill: { label: 'Nombre' }, value: 'Beto', id: 's2' });
        const kinds = flow.steps.slice(2).map((s) => Object.keys(s as unknown as Record<string, unknown>)[0]);
        expect(kinds).toContain('select');
        expect(kinds).toContain('click');
      } finally {
        await engine.shutdown();
      }
    },
    30000,
  );
});

// ---------------------------------------------------------------------------
// Export to Playwright / import from Chrome DevTools Recorder.
// ---------------------------------------------------------------------------

describe('flow export/import', () => {
  test('flowExport produces a spec referencing the recorded target', async () => {
    const engine = await createEngine(nextSession('export'));
    try {
      const flow: Flow = {
        name: 'export-me',
        steps: [
          { open: `${server.origin}/record`, id: 's1' },
          { click: { role: 'button', name: 'Guardar', testId: 'guardar' }, id: 's2' },
        ],
      };
      const file = writeFlow('export', flow);
      const result = await engine.flowExport({ file, format: 'playwright' });
      const code = readFileSync((result.data as { file: string }).file, 'utf8');
      expect(code).toMatch(/getByRole\("button", \{ name: "Guardar", exact: true \}\)|getByTestId\("guardar"\)/);
    } finally {
      await engine.shutdown();
    }
  });

  test('flowImport converts a Chrome Recorder JSON into a runnable flow', async () => {
    const engine = await createEngine(nextSession('import'));
    try {
      const recording = {
        title: 'chrome-login',
        steps: [
          { type: 'setViewport', width: 800, height: 600 },
          { type: 'navigate', url: `${server.origin}/login` },
          { type: 'change', value: 'a@b.com', selectors: [['input[name="email"]']] },
          { type: 'change', value: 'right', selectors: [['input[name="password"]']] },
          { type: 'click', selectors: [['aria/Entrar[role="button"]']] },
        ],
      };
      const jsonFile = flowPath('chrome-recording').replace(/\.yaml$/, '.json');
      writeFileSync(jsonFile, JSON.stringify(recording));
      const out = flowPath('chrome-imported');

      const importRes = await engine.flowImport({ file: jsonFile, out });
      expect((importRes.data as { file: string }).file).toBe(out);

      const runRes = await engine.flowRun({ file: out, params: {} });
      const data = runRes.data as { ok: boolean; lines: string[] };
      expect(data.ok, data.lines.join('\n')).toBe(true);
    } finally {
      await engine.shutdown();
    }
  });
});

const hasKeyring = spawnSync('sh', ['-c', 'command -v secret-tool'], { stdio: 'ignore' }).status === 0;

describe.runIf(hasKeyring)('a vault value never reaches the trace', () => {
  const ENTRY = 'rastro.flowtest.pw';
  afterAll(() => {
    secretRemove(ENTRY);
  });

  test(
    'an undeclared --param resolved from the keyring is still stored masked',
    async () => {
      secretSet(ENTRY, 'vault-only-value');
      const session = nextSession('vault-mask');
      const engine = await createEngine(session);
      try {
        // The flow declares no `password`: this is the shape where the value
        // used to be written to the trace in the clear, because there was no
        // param definition to carry the secret flag.
        const flow = loginFlow('vault-mask', 'POST /login 2xx');
        delete flow.params;
        const file = writeFlow('vault-mask', flow);

        await engine.flowRun({ file, params: { password: `secret:${ENTRY}` } });

        // Read the raw trace, not the formatted output: the registry masks
        // what is printed, so `history` stays clean either way. What this test
        // is about is whether the value was ever written down.
        const db = new DatabaseSync(join(home, 'sessions', session, 'trace.db'), { readOnly: true });
        try {
          const rows = db.prepare('SELECT data FROM actions').all() as { data: string }[];
          expect(rows.length).toBeGreaterThan(0);
          expect(rows.map((r) => r.data).join('\n')).not.toContain('vault-only-value');
        } finally {
          db.close();
        }
      } finally {
        await engine.shutdown();
      }
    },
    30000,
  );
});

describe('secret references in flow params', () => {
  test(
    'a missing keyring entry aborts before the first step, naming the entry',
    async () => {
      const engine = await createEngine(nextSession('vault-missing'));
      try {
        const flow = loginFlow('vault-missing', 'POST /login 2xx');
        // `from` replaces the caller-supplied value: the flow now says where to
        // get the password rather than expecting it on the command line.
        flow.params = { ...flow.params, password: { secret: true, from: 'secret:rastro.test.definitely-absent' } };
        const file = writeFlow('vault-missing', flow);

        await expect(engine.flowRun({ file })).rejects.toThrow(/rastro\.test\.definitely-absent/);
      } finally {
        await engine.shutdown();
      }
    },
    30000,
  );
});

describe('record start on an already-open session', () => {
  test(
    'asks for a headed browser, because a human cannot drive what they cannot see',
    async () => {
      const engine = await createEngine(nextSession('record-headed'));
      try {
        await engine.open({ url: `${server.origin}/record`, allowWrite: ['127.0.0.1'] });

        // The suite forces RASTRO_RECORD_HEADLESS=1 so no window ever opens, so
        // assert the request instead of the window: record it, then run the
        // real open headless anyway.
        const asked: Record<string, unknown>[] = [];
        const realOpen = engine.open.bind(engine);
        (engine as unknown as { open: (p: Record<string, unknown>) => Promise<unknown> }).open = async (p) => {
          asked.push(p);
          return realOpen({ ...p, headed: false });
        };
        delete process.env.RASTRO_RECORD_HEADLESS;

        await engine.recordStart({ url: `${server.origin}/record` });
        await engine.recordStop({});

        // recordStart used to ask for headed only when there was no session at
        // all, so an already-open session stayed headless while the CLI
        // cheerfully reported "recording started".
        expect(asked.some((p) => p.headed === true)).toBe(true);
      } finally {
        process.env.RASTRO_RECORD_HEADLESS = '1';
        await engine.shutdown();
      }
    },
    60000,
  );
});
