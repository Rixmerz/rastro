import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { call } from '../src/daemon/client.ts';
import { parseFlow } from '../src/flow/format.ts';

const BIN = new URL('../bin/rastro.js', import.meta.url).pathname;
const FAKE_ENGINE = new URL('./helpers/fake-engine.ts', import.meta.url).pathname;

let home: string;
let runtime: string;
const openedSessions: string[] = [];

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'rastro-cli-home-'));
  runtime = mkdtempSync(join(tmpdir(), 'rastro-cli-run-'));
  // Also set on this process's env: afterAll's cleanup calls the in-process
  // `call()`, which resolves session paths from process.env, not from the
  // env object handed to the spawned CLI children below.
  process.env.RASTRO_HOME = home;
  process.env.XDG_RUNTIME_DIR = runtime;
  process.env.RASTRO_ENGINE_MODULE = FAKE_ENGINE;
});

afterAll(async () => {
  for (const session of openedSessions) {
    try {
      await call(session, 'close', {}, { spawn: false, timeoutMs: 2000 });
    } catch {
      // Already gone — fine, this is best-effort cleanup.
    }
  }
  delete process.env.RASTRO_HOME;
  delete process.env.XDG_RUNTIME_DIR;
  delete process.env.RASTRO_ENGINE_MODULE;
  rmSync(home, { recursive: true, force: true });
  rmSync(runtime, { recursive: true, force: true });
});

function track(session: string): string {
  openedSessions.push(session);
  return session;
}

interface CliResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

function runCli(args: string[], extraEnv: NodeJS.ProcessEnv = {}): Promise<CliResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { env: { ...process.env, ...extraEnv } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => resolvePromise({ stdout, stderr, code }));
  });
}

/** The `data` of a `--json` envelope, after checking the envelope itself. */
function dataOf(stdout: string): unknown {
  const envelope = JSON.parse(stdout) as { schemaVersion: number; ok: boolean; data: unknown };
  expect(envelope).toMatchObject({ schemaVersion: 1, ok: true });
  return envelope.data;
}

describe('rastro CLI', () => {
  test('open maps flags to RPC params, including a comma list', async () => {
    const session = track('cli-open');
    const { stdout, code } = await runCli(['-s', session, 'open', 'https://example.test', '--allow-write', 'h1,h2', '--json']);
    expect(code).toBe(0);
    const data = dataOf(stdout) as { method: string; params: Record<string, unknown> };
    expect(data.method).toBe('open');
    expect(data.params).toMatchObject({ url: 'https://example.test', allowWrite: ['h1', 'h2'] });
  });

  test('fill shorthand maps to act with secret', async () => {
    const session = track('cli-fill');
    const { stdout, code } = await runCli(['-s', session, 'fill', 'e3', 'hola', '--secret', '--json']);
    expect(code).toBe(0);
    const data = dataOf(stdout) as { method: string; params: Record<string, unknown> };
    expect(data.method).toBe('act');
    expect(data.params).toMatchObject({ ref: 'e3', kind: 'fill', value: 'hola', secret: true });
  });

  test('open maps --allow-upload to absolute allowUpload paths', async () => {
    const session = track('cli-open-allow-upload');
    const { stdout, code } = await runCli([
      '-s',
      session,
      'open',
      'https://example.test',
      '--allow-upload',
      'uploads,more-uploads',
      '--json',
    ]);
    expect(code).toBe(0);
    const data = dataOf(stdout) as { params: { allowUpload: string[] } };
    expect(data.params.allowUpload).toEqual([resolve(process.cwd(), 'uploads'), resolve(process.cwd(), 'more-uploads')]);
  });

  test('export maps --reveal and --bodies', async () => {
    const session = track('cli-export-reveal');
    const { stdout, code } = await runCli(['-s', session, 'export', 'har', '--reveal', '--bodies', '--json']);
    expect(code).toBe(0);
    const data = dataOf(stdout) as { method: string; params: Record<string, unknown> };
    expect(data.method).toBe('export');
    expect(data.params).toMatchObject({ format: 'har', reveal: true, bodies: true });
  });

  test('trace splits --type into a list', async () => {
    const session = track('cli-trace-type');
    const { stdout, code } = await runCli(['-s', session, 'trace', '--type', 'request,console', '--json']);
    expect(code).toBe(0);
    // trace's fake response is 10 KB of text, but --json only carries `data`.
    const data = dataOf(stdout) as { method: string; params: Record<string, unknown> };
    expect(data.params).toMatchObject({ type: ['request', 'console'] });
  });

  test('flow run collects repeated --param into an object', async () => {
    const session = track('cli-flow-run');
    const flowFile = join(home, 'flow.yaml');
    const { stdout, code } = await runCli([
      '-s',
      session,
      'flow',
      'run',
      flowFile,
      '--param',
      'a=1',
      '--param',
      'b=2',
      '--json',
    ]);
    expect(code).toBe(0);
    const data = dataOf(stdout) as { method: string; params: { file: string; params: Record<string, string> } };
    expect(data.method).toBe('flowRun');
    expect(data.params.params).toEqual({ a: '1', b: '2' });
    expect(data.params.file).toBe(resolve(flowFile));
  });

  test('a relative file path argument is resolved against cwd before it is sent', async () => {
    const session = track('cli-relpath');
    const { stdout, code } = await runCli(['-s', session, 'screenshot', 'shot.png', '--json'], {});
    expect(code).toBe(0);
    const data = dataOf(stdout) as { params: { path: string } };
    expect(data.params.path).toBe(resolve(process.cwd(), 'shot.png'));
  });

  test('--json prints a single JSON line: a versioned envelope around result.data', async () => {
    const session = track('cli-json');
    const { stdout, code } = await runCli(['-s', session, 'view', '--json']);
    expect(code).toBe(0);
    expect(stdout.trim().split('\n')).toHaveLength(1);
    expect(dataOf(stdout)).toMatchObject({ method: 'view' });
  });

  test('--json reports a usage error as an envelope on stdout, exit 2', async () => {
    const { stdout, stderr, code } = await runCli(['view', '--bogus', '--json']);
    expect(code).toBe(2);
    expect(JSON.parse(stdout)).toMatchObject({ schemaVersion: 1, ok: false, error: { kind: 'usage' } });
    expect(stderr).toMatch(/^error: /);
  });

  test('--json reports a runtime error with its hint, exit 1', async () => {
    const { stdout, code } = await runCli(['flow', 'emit', join(home, 'nope.yaml'), '--json']);
    expect(code).toBe(1);
    expect(JSON.parse(stdout)).toMatchObject({ schemaVersion: 1, ok: false, error: { kind: 'runtime', message: expect.stringMatching(/no flow/) } });
  });

  test('flow emit writes a client next to a fresh recipe and reports what it needs', async () => {
    const flowFile = join(home, 'jobs.yaml');
    const flowText = 'name: jobs\nsteps:\n  - goto: https://api.test/jobs\n';
    writeFileSync(flowFile, flowText);
    const recipe = [
      'flow: jobs',
      `flowHash: ${createHash('sha256').update(flowText).digest('hex')}`,
      'params: [team]',
      'requests:',
      '  - id: q1',
      '    method: GET',
      '    url: https://api.test/jobs',
      '    query: [{ name: team, value: "{{team}}" }, { name: page, value: "1" }]',
      '    headers: { x-token: "{{apiToken}}" }',
      '    xhr: true',
      '    paginate: { query: page, next: { step: 1 }, items: jobs, maxPages: 5 }',
    ].join('\n');
    writeFileSync(join(home, 'jobs.link.yaml'), recipe);

    const { stdout, code } = await runCli(['flow', 'emit', flowFile, '--lang', 'py', '--json']);
    expect(code).toBe(0);
    const data = dataOf(stdout) as { file: string; verified: boolean; params: string[]; env: string[]; paginated: string[] };
    expect(data).toMatchObject({ file: join(home, 'jobs_client.py'), verified: false, params: ['team'], env: ['API_TOKEN'], paginated: ['q1'] });
    expect(readFileSync(data.file, 'utf8')).toContain('def jobs(params');

    const text = await runCli(['flow', 'emit', flowFile, '--out', join(home, 'out.ts')]);
    expect(text.code).toBe(0);
    expect(text.stdout).toMatch(/emitted .*out\.ts/);
    expect(text.stdout).toMatch(/warning: the recipe is not verified yet/);
    expect(readFileSync(join(home, 'out.ts'), 'utf8')).toContain('export async function jobs(');

    writeFileSync(flowFile, `${flowText}# edited\n`);
    const stale = await runCli(['flow', 'emit', flowFile]);
    expect(stale.code).toBe(1);
    expect(stale.stderr).toMatch(/stale/);
  });

  test('flow emit refuses a flow that was never linked, and an unknown language', async () => {
    const flowFile = join(home, 'unlinked.yaml');
    writeFileSync(flowFile, 'name: unlinked\nsteps: []\n');
    const unlinked = await runCli(['flow', 'emit', flowFile]);
    expect(unlinked.code).toBe(1);
    expect(unlinked.stderr).toMatch(/not linked[\s\S]*hint: run: rastro flow link unlinked/);
    const lang = await runCli(['flow', 'emit', flowFile, '--lang', 'go']);
    expect(lang.code).toBe(2);
  });

  test('--version --json', async () => {
    const { stdout, code } = await runCli(['--version', '--json']);
    expect(code).toBe(0);
    expect(dataOf(stdout)).toMatchObject({ version: expect.any(String) });
  });

  test('output over 4 KB is written to a file and only the first 20 lines print', async () => {
    const session = track('cli-large-output');
    const { stdout, code } = await runCli(['-s', session, 'trace']);
    expect(code).toBe(0);
    const match = /output written to (\S+) \((\d+) lines\)/.exec(stdout);
    expect(match).not.toBeNull();
    const [, filePath] = match ?? [];
    expect(filePath).toBeDefined();
    expect(existsSync(filePath as string)).toBe(true);
    const written = readFileSync(filePath as string, 'utf8');
    expect(written.length).toBeGreaterThan(4096);
    const printedBody = stdout.split('\n').slice(1);
    expect(printedBody.length).toBeLessThanOrEqual(20);
  });

  test('an engine error exits 1 and prints the hint on stderr', async () => {
    const session = track('cli-error');
    const { stdout, stderr, code } = await runCli(['-s', session, 'goto', 'https://example.test']);
    expect(code).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('error: boom');
    expect(stderr).toContain('hint: try again');
  });

  test('a usage error exits 2', async () => {
    const session = track('cli-usage');
    const { stderr, code } = await runCli(['-s', session, 'goto']);
    expect(code).toBe(2);
    expect(stderr).toContain('error:');
  });

  test('close on a session with no daemon running exits 0', async () => {
    const { stdout, code } = await runCli(['-s', 'never-started', 'close']);
    expect(code).toBe(0);
    expect(stdout).toContain('is not running');
  });
});

describe('flows.md examples parse with the real flow parser', () => {
  const flowsMdPath = new URL('../plugin/skills/rastro/references/flows.md', import.meta.url).pathname;
  const flowsMd = readFileSync(flowsMdPath, 'utf8');
  const yamlBlocks = [...flowsMd.matchAll(/```yaml\n([\s\S]*?)```/g)].map((m) => m[1] ?? '');
  const stepsBlocks = yamlBlocks.filter((block) => block.includes('steps:'));

  test('flows.md has at least one fenced yaml block with steps:', () => {
    expect(stepsBlocks.length).toBeGreaterThan(0);
  });

  test.each(stepsBlocks.map((block, i) => [i, block] as const))('block #%i parses', (_i, block) => {
    expect(() => parseFlow(block)).not.toThrow();
  });
});
