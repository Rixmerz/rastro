import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { parseFlow, stringifyFlow, type Flow } from '../src/flow/format.ts';
import { validateRoutineParams } from '../src/routines/params.ts';
import { findRoutine, loadRoutines } from '../src/routines/registry.ts';
import { contentHash, markVerified } from '../src/routines/state.ts';
import { formatRoutineResult } from '../src/routines/result.ts';
import { routineDirs } from '../src/core/paths.ts';

let home: string;
let userDir: string;
let projectDir: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'rastro-routines-'));
  userDir = join(home, 'user');
  projectDir = join(home, 'project');
  mkdirSync(userDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  process.env.RASTRO_HOME = join(home, 'state');
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.RASTRO_HOME;
  delete process.env.RASTRO_FLOWS;
});

const ROUTINE_YAML = `name: publish-file
tool:
  description: Publish a file in a course section
  effect: write
  session: school
  allowWrite: [lms.example.edu]
  login: login-school
  loginWhen: { url: /login }
params:
  course: { type: integer, description: numeric course id, example: 12345 }
  file: { type: path, description: the file }
  mode: { enum: [draft, live], default: draft, description: publish mode }
  password: { from: "secret:school" }
steps:
  - open: "https://lms.example.edu/course/view.php?id={{course}}"
`;

function write(dir: string, name: string, text: string): string {
  const file = join(dir, name);
  writeFileSync(file, text);
  return file;
}

describe('manifest format', () => {
  test('tool block and typed params round-trip', () => {
    const flow = parseFlow(ROUTINE_YAML);
    expect(flow.tool).toEqual({
      description: 'Publish a file in a course section',
      effect: 'write',
      session: 'school',
      allowWrite: ['lms.example.edu'],
      login: 'login-school',
      loginWhen: { url: '/login' },
    });
    expect(flow.params?.['course']).toEqual({ type: 'integer', description: 'numeric course id', example: 12345 });
    expect(parseFlow(stringifyFlow(flow))).toEqual(flow);
  });

  test('an unknown effect is refused with its path', () => {
    expect(() => parseFlow(ROUTINE_YAML.replace('effect: write', 'effect: maybe'))).toThrow(/tool\.effect/);
  });

  test('login without loginWhen is refused', () => {
    expect(() => parseFlow(ROUTINE_YAML.replace('  loginWhen: { url: /login }\n', ''))).toThrow(/loginWhen: required/);
  });

  test('a flow without a tool block has none', () => {
    expect(parseFlow('name: x\nsteps:\n  - open: https://a.example\n').tool).toBeUndefined();
  });
});

describe('typed params', () => {
  const flow = (): Flow => parseFlow(ROUTINE_YAML);

  test('coerces and normalises valid values', () => {
    expect(validateRoutineParams(flow(), { course: 12345, file: '~/Documents/a.pdf' })).toEqual({
      course: '12345',
      file: join(homedir(), 'Documents/a.pdf'),
    });
  });

  test('refuses a wrong type naming the param', () => {
    expect(() => validateRoutineParams(flow(), { course: 'abc', file: '/tmp/a' })).toThrow(/param course: expected an integer/);
  });

  test('refuses a relative path', () => {
    expect(() => validateRoutineParams(flow(), { course: 1, file: 'a.pdf' })).toThrow(/absolute path/);
  });

  test('refuses a value outside the enum', () => {
    expect(() => validateRoutineParams(flow(), { course: 1, file: '/a', mode: 'x' })).toThrow(/one of draft, live/);
  });

  test('refuses a keyring param from the caller', () => {
    expect(() => validateRoutineParams(flow(), { course: 1, file: '/a', password: 'x' })).toThrow(/comes from the keyring/);
  });

  test('refuses unknown and missing params before anything runs', () => {
    expect(() => validateRoutineParams(flow(), { course: 1, file: '/a', extra: 'x' })).toThrow(/unknown param extra/);
    expect(() => validateRoutineParams(flow(), { course: 1 })).toThrow(/missing param file/);
  });
});

describe('registry', () => {
  test('only flows with a tool block are routines, named after the file', () => {
    write(userDir, 'publish-file.yaml', ROUTINE_YAML);
    write(userDir, 'recorded.yaml', 'name: recorded\nsteps:\n  - open: https://a.example\n');
    write(userDir, 'other.yaml', ROUTINE_YAML.replace('name: publish-file', 'name: recorded'));
    const { routines } = loadRoutines([userDir]);
    expect(routines.map((r) => r.name)).toEqual(['other', 'publish-file']);
  });

  test('a broken routine is a problem, a broken plain flow is ignored', () => {
    write(userDir, 'broken.yaml', 'name: broken\ntool:\n  description: x\n  effect: nope\nsteps: []\n');
    write(userDir, 'junk.yaml', 'not: [valid');
    const catalog = loadRoutines([userDir]);
    expect(catalog.routines).toEqual([]);
    expect(catalog.problems).toHaveLength(1);
    expect(catalog.problems[0]!.name).toBe('broken');
    expect(catalog.problems[0]!.error).toMatch(/tool\.effect/);
  });

  test('reserved names and recipe files are not routines', () => {
    write(userDir, 'rastro_open.yaml', ROUTINE_YAML);
    write(userDir, 'publish-file.link.yaml', ROUTINE_YAML);
    const catalog = loadRoutines([userDir]);
    expect(catalog.routines).toEqual([]);
    expect(catalog.problems.map((p) => p.name)).toEqual(['rastro_open']);
  });

  test('the first directory wins and the other is reported as shadowed', () => {
    const winner = write(projectDir, 'publish-file.yaml', ROUTINE_YAML);
    const loser = write(userDir, 'publish-file.yaml', ROUTINE_YAML);
    const catalog = loadRoutines([projectDir, userDir]);
    expect(catalog.routines.map((r) => r.file)).toEqual([winner]);
    expect(catalog.shadowed).toEqual([{ name: 'publish-file', file: loser, by: winner }]);
  });

  test('verification follows the bytes: an edit resets it', () => {
    const file = write(userDir, 'publish-file.yaml', ROUTINE_YAML);
    markVerified(contentHash(ROUTINE_YAML), file);
    expect(findRoutine('publish-file', [userDir]).verified).toBe(true);
    writeFileSync(file, `${ROUTINE_YAML}  - reload: true\n`);
    expect(findRoutine('publish-file', [userDir]).verified).toBe(false);
  });

  test('lint flags generated css ids, undocumented params and a leftover name', () => {
    write(
      userDir,
      'lint.yaml',
      `name: recorded
tool: { description: d, effect: read }
params:
  q: {}
steps:
  - click: { css: "#ext-gen51 > div:nth-of-type(1)" }
`,
    );
    const [routine] = loadRoutines([userDir]).routines;
    expect(routine!.warnings).toEqual([
      'flow is still named "recorded"',
      'param q has no description',
      'step 1: css locator looks generated per page load (#ext-gen51 > div:nth-of-type(1))',
    ]);
  });

  test('RASTRO_FLOWS overrides the default directories', () => {
    process.env.RASTRO_FLOWS = `${projectDir}:${userDir}`;
    expect(routineDirs()).toEqual([projectDir, userDir]);
  });
});

describe('result text', () => {
  test('a failure before any write says the retry is safe', () => {
    const text = formatRoutineResult({
      routine: 'publish-file',
      ok: false,
      engine: 'browser',
      stepsRun: 5,
      writes: [],
      actions: { first: 41, last: 45 },
      failedStep: '5',
      reason: 'element not found: link "File"',
      retrySafe: true,
      verified: false,
    });
    expect(text).toContain('publish-file failed at step 5: element not found');
    expect(text).toContain('writes sent: none');
    expect(text).toContain('retry is safe');
    expect(text).toContain('#41-#45');
  });

  test('a failure after a write says not to retry', () => {
    const text = formatRoutineResult({
      routine: 'publish-file',
      ok: false,
      engine: 'browser',
      stepsRun: 6,
      writes: [{ method: 'POST', path: '/note', status: 303, location: 'http://x.test/notes/4' }],
      retrySafe: false,
      reason: 'boom',
      verified: true,
    });
    expect(text).toContain('writes: POST /note 303 → /notes/4');
    expect(text).toContain('do NOT retry');
  });
});
