import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';

const BIN = new URL('../bin/rastro.js', import.meta.url).pathname;
const root = mkdtempSync(join(tmpdir(), 'rastro-profile-cli-'));
const env = {
  ...process.env,
  RASTRO_HOME: join(root, 'home'),
  XDG_RUNTIME_DIR: join(root, 'run'),
  XDG_CONFIG_HOME: join(root, 'config'),
};
// A Chromium user-data dir with one named profile; nothing launches it here.
mkdirSync(join(env.XDG_CONFIG_HOME, 'chromium', 'Profile 2'), { recursive: true });
writeFileSync(join(env.XDG_CONFIG_HOME, 'chromium', 'Local State'), JSON.stringify({ profile: { info_cache: { 'Profile 2': { name: 'Work' } } } }));

afterAll(() => rmSync(root, { recursive: true, force: true }));

function rastro(...args: string[]): { code: number | null; out: string; err: string } {
  const r = spawnSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe.runIf(existsSync('/usr/bin/chromium'))('rastro profile use', () => {
  test('saves the write allowlist with the borrowed profile', () => {
    const use = rastro('-s', 'work', 'profile', 'use', 'chromium:work', '--allow-write', 'a.test, b.test');
    expect(use.code).toBe(0);
    expect(use.out).toContain('writes allowed to a.test, b.test by default');

    const saved = JSON.parse(readFileSync(join(env.RASTRO_HOME, 'sessions', 'work', 'profile.json'), 'utf8')) as Record<string, unknown>;
    expect(saved).toMatchObject({ browser: 'chromium', profileDirectory: 'Profile 2', profileName: 'Work', allowWrite: ['a.test', 'b.test'] });

    expect(rastro('-s', 'work', 'profile').out).toContain('writes allowed to a.test, b.test by default');
    expect(rastro('-s', 'work', 'profiles').out).toContain('chromium:Profile 2  Chromium "Work" · free  ← this session (writes allowed to a.test, b.test by default)');
  });

  test('rebinding without --allow-write blocks writes again', () => {
    rastro('-s', 'work', 'profile', 'use', 'chromium:work', '--allow-write', 'a.test');
    expect(rastro('-s', 'work', 'profile', 'use', 'chromium:work').out).toContain('writes blocked everywhere by default');
  });

  test("an allowlist cannot be saved for Rastro's own profile", () => {
    const r = rastro('-s', 'work', 'profile', 'use', 'rastro', '--allow-write', 'a.test');
    expect(r.code).toBe(2);
    expect(r.err).toContain('pass it to open');
  });

  test('--json answers in the versioned envelope', () => {
    rastro('-s', 'work', 'profile', 'use', 'chromium:work', '--allow-write', 'a.test');
    const shown = JSON.parse(rastro('--json', '-s', 'work', 'profile').out) as { schemaVersion: number; ok: boolean; data: { bound: { allowWrite: string[] } } };
    expect(shown).toMatchObject({ ok: true, data: { bound: { allowWrite: ['a.test'] } } });
    expect(typeof shown.schemaVersion).toBe('number');

    const failed = rastro('--json', '-s', 'work', 'profile', 'use', 'firefox');
    expect(failed.code).toBe(1);
    expect(JSON.parse(failed.out)).toMatchObject({ ok: false, error: { kind: 'runtime' } });
  });

  test('an unknown flag is a usage error', () => {
    expect(rastro('-s', 'work', 'profile', 'use', 'chromium', '--allow-wirte', 'a.test').code).toBe(2);
  });
});
