// The vault and the flow home: the pure parts, the CLI's refusals (which are
// the security-relevant behaviour), and one real keyring round trip that is
// skipped where there is no keyring.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { assertVaultName, parseSecretRef, secretGet, secretList, secretRemove, secretSet } from '../src/security/vault.ts';
import { flowsDir, resolveFlowRef } from '../src/core/paths.ts';
import { RastroError } from '../src/core/types.ts';

const BIN = new URL('../bin/rastro.js', import.meta.url).pathname;

function runCli(args: string[]): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { env: process.env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => resolvePromise({ stdout, stderr, code }));
  });
}

describe('secret references', () => {
  test('a literal is not a reference', () => {
    expect(parseSecretRef('hunter2')).toBeNull();
    expect(parseSecretRef('secretive')).toBeNull();
  });

  test('secret:<name> yields the entry name', () => {
    expect(parseSecretRef('secret:example.password')).toBe('example.password');
    expect(parseSecretRef('secret: example.password ')).toBe('example.password');
  });

  test('a name that could smuggle a flag into argv is rejected', () => {
    expect(() => parseSecretRef('secret:--label')).toThrow(RastroError);
    expect(() => assertVaultName('a b')).toThrow(RastroError);
    expect(() => assertVaultName('')).toThrow(RastroError);
  });
});

describe('flow home', () => {
  const made: string[] = [];
  afterEach(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
    delete process.env.XDG_CONFIG_HOME;
  });

  test('a bare name resolves under the flow home with .yaml appended', () => {
    const config = mkdtempSync(join(tmpdir(), 'rastro-cfg-'));
    made.push(config);
    process.env.XDG_CONFIG_HOME = config;
    expect(resolveFlowRef('login-example')).toBe(join(config, 'rastro', 'flows', 'login-example.yaml'));
    expect(flowsDir()).toBe(join(config, 'rastro', 'flows'));
  });

  test('anything path-shaped stays a path', () => {
    const config = mkdtempSync(join(tmpdir(), 'rastro-cfg-'));
    made.push(config);
    process.env.XDG_CONFIG_HOME = config;
    expect(resolveFlowRef('./tmp/x.yaml')).not.toContain('rastro/flows');
    expect(resolveFlowRef('x.yaml')).not.toContain('rastro/flows');
    expect(resolveFlowRef('a/b')).not.toContain('rastro/flows');
  });

  test('a bare name that is not a usable filename is refused', () => {
    expect(() => resolveFlowRef('..')).toThrow(RastroError);
    expect(() => resolveFlowRef('a b')).toThrow(RastroError);
  });
});

describe('secret CLI refusals', () => {
  test('the value cannot be given as an argument', async () => {
    const { code, stderr } = await runCli(['secret', 'set', 'test.name', 'hunter2']);
    expect(code).toBe(1);
    expect(stderr).toContain('cannot be passed as an argument');
    // and it must not have leaked into the message
    expect(stderr).not.toContain('hunter2');
  });

  test('get refuses to print without --reveal', async () => {
    const { code, stdout, stderr } = await runCli(['secret', 'get', 'test.name']);
    expect(code).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('refusing to print a secret');
  });

  test('list prints names, never values', async () => {
    const { code, stdout } = await runCli(['secret', 'list']);
    expect(code).toBe(0);
    expect(stdout).not.toContain('secret =');
  });

  test('no secret file is written anywhere', async () => {
    await runCli(['secret', 'list']);
    expect(existsSync(join(process.cwd(), '.rastro', 'secrets'))).toBe(false);
  });
});

// The round trip against the real keyring. It writes and deletes one entry
// under an obviously-ours name; skipped where there is no keyring, which is
// most CI. This is the test that catches what unit tests could not: secret-tool
// prints entry attributes on stderr and values on stdout, so a lister that
// reads only stdout finds nothing and reports an empty vault.
const hasKeyring = spawnSync('sh', ['-c', 'command -v secret-tool'], { stdio: 'ignore' }).status === 0;

describe.runIf(hasKeyring)('keyring round trip', () => {
  const NAME = 'rastro.vault-test';
  afterEach(() => {
    secretRemove(NAME);
  });

  test('set, list, read back, remove', () => {
    secretSet(NAME, 'value-under-test');
    expect(secretList()).toContain(NAME);
    expect(secretGet(NAME)).toBe('value-under-test');
    expect(JSON.stringify(secretList())).not.toContain('value-under-test');
    expect(secretRemove(NAME)).toBe(true);
    expect(secretGet(NAME)).toBeNull();
  });
});

describe('no keyring', () => {
  afterEach(() => {
    delete process.env.RASTRO_SECRET_TOOL;
  });

  test('a missing secret-tool fails loudly and never falls back to a file', () => {
    process.env.RASTRO_SECRET_TOOL = '/nonexistent/secret-tool';
    expect(() => secretSet('x.y', 'v')).toThrow(/not found/);
    try {
      secretSet('x.y', 'v');
    } catch (err) {
      expect((err as RastroError).hint).toContain('libsecret');
    }
  });
});

describe('asking for a value with no terminal', () => {
  test('says how to run it by hand when no terminal emulator exists', async () => {
    // No tty (spawned by vitest) and nothing on PATH to open one: the command
    // must explain itself rather than silently read the agent's stdin, which
    // is the one thing the prompt exists to prevent.
    const child = spawn(process.execPath, [BIN, 'secret', 'set', 'test.no-term'], {
      env: { ...process.env, PATH: '/nonexistent' },
    });
    let stderr = '';
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    const code = await new Promise<number | null>((r) => child.on('close', r));

    expect(code).toBe(1);
    expect(stderr).toContain('no terminal');
    expect(stderr).toContain('rastro secret set test.no-term');
  }, 20000);
});
