// Turning what people type into something the browser takes: bare hosts,
// local files and allowlist entries written with a scheme or a port.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, test } from 'vitest';
import { allowlistHost, hostAllowed, toNavigableUrl } from '../src/core/target.ts';
import { RastroError } from '../src/core/types.ts';
import { parseViewport } from '../src/engine/viewport.ts';

const dir = mkdtempSync(join(tmpdir(), 'rastro-target-'));
const page = join(dir, 'index.html');
writeFileSync(page, '<h1>hi</h1>');
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('toNavigableUrl', () => {
  test('a URL with a scheme is kept as is', () => {
    expect(toNavigableUrl('https://example.com/a?b')).toBe('https://example.com/a?b');
    expect(toNavigableUrl('about:blank')).toBe('about:blank');
    expect(toNavigableUrl('data:text/html,<p>x</p>')).toBe('data:text/html,<p>x</p>');
    expect(toNavigableUrl('file:///tmp/x.html')).toBe('file:///tmp/x.html');
  });

  test('a bare host opens over https, a local one over http', () => {
    expect(toNavigableUrl('example.com')).toBe('https://example.com');
    expect(toNavigableUrl('example.com:8443/app')).toBe('https://example.com:8443/app');
    expect(toNavigableUrl('localhost:3000')).toBe('http://localhost:3000');
    expect(toNavigableUrl('localhost:3000/login?x=1')).toBe('http://localhost:3000/login?x=1');
    expect(toNavigableUrl('127.0.0.1:8080')).toBe('http://127.0.0.1:8080');
    expect(toNavigableUrl('192.168.1.20')).toBe('http://192.168.1.20');
    expect(toNavigableUrl('app.localhost')).toBe('http://app.localhost');
    expect(toNavigableUrl('[::1]:5173')).toBe('http://[::1]:5173');
  });

  test('an absolute path becomes a file URL', () => {
    expect(toNavigableUrl(page)).toBe(pathToFileURL(page).href);
  });

  test('a relative path resolves against the caller cwd, bare names only when the file exists', () => {
    expect(toNavigableUrl('./index.html', dir)).toBe(pathToFileURL(page).href);
    expect(toNavigableUrl('index.html', dir)).toBe(pathToFileURL(page).href);
    // No such file under cwd: a name with a dot is a host.
    expect(toNavigableUrl('other.html', dir)).toBe('https://other.html');
  });

  test('~ expands to the home directory', () => {
    expect(() => toNavigableUrl('~/definitely-not-here-rastro.html')).toThrow(join(homedir(), 'definitely-not-here-rastro.html'));
  });

  test('a relative path without a cwd, or a missing file, fails with a hint', () => {
    expect(() => toNavigableUrl('./index.html')).toThrow(RastroError);
    expect(() => toNavigableUrl(join(dir, 'missing.html'))).toThrow(/no such file/);
  });
});

describe('allowlist entries', () => {
  test('a scheme, port or path is dropped down to the host', () => {
    expect(allowlistHost('localhost:3000')).toBe('localhost');
    expect(allowlistHost('http://localhost:3000/app')).toBe('localhost');
    expect(allowlistHost('Example.COM./x')).toBe('example.com');
    expect(allowlistHost('[::1]:8080')).toBe('[::1]');
    expect(allowlistHost('*')).toBe('*');
  });

  test('a write to localhost passes an allowlist written with the port', () => {
    expect(hostAllowed('localhost', ['localhost:3000'])).toBe(true);
    expect(hostAllowed('127.0.0.1', ['http://127.0.0.1:5173'])).toBe(true);
    expect(hostAllowed('evil.com', ['localhost:3000'])).toBe(false);
    expect(hostAllowed('evil.com', ['', ':3000'])).toBe(false);
  });
});

describe('parseViewport', () => {
  test('presets, sizes and reset', () => {
    expect(parseViewport('mobile')).toEqual({ width: 390, height: 844, mobile: true, scale: 1 });
    expect(parseViewport('390x844')).toEqual({ width: 390, height: 844, mobile: false, scale: 1 });
    expect(parseViewport('390x844', { mobile: true, scale: 3 })).toEqual({ width: 390, height: 844, mobile: true, scale: 3 });
    expect(parseViewport('desktop')).toBeNull();
    expect(parseViewport('reset')).toBeNull();
  });

  test('a bad size fails with the accepted forms', () => {
    expect(() => parseViewport('big')).toThrow(/bad viewport/);
    expect(() => parseViewport('mobile', { scale: 9 })).toThrow(/scale/);
  });
});
