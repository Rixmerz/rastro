// Named secrets in the OS keyring (libsecret), shared by every session so one
// credential can be reused by every flow. Deliberately no encrypted-file
// fallback: a second, weaker path that nobody exercises fails by leaving a file
// the user believes is protected. When the keyring is unreachable, say so.

import { spawnSync } from 'node:child_process';
import { RastroError } from '../core/types.ts';

/** Keyring attribute pair every entry carries, so `search` can enumerate ours. */
const SERVICE = 'rastro';

/** Overridable so a test can point at a binary that is not there and exercise
 * the "no keyring" path; there is no reason to change it in normal use. */
function tool(): string {
  return process.env.RASTRO_SECRET_TOOL ?? 'secret-tool';
}

/** `secret:<name>` is how a flow parameter names a vault entry. The prefix is
 * reserved so a later `env:` or `file:` source needs no format change. */
const SECRET_REF = /^secret:(.+)$/;

/** A vault entry name: dotted segments, e.g. `example.password`. Kept narrow so
 * a name can never smuggle a flag into the `secret-tool` argv. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function assertVaultName(name: string): void {
  if (!NAME.test(name)) {
    throw new RastroError(
      `invalid secret name «${name}»`,
      'letters, digits, dot, dash and underscore; must start with a letter or digit',
    );
  }
}

/** Returns the `<name>` of a `secret:<name>` reference, or null if `value` is a
 * literal. Throws when the reference is present but names nothing usable. */
export function parseSecretRef(value: string): string | null {
  const match = SECRET_REF.exec(value);
  if (!match) return null;
  const name = match[1]?.trim() ?? '';
  assertVaultName(name);
  return name;
}

function run(args: string[], input?: string): { code: number; stdout: string; stderr: string } {
  const bin = tool();
  const res = spawnSync(bin, args, { input, encoding: 'utf8' });
  if (res.error) {
    const missing = (res.error as NodeJS.ErrnoException).code === 'ENOENT';
    throw new RastroError(
      missing ? `${bin} not found` : `${bin} failed: ${res.error.message}`,
      missing ? 'install libsecret (Arch: pacman -S libsecret) and unlock your keyring' : undefined,
    );
  }
  return { code: res.status ?? 1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

export function secretSet(name: string, value: string): void {
  assertVaultName(name);
  // secret-tool reads the value from stdin, so it never appears in any argv.
  const { code, stderr } = run(['store', '--label', `rastro: ${name}`, 'service', SERVICE, 'key', name], value);
  if (code !== 0) throw new RastroError(`could not store «${name}»`, stderr.trim() || 'is the keyring unlocked?');
}

/**
 * The one place a stored value is read. Only the daemon calls this.
 *
 * A missing entry and an unreachable keyring both exit non-zero, and telling
 * them apart matters: "store it with rastro secret set" is the wrong advice
 * when the real problem is that the keyring is locked. secret-tool is silent
 * on a plain miss and writes to stderr when the bus call fails.
 */
export function secretGet(name: string): string | null {
  assertVaultName(name);
  const { code, stdout, stderr } = run(['lookup', 'service', SERVICE, 'key', name]);
  if (code === 0) return stdout;
  assertReachable(stderr);
  return null;
}

function assertReachable(stderr: string): void {
  const message = stderr.trim();
  if (message) throw new RastroError('the keyring is not reachable', message);
}

export function secretList(): string[] {
  // `search --all` splits its output: the values go to stdout, the attributes
  // — the part we actually want — to stderr. Read both, print neither: stdout
  // carries `secret = <value>` lines for every entry.
  const { code, stdout, stderr } = run(['search', '--all', 'service', SERVICE]);
  if (code !== 0) {
    // An empty vault also exits non-zero, so only a message means trouble.
    assertReachable(stderr.split('\n').filter((l) => !l.startsWith('attribute.')).join('\n'));
    return [];
  }
  const names = new Set<string>();
  for (const line of `${stderr}\n${stdout}`.split('\n')) {
    const match = /^attribute\.key\s*=\s*(.+)$/.exec(line.trim());
    if (match?.[1]) names.add(match[1]);
  }
  return [...names].sort();
}

export function secretRemove(name: string): boolean {
  assertVaultName(name);
  return run(['clear', 'service', SERVICE, 'key', name]).code === 0;
}
