import { describe, expect, test } from 'vitest';
import {
  MASK,
  SecretRegistry,
  isSensitiveFieldName,
  maskBody,
  maskCookieHeader,
  maskHeaders,
  maskSetCookie,
} from '../src/security/redact.ts';

describe('isSensitiveFieldName', () => {
  test('flags known credential field names', () => {
    for (const name of ['password', 'pwd', 'pin', 'otp', 'cvv', 'cvc', 'cardNumber', 'ssn']) {
      expect(isSensitiveFieldName(name)).toBe(true);
    }
  });

  test('flags header-style and snake_case names', () => {
    expect(isSensitiveFieldName('x-api-key')).toBe(true);
    expect(isSensitiveFieldName('x-csrf-token')).toBe(true);
    expect(isSensitiveFieldName('api_key')).toBe(true);
    expect(isSensitiveFieldName('session_id')).toBe(true);
  });

  test('does not flag unrelated words that merely contain short credential tokens', () => {
    expect(isSensitiveFieldName('shipping')).toBe(false);
    expect(isSensitiveFieldName('spinner')).toBe(false);
    expect(isSensitiveFieldName('opinion')).toBe(false);
  });

  test('flags Spanish/Portuguese credential names, with or without diacritics', () => {
    for (const name of ['clave', 'codigo', 'contrasena', 'contraseña', 'senha']) {
      expect(isSensitiveFieldName(name)).toBe(true);
    }
  });

  test('does not flag usuario (a username is not a secret)', () => {
    expect(isSensitiveFieldName('usuario')).toBe(false);
  });

  test('documented false positive: tokenizer_version is treated as sensitive', () => {
    // "token" is one of the substring patterns the spec calls out (it also
    // covers header names like x-api-key, which never split into an exact
    // "apikey" token). Applied literally, that substring rule also catches
    // "tokenizer_version". We keep it: over-masking a version string is a
    // cheaper mistake than under-masking a real token/apikey field.
    expect(isSensitiveFieldName('tokenizer_version')).toBe(true);
  });
});

describe('maskHeaders', () => {
  test('masks Authorization but keeps the scheme word', () => {
    const out = maskHeaders({ Authorization: 'Bearer abc123' }, false);
    expect(out.Authorization).toBe(`Bearer ${MASK}`);
  });

  test('masks Basic Proxy-Authorization keeping its scheme', () => {
    const out = maskHeaders({ 'Proxy-Authorization': 'Basic dXNlcjpwYXNz' }, false);
    expect(out['Proxy-Authorization']).toBe(`Basic ${MASK}`);
  });

  test('masks Cookie via maskCookieHeader', () => {
    const out = maskHeaders({ Cookie: 'a=1; b=2' }, false);
    expect(out.Cookie).toBe('a=•••; b=•••');
  });

  test('masks Set-Cookie value only, keeping attributes', () => {
    const out = maskHeaders({ 'Set-Cookie': 'sid=abc123; Path=/; HttpOnly' }, false);
    expect(out['Set-Cookie']).toBe(`sid=${MASK}; Path=/; HttpOnly`);
  });

  test('masks any header whose name is sensitive', () => {
    const out = maskHeaders({ 'x-api-key': 'sk-live-xyz', 'x-csrf-token': 'ct1' }, false);
    expect(out['x-api-key']).toBe(MASK);
    expect(out['x-csrf-token']).toBe(MASK);
  });

  test('leaves ordinary headers untouched', () => {
    const out = maskHeaders({ 'Content-Type': 'application/json' }, false);
    expect(out['Content-Type']).toBe('application/json');
  });

  test('reveal=true returns an unchanged shallow copy', () => {
    const headers = { Authorization: 'Bearer abc123', Cookie: 'a=1' };
    const out = maskHeaders(headers, true);
    expect(out).toEqual(headers);
    expect(out).not.toBe(headers);
  });
});

describe('maskCookieHeader', () => {
  test('masks every value, keeps every name', () => {
    expect(maskCookieHeader('a=1; b=2', false)).toBe('a=•••; b=•••');
  });

  test('reveal=true returns the value unchanged', () => {
    expect(maskCookieHeader('a=1; b=2', true)).toBe('a=1; b=2');
  });
});

describe('maskSetCookie', () => {
  test('masks the value, keeps name and attributes', () => {
    expect(maskSetCookie('sid=abc123; Path=/; HttpOnly', false)).toBe(
      `sid=${MASK}; Path=/; HttpOnly`,
    );
  });

  test('reveal=true returns the value unchanged', () => {
    const value = 'sid=abc123; Path=/; HttpOnly';
    expect(maskSetCookie(value, true)).toBe(value);
  });
});

describe('maskBody', () => {
  test('masks sensitive keys in a JSON object body, recursively', () => {
    const body = JSON.stringify({
      username: 'jp',
      password: 'hunter2',
      profile: { cardNumber: '4111111111111111', nickname: 'jp' },
    });
    const out = maskBody(body, 'application/json', false);
    expect(JSON.parse(out)).toEqual({
      username: 'jp',
      password: MASK,
      profile: { cardNumber: MASK, nickname: 'jp' },
    });
  });

  test('masks sensitive keys in a JSON array of objects', () => {
    const body = JSON.stringify([{ token: 'abc' }, { name: 'ok' }]);
    const out = maskBody(body, 'application/json', false);
    expect(JSON.parse(out)).toEqual([{ token: MASK }, { name: 'ok' }]);
  });

  test('sniffs JSON without a content type', () => {
    const body = JSON.stringify({ secret: 's3cr3t' });
    expect(JSON.parse(maskBody(body, undefined, false))).toEqual({ secret: MASK });
  });

  test('never throws on malformed JSON and returns it unchanged', () => {
    const body = '{ not: valid json';
    expect(() => maskBody(body, 'application/json', false)).not.toThrow();
    expect(maskBody(body, 'application/json', false)).toBe(body);
  });

  test('masks form-urlencoded pairs, preserving order and other pairs', () => {
    const body = 'username=jp&password=hunter2&remember=1';
    expect(maskBody(body, 'application/x-www-form-urlencoded', false)).toBe(
      `username=jp&password=${MASK}&remember=1`,
    );
  });

  test('sniffs form-urlencoded without a content type', () => {
    const body = 'user=jp&pwd=hunter2';
    expect(maskBody(body, undefined, false)).toBe(`user=jp&pwd=${MASK}`);
  });

  test('masks Spanish-named fields (clave, contraseña) in a JSON body', () => {
    const body = JSON.stringify({ usuario: 'jp', clave: 'hunter2', contraseña: 'hunter3' });
    const out = maskBody(body, 'application/json', false);
    expect(JSON.parse(out)).toEqual({ usuario: 'jp', clave: MASK, contraseña: MASK });
  });

  test('masks multipart parts by sensitive field name only', () => {
    const boundary = '----boundary123';
    const body = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="username"',
      '',
      'jp',
      `--${boundary}`,
      'Content-Disposition: form-data; name="password"',
      '',
      'hunter2',
      `--${boundary}--`,
      '',
    ].join('\r\n');
    const out = maskBody(body, `multipart/form-data; boundary=${boundary}`, false);
    expect(out).toContain('name="username"');
    expect(out).toContain('\r\njp\r\n');
    expect(out).toContain('name="password"');
    expect(out).toContain(`\r\n${MASK}\r\n`);
    expect(out).not.toContain('hunter2');
  });

  test('returns unrecognized content types unchanged', () => {
    const body = 'plain text with a password: hunter2';
    expect(maskBody(body, 'text/plain', false)).toBe(body);
  });

  test('reveal=true returns the body unchanged regardless of shape', () => {
    const body = JSON.stringify({ password: 'hunter2' });
    expect(maskBody(body, 'application/json', true)).toBe(body);
  });
});

describe('SecretRegistry', () => {
  test('masks every occurrence of a registered value', () => {
    const registry = new SecretRegistry();
    registry.add('hunter2');
    expect(registry.mask('login as jp with hunter2 then hunter2 again')).toBe(
      `login as jp with ${MASK} then ${MASK} again`,
    );
  });

  test('also masks the encodeURIComponent form of a value', () => {
    const registry = new SecretRegistry();
    registry.add('p@ss word');
    expect(registry.mask(`url has p%40ss%20word in it`)).toBe(`url has ${MASK} in it`);
  });

  test('also masks the form-urlencoded (%20 -> +) form of a value', () => {
    const registry = new SecretRegistry();
    registry.add('p@ss word');
    expect(registry.mask('body has p%40ss+word in it')).toBe(`body has ${MASK} in it`);
  });

  test('masks a registered value even under an unlisted field name like usuario', () => {
    const registry = new SecretRegistry();
    registry.add('jsmith');
    const body = 'usuario=jsmith&otro=1';
    expect(registry.mask(body)).toBe(`usuario=${MASK}&otro=1`);
  });

  test('masks longest match first so overlapping secrets do not leave fragments', () => {
    const registry = new SecretRegistry();
    registry.add('secret');
    registry.add('secret123');
    expect(registry.mask('token is secret123')).toBe(`token is ${MASK}`);
  });

  test('ignores empty and very short values to avoid mass-redacting common text', () => {
    const registry = new SecretRegistry();
    registry.add('');
    registry.add('ok');
    expect(registry.size).toBe(0);
    expect(registry.mask('ok, this is fine')).toBe('ok, this is fine');
  });

  test('has() reports whether a value was registered', () => {
    const registry = new SecretRegistry();
    registry.add('hunter2');
    expect(registry.has('hunter2')).toBe(true);
    expect(registry.has('other')).toBe(false);
  });

  test('reports size and returns text unchanged when nothing is registered', () => {
    const registry = new SecretRegistry();
    expect(registry.size).toBe(0);
    expect(registry.mask('nothing to mask here')).toBe('nothing to mask here');
  });
});
