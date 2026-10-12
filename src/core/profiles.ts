// External browser profiles: discovering the profiles of the browsers the user
// already has installed, binding one to a session, and the checks that keep a
// borrowed profile safe to drive — it must not be open in the user's own
// browser, and the user's saved tabs must survive Rastro using it.

import { cpSync, existsSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import type { SessionPaths } from './paths.ts';
import { RastroError } from './types.ts';

/** A Chromium-family browser whose profiles Rastro knows how to find. */
export interface KnownBrowser {
  id: string;
  label: string;
  /** User-data dir relative to `$XDG_CONFIG_HOME` (Linux). */
  linuxDir: string;
  /** User-data dir relative to `~/Library/Application Support` (macOS). */
  macDir?: string;
  executables: string[];
}

/**
 * Each profile must be driven by the browser that wrote it: Chromium opening a
 * profile last written by a newer Brave is a downgrade, and a different brand
 * cannot read the cookies another brand encrypted. So a browser and its binary
 * travel together here, and `RASTRO_CHROMIUM` never applies to a borrowed
 * profile.
 */
export const KNOWN_BROWSERS: KnownBrowser[] = [
  {
    id: 'chromium',
    label: 'Chromium',
    linuxDir: 'chromium',
    macDir: 'Chromium',
    executables: ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/Applications/Chromium.app/Contents/MacOS/Chromium'],
  },
  {
    id: 'chrome',
    label: 'Google Chrome',
    linuxDir: 'google-chrome',
    macDir: 'Google/Chrome',
    executables: ['/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
  },
  {
    id: 'brave',
    label: 'Brave',
    linuxDir: 'BraveSoftware/Brave-Browser',
    macDir: 'BraveSoftware/Brave-Browser',
    executables: ['/usr/bin/brave', '/usr/bin/brave-browser', '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'],
  },
  {
    id: 'brave-origin',
    label: 'Brave Origin',
    linuxDir: 'BraveSoftware/Brave-Origin',
    executables: ['/usr/bin/brave-origin'],
  },
  {
    id: 'edge',
    label: 'Microsoft Edge',
    linuxDir: 'microsoft-edge',
    macDir: 'Microsoft Edge',
    executables: ['/usr/bin/microsoft-edge-stable', '/usr/bin/microsoft-edge', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
  },
  {
    id: 'vivaldi',
    label: 'Vivaldi',
    linuxDir: 'vivaldi',
    executables: ['/usr/bin/vivaldi-stable', '/usr/bin/vivaldi'],
  },
];

/** The name that means "Rastro's own profile for this session". */
export const OWN_PROFILE = 'rastro';

/** What `profile.json` in a session directory holds. */
export interface ProfileBinding {
  browser: string;
  label: string;
  userDataDir: string;
  /** The profile's directory inside the user-data dir: `Default`, `Profile 1`... */
  profileDirectory: string;
  /** The name the browser shows for it, when it has one. */
  profileName?: string;
  executable: string;
  /**
   * Hosts this session may write to when `open` names none. A borrowed
   * profile carries the user's real logins, so the hosts they trust it with
   * are part of the binding rather than something to repeat on every open.
   */
  allowWrite?: string[];
}

export interface BrowserProfile {
  /** What `--profile` takes: `brave-origin:Default`. */
  ref: string;
  browser: KnownBrowser;
  userDataDir: string;
  profileDirectory: string;
  profileName?: string;
  executable?: string;
}

export function userDataDirOf(browser: KnownBrowser, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (process.platform === 'darwin') {
    return browser.macDir === undefined ? undefined : join(homedir(), 'Library', 'Application Support', browser.macDir);
  }
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), browser.linuxDir);
}

function executableOf(browser: KnownBrowser): string | undefined {
  return browser.executables.find((p) => existsSync(p));
}

/** Profile directories and display names from a user-data dir's `Local State`. */
export function readProfiles(userDataDir: string): { directory: string; name?: string }[] {
  try {
    const state = JSON.parse(readFileSync(join(userDataDir, 'Local State'), 'utf8')) as {
      profile?: { info_cache?: Record<string, { name?: string }> };
    };
    const cache = state.profile?.info_cache ?? {};
    const found = Object.entries(cache).map(([directory, info]) => ({ directory, ...(info.name ? { name: info.name } : {}) }));
    if (found.length > 0) return found;
  } catch {
    // No Local State, or one we cannot parse: fall back to what is on disk.
  }
  return existsSync(join(userDataDir, 'Default')) ? [{ directory: 'Default' }] : [];
}

/** Every profile of every known browser that has a user-data dir here. */
export function discoverProfiles(env: NodeJS.ProcessEnv = process.env): BrowserProfile[] {
  const out: BrowserProfile[] = [];
  for (const browser of KNOWN_BROWSERS) {
    const userDataDir = userDataDirOf(browser, env);
    if (userDataDir === undefined || !existsSync(userDataDir)) continue;
    const executable = executableOf(browser);
    for (const p of readProfiles(userDataDir)) {
      out.push({
        ref: `${browser.id}:${p.directory}`,
        browser,
        userDataDir,
        profileDirectory: p.directory,
        ...(p.name !== undefined ? { profileName: p.name } : {}),
        ...(executable !== undefined ? { executable } : {}),
      });
    }
  }
  return out;
}

/**
 * Resolves `browser` or `browser:profile` to a binding. The profile part
 * matches a directory (`Profile 1`) or the name the browser shows (`Personal`),
 * case-insensitively; without it, a browser with a single profile uses that
 * one and otherwise `Default`.
 */
export function resolveProfileRef(ref: string, env: NodeJS.ProcessEnv = process.env): ProfileBinding {
  const colon = ref.indexOf(':');
  const browserId = (colon === -1 ? ref : ref.slice(0, colon)).trim().toLowerCase();
  const wanted = colon === -1 ? undefined : ref.slice(colon + 1).trim();
  const browser = KNOWN_BROWSERS.find((b) => b.id === browserId);
  if (browser === undefined) {
    throw new RastroError(`unknown browser "${browserId}"`, `use one of: ${KNOWN_BROWSERS.map((b) => b.id).join(', ')}, or "${OWN_PROFILE}" for Rastro's own profile`);
  }
  const userDataDir = userDataDirOf(browser, env);
  if (userDataDir === undefined || !existsSync(userDataDir)) {
    throw new RastroError(`${browser.label} has no profile on this machine`, `looked in ${userDataDir ?? `(no known location for ${browser.label} on this platform)`}`);
  }
  const profiles = readProfiles(userDataDir);
  let match: { directory: string; name?: string } | undefined;
  if (wanted === undefined || wanted === '') {
    match = profiles.length === 1 ? profiles[0] : (profiles.find((p) => p.directory === 'Default') ?? profiles[0]);
  } else {
    const w = wanted.toLowerCase();
    match = profiles.find((p) => p.directory.toLowerCase() === w) ?? profiles.find((p) => p.name?.toLowerCase() === w);
  }
  if (match === undefined) {
    const known = profiles.map((p) => (p.name ? `${p.directory} ("${p.name}")` : p.directory)).join(', ') || 'none';
    throw new RastroError(`${browser.label} has no profile "${wanted ?? 'Default'}"`, `its profiles: ${known}`);
  }
  const executable = executableOf(browser);
  if (executable === undefined) {
    throw new RastroError(`${browser.label}'s profile exists but its browser is not installed`, `looked for ${browser.executables.join(', ')}`);
  }
  return {
    browser: browser.id,
    label: browser.label,
    userDataDir,
    profileDirectory: match.directory,
    ...(match.name !== undefined ? { profileName: match.name } : {}),
    executable,
  };
}

export function describeBinding(b: ProfileBinding): string {
  const name = b.profileName && b.profileName !== b.profileDirectory ? ` "${b.profileName}"` : '';
  return `${b.label} ${b.profileDirectory}${name}`;
}

export function describeAllowWrite(hosts: string[] | undefined): string {
  if (hosts === undefined || hosts.length === 0) return 'writes blocked everywhere';
  return hosts.includes('*') ? 'writes allowed to every host' : `writes allowed to ${hosts.join(', ')}`;
}

export function loadBinding(paths: SessionPaths): ProfileBinding | null {
  if (!existsSync(paths.profileBinding)) return null;
  try {
    return JSON.parse(readFileSync(paths.profileBinding, 'utf8')) as ProfileBinding;
  } catch {
    throw new RastroError(`unreadable profile binding ${paths.profileBinding}`, `fix or delete it, or run: rastro profile use ${OWN_PROFILE}`);
  }
}

export function saveBinding(paths: SessionPaths, binding: ProfileBinding | null): void {
  if (binding === null) {
    rmSync(paths.profileBinding, { force: true });
    return;
  }
  writeFileSync(paths.profileBinding, `${JSON.stringify(binding, null, 2)}\n`, { mode: 0o600 });
}

export function sameProfile(a: ProfileBinding | null, b: ProfileBinding | null): boolean {
  if (a === null || b === null) return a === b;
  return a.userDataDir === b.userDataDir && a.profileDirectory === b.profileDirectory;
}

export type LockState =
  | { state: 'free' }
  | { state: 'held'; pid: number; byRastro: boolean }
  | { state: 'other-host'; host: string };

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Rastro (through Playwright) always talks to its browser over a pipe; a
 * browser the user opened by hand never has that switch. Linux only. */
function launchedByRastro(pid: number): boolean {
  try {
    return readFileSync(`/proc/${String(pid)}/cmdline`, 'utf8').includes('--remote-debugging-pipe');
  } catch {
    return false;
  }
}

/**
 * Whether a browser is running on `userDataDir`. Chromium marks a profile in
 * use with a `SingletonLock` symlink whose target is `<hostname>-<pid>`. A
 * stale lock (dead pid) is Chromium's to clear on its next start, so it counts
 * as free.
 */
export function inspectLock(userDataDir: string, host: string = hostname()): LockState {
  let target: string;
  try {
    target = readlinkSync(join(userDataDir, 'SingletonLock'));
  } catch {
    return { state: 'free' };
  }
  const dash = target.lastIndexOf('-');
  const lockHost = dash === -1 ? '' : target.slice(0, dash);
  const pid = Number(target.slice(dash + 1));
  if (!Number.isInteger(pid) || pid <= 0) return { state: 'free' };
  if (lockHost !== host) return { state: 'other-host', host: lockHost };
  if (!processAlive(pid)) return { state: 'free' };
  return { state: 'held', pid, byRastro: launchedByRastro(pid) };
}

/**
 * Refuses to launch on a profile another browser process has open. Without
 * this, Chromium hands the launch over to the running instance through its
 * singleton socket and exits cleanly: the user's own window gets a stray
 * tab, and Playwright waits out its whole timeout for a browser that left.
 */
export function assertProfileFree(binding: ProfileBinding): void {
  const lock = inspectLock(binding.userDataDir);
  if (lock.state === 'free') return;
  const what = describeBinding(binding);
  if (lock.state === 'other-host') {
    throw new RastroError(
      `${what} is locked by another computer (${lock.host})`,
      `close ${binding.label} there; Rastro never removes another machine's lock`,
    );
  }
  if (lock.byRastro) {
    throw new RastroError(
      `${what} is already in use by another Rastro session (browser pid ${String(lock.pid)})`,
      'close that session first (rastro -s <name> close); one profile can back one session at a time',
    );
  }
  throw new RastroError(
    `${binding.label} is open (pid ${String(lock.pid)}) and holds this profile: ${what}`,
    `the user has to close ${binding.label} completely first — every window, plus any process left running in the background — and then retry. Rastro never closes the user's browser for them`,
  );
}

function savedSessionDir(binding: ProfileBinding): string {
  return join(binding.userDataDir, binding.profileDirectory, 'Sessions');
}

const BACKUP_COMPLETE = '.rastro-backup-complete';
const NO_SESSIONS = '.rastro-no-sessions';

/**
 * Puts the user's saved tabs back. A browser writes its open tabs as the
 * newest `Session_*`/`Tabs_*` files when it closes, so without this the
 * user's "continue where you left off" would reopen Rastro's tabs instead of
 * theirs. A backup without its completion marker was never finished and is
 * not trusted over what the profile has.
 */
export function restoreSavedSession(binding: ProfileBinding, backupDir: string): boolean {
  if (!existsSync(join(backupDir, BACKUP_COMPLETE))) {
    rmSync(backupDir, { recursive: true, force: true });
    return false;
  }
  // The user's browser may be running on the profile again by now (they
  // closed everything, which also killed Rastro's instance, then reopened
  // theirs). Its live Sessions/ is theirs: set the backup aside instead.
  if (inspectLock(binding.userDataDir).state !== 'free') {
    rmSync(`${backupDir}.prev`, { recursive: true, force: true });
    renameSync(backupDir, `${backupDir}.prev`);
    return false;
  }
  const live = savedSessionDir(binding);
  rmSync(live, { recursive: true, force: true });
  if (!existsSync(join(backupDir, NO_SESSIONS))) {
    cpSync(backupDir, live, { recursive: true, filter: (src) => !src.endsWith(BACKUP_COMPLETE) });
  }
  rmSync(backupDir, { recursive: true, force: true });
  return true;
}

/**
 * Copies the user's saved tabs aside before Rastro launches on their profile.
 *
 * A backup still present means a run that never closed cleanly (a SIGKILL, a
 * crash). It is set aside as `<backup>.prev` rather than restored: the user
 * may have used their browser since, and restoring would throw away tabs
 * newer than the backup. `.prev` keeps it recoverable by hand.
 */
export function backupSavedSession(binding: ProfileBinding, backupDir: string): void {
  if (existsSync(backupDir)) {
    rmSync(`${backupDir}.prev`, { recursive: true, force: true });
    renameSync(backupDir, `${backupDir}.prev`);
  }
  const live = savedSessionDir(binding);
  const partial = `${backupDir}.partial`;
  rmSync(partial, { recursive: true, force: true });
  if (existsSync(live)) {
    cpSync(live, partial, { recursive: true });
  } else {
    mkdirSync(partial, { recursive: true, mode: 0o700 });
    writeFileSync(join(partial, NO_SESSIONS), '');
  }
  writeFileSync(join(partial, BACKUP_COMPLETE), '');
  renameSync(partial, backupDir);
}

/** One line per discovered profile, for `rastro profiles` and `rastro_profiles`. */
export function formatProfiles(profiles: BrowserProfile[], bound: ProfileBinding | null, session: string): string {
  const lines: string[] = [];
  const own = bound === null ? '  ← this session' : '';
  lines.push(`${OWN_PROFILE}  Rastro's own profile for session "${session}"${own}`);
  for (const p of profiles) {
    const name = p.profileName && p.profileName !== p.profileDirectory ? ` "${p.profileName}"` : '';
    let state: string;
    if (p.executable === undefined) {
      state = 'browser not installed';
    } else {
      const lock = inspectLock(p.userDataDir);
      if (lock.state === 'free') state = 'free';
      else if (lock.state === 'other-host') state = `locked by ${lock.host}`;
      else if (lock.byRastro) state = `in use by a Rastro session (pid ${String(lock.pid)})`;
      else state = `IN USE: ${p.browser.label} is open (pid ${String(lock.pid)}), it must be closed before Rastro can use this profile`;
    }
    const mine =
      bound !== null && bound.userDataDir === p.userDataDir && bound.profileDirectory === p.profileDirectory
        ? `  ← this session (${describeAllowWrite(bound.allowWrite)} by default)`
        : '';
    lines.push(`${p.ref}  ${p.browser.label}${name} · ${state}${mine}`);
  }
  if (profiles.length === 0) lines.push('no other browser profiles found');
  return lines.join('\n');
}
