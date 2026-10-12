import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  assertProfileFree,
  backupSavedSession,
  describeAllowWrite,
  discoverProfiles,
  inspectLock,
  readProfiles,
  resolveProfileRef,
  restoreSavedSession,
  sameProfile,
  type ProfileBinding,
} from '../src/core/profiles.ts';

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function lockTo(userDataDir: string, target: string): void {
  symlinkSync(target, join(userDataDir, 'SingletonLock'));
}

/** A PID no process has: past the kernel's default pid_max. */
const DEAD_PID = 4_194_304 + 7;

describe('inspectLock', () => {
  test('no SingletonLock means free', () => {
    expect(inspectLock(tempDir('rastro-lock-'))).toEqual({ state: 'free' });
  });

  test('a lock held by a live process on this host is held', () => {
    const dir = tempDir('rastro-lock-');
    lockTo(dir, `${hostname()}-${String(process.pid)}`);
    expect(inspectLock(dir)).toMatchObject({ state: 'held', pid: process.pid, byRastro: false });
  });

  test('a lock whose process is gone is stale, so free', () => {
    const dir = tempDir('rastro-lock-');
    lockTo(dir, `${hostname()}-${String(DEAD_PID)}`);
    expect(inspectLock(dir)).toEqual({ state: 'free' });
  });

  test('a hostname with dashes still splits at the last one', () => {
    const dir = tempDir('rastro-lock-');
    lockTo(dir, `my-laptop-1-${String(process.pid)}`);
    expect(inspectLock(dir, 'my-laptop-1')).toMatchObject({ state: 'held', pid: process.pid });
  });

  test('a lock from another machine is reported as such', () => {
    const dir = tempDir('rastro-lock-');
    lockTo(dir, 'other-box-123');
    expect(inspectLock(dir, 'this-box')).toEqual({ state: 'other-host', host: 'other-box' });
  });
});

describe('assertProfileFree', () => {
  const binding = (userDataDir: string): ProfileBinding => ({
    browser: 'brave-origin',
    label: 'Brave Origin',
    userDataDir,
    profileDirectory: 'Default',
    profileName: 'Personal',
    executable: '/usr/bin/brave-origin',
  });

  test('passes on a free profile', () => {
    expect(() => assertProfileFree(binding(tempDir('rastro-lock-')))).not.toThrow();
  });

  test('tells the agent the user must close the browser, and that Rastro will not', () => {
    const dir = tempDir('rastro-lock-');
    lockTo(dir, `${hostname()}-${String(process.pid)}`);
    let caught: unknown;
    try {
      assertProfileFree(binding(dir));
    } catch (err) {
      caught = err;
    }
    expect(String(caught)).toContain('Brave Origin is open');
    expect((caught as { hint?: string }).hint).toContain('close Brave Origin completely');
    expect((caught as { hint?: string }).hint).toContain('never closes');
  });
});

describe('profile discovery', () => {
  function fakeConfig(): string {
    const config = tempDir('rastro-xdg-');
    const brave = join(config, 'BraveSoftware', 'Brave-Origin');
    mkdirSync(join(brave, 'Default'), { recursive: true });
    mkdirSync(join(brave, 'Profile 1'), { recursive: true });
    writeFileSync(
      join(brave, 'Local State'),
      JSON.stringify({ profile: { info_cache: { Default: { name: 'Personal' }, 'Profile 1': { name: 'Work' } } } }),
    );
    mkdirSync(join(config, 'chromium', 'Default'), { recursive: true });
    return config;
  }

  test('reads directories and display names from Local State', () => {
    const config = fakeConfig();
    expect(readProfiles(join(config, 'BraveSoftware', 'Brave-Origin'))).toEqual([
      { directory: 'Default', name: 'Personal' },
      { directory: 'Profile 1', name: 'Work' },
    ]);
  });

  test('without Local State, a Default directory still counts', () => {
    expect(readProfiles(join(fakeConfig(), 'chromium'))).toEqual([{ directory: 'Default' }]);
  });

  test('discovers every profile of every browser present', () => {
    const refs = discoverProfiles({ XDG_CONFIG_HOME: fakeConfig() }).map((p) => p.ref);
    expect(refs).toEqual(['chromium:Default', 'brave-origin:Default', 'brave-origin:Profile 1']);
  });

  test('rejects an unknown browser and an unknown profile with what exists', () => {
    const env = { XDG_CONFIG_HOME: fakeConfig() };
    expect(() => resolveProfileRef('firefox', env)).toThrow(/unknown browser/);
    let caught: unknown;
    try {
      resolveProfileRef('brave-origin:Gaming', env);
    } catch (err) {
      caught = err;
    }
    expect(String(caught)).toContain('no profile "Gaming"');
    expect((caught as { hint?: string }).hint).toContain('Profile 1 ("Work")');
  });

  test.runIf(existsSync('/usr/bin/brave-origin'))('matches a profile by its display name, case-insensitively', () => {
    const binding = resolveProfileRef('brave-origin:work', { XDG_CONFIG_HOME: fakeConfig() });
    expect(binding).toMatchObject({ browser: 'brave-origin', profileDirectory: 'Profile 1', profileName: 'Work' });
  });

  test('sameProfile compares the profile, not the label', () => {
    const a: ProfileBinding = { browser: 'x', label: 'X', userDataDir: '/u', profileDirectory: 'Default', executable: '/x' };
    expect(sameProfile(a, { ...a, label: 'Other' })).toBe(true);
    expect(sameProfile(a, { ...a, profileDirectory: 'Profile 1' })).toBe(false);
    expect(sameProfile(null, null)).toBe(true);
    expect(sameProfile(a, null)).toBe(false);
  });
});

describe('describeAllowWrite', () => {
  test('says plainly what a session may write', () => {
    expect(describeAllowWrite(undefined)).toBe('writes blocked everywhere');
    expect(describeAllowWrite([])).toBe('writes blocked everywhere');
    expect(describeAllowWrite(['youtube.com', 'google.com'])).toBe('writes allowed to youtube.com, google.com');
    expect(describeAllowWrite(['*'])).toBe('writes allowed to every host');
  });
});

describe('saved tabs survive a borrowed run', () => {
  function setup(): { binding: ProfileBinding; sessions: string; backup: string } {
    const userDataDir = tempDir('rastro-udd-');
    const sessions = join(userDataDir, 'Default', 'Sessions');
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, 'Session_1'), 'user tabs');
    const backup = join(tempDir('rastro-sess-'), 'profile-sessions-backup');
    const binding: ProfileBinding = { browser: 'chromium', label: 'Chromium', userDataDir, profileDirectory: 'Default', executable: '/x' };
    return { binding, sessions, backup };
  }

  test("the browser's own close-time writes are undone", () => {
    const { binding, sessions, backup } = setup();
    backupSavedSession(binding, backup);
    writeFileSync(join(sessions, 'Session_2'), 'rastro tabs');
    writeFileSync(join(sessions, 'Session_1'), 'rotated');

    expect(restoreSavedSession(binding, backup)).toBe(true);
    expect(readdirSync(sessions)).toEqual(['Session_1']);
    expect(readFileSync(join(sessions, 'Session_1'), 'utf8')).toBe('user tabs');
    expect(existsSync(backup)).toBe(false);
  });

  test('a profile with no saved tabs gets none back', () => {
    const { binding, backup } = setup();
    const empty = { ...binding, profileDirectory: 'Profile 9' };
    backupSavedSession(empty, backup);
    const created = join(binding.userDataDir, 'Profile 9', 'Sessions');
    mkdirSync(created, { recursive: true });
    writeFileSync(join(created, 'Session_3'), 'rastro tabs');

    restoreSavedSession(empty, backup);
    expect(existsSync(created)).toBe(false);
  });

  test('a backup left by a run that died is set aside, not restored over newer tabs', () => {
    const { binding, sessions, backup } = setup();
    backupSavedSession(binding, backup);
    // The run is killed; the user then uses their browser, which saves newer tabs.
    writeFileSync(join(sessions, 'Session_9'), 'newer user tabs');

    backupSavedSession(binding, backup);
    expect(readdirSync(sessions).sort()).toEqual(['Session_1', 'Session_9']);
    expect(existsSync(`${backup}.prev`)).toBe(true);
    expect(readdirSync(backup).filter((f) => f.startsWith('Session_')).sort()).toEqual(['Session_1', 'Session_9']);
  });

  test("a profile the user's browser has open again is left alone", () => {
    const { binding, sessions, backup } = setup();
    backupSavedSession(binding, backup);
    writeFileSync(join(sessions, 'Session_5'), 'the open browser');
    lockTo(binding.userDataDir, `${hostname()}-${String(process.pid)}`);

    expect(restoreSavedSession(binding, backup)).toBe(false);
    expect(readdirSync(sessions).sort()).toEqual(['Session_1', 'Session_5']);
    expect(existsSync(backup)).toBe(false);
    expect(existsSync(`${backup}.prev`)).toBe(true);
  });

  test('an unfinished backup is never trusted', () => {
    const { binding, sessions, backup } = setup();
    mkdirSync(backup, { recursive: true });
    writeFileSync(join(backup, 'Session_0'), 'half a copy');

    expect(restoreSavedSession(binding, backup)).toBe(false);
    expect(readFileSync(join(sessions, 'Session_1'), 'utf8')).toBe('user tabs');
    expect(existsSync(backup)).toBe(false);
  });
});
