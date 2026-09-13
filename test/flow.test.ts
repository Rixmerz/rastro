import { expect, test } from 'vitest';
import type { ActionRecord, RequestRecord } from '../src/core/types.ts';
import {
  actionsToFlow,
  expectationFromEffects,
  matchesRequestPattern,
  parseFlow,
  parseRequestPattern,
  stringifyFlow,
  substitute,
  type Flow,
} from '../src/flow/format.ts';
import { bundleToLocator, flowToPlaywright } from '../src/flow/export-playwright.ts';
import { importChromeRecording, selectorsToTarget } from '../src/flow/import-chrome.ts';

function request(overrides: Partial<RequestRecord> & Pick<RequestRecord, 'id' | 'url' | 'method'>): RequestRecord {
  return {
    cdpId: overrides.id,
    tabId: 't1',
    t: 0,
    resourceType: 'xhr',
    initiator: { type: 'script', stackHasInterval: false },
    requestHeaders: {},
    timing: { startMs: 0 },
    origin: 'page',
    isNavigation: false,
    actionId: 1,
    bucket: 'attributed',
    ...overrides,
  };
}

function action(overrides: Partial<ActionRecord> & Pick<ActionRecord, 'id' | 'kind' | 'urlBefore'>): ActionRecord {
  return {
    source: 'human',
    tabId: 't1',
    secret: false,
    t0: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// parse / stringify round trip and validation errors
// ---------------------------------------------------------------------------

test('parseFlow / stringifyFlow round trip a login flow', () => {
  const yaml = `
name: login
params:
  password:
    secret: true
steps:
  - fill:
      label: Email
    value: a@b.com
    id: s1
  - fill:
      label: Password
    value: "{{password}}"
    id: s2
  - click:
      role: button
      name: Entrar
    expect:
      url: /panel
      requests:
        - "POST /api/login 2xx"
    id: s3
`;
  const flow = parseFlow(yaml);
  expect(flow.name).toBe('login');
  expect(flow.params).toEqual({ password: { secret: true } });
  expect(flow.steps).toHaveLength(3);
  expect(flow.steps[2]).toMatchObject({ click: { role: 'button', name: 'Entrar' } });

  const restringified = stringifyFlow(flow);
  const reparsed = parseFlow(restringified);
  expect(reparsed).toEqual(flow);
});

test('stringifyFlow orders step keys: kind, value, expect, id, note', () => {
  const flow: Flow = {
    name: 'x',
    steps: [
      { fill: { css: '#a' }, value: 'v', expect: { url: '/y' }, id: 's1', note: 'n' },
    ],
  };
  const yaml = stringifyFlow(flow);
  const fillIdx = yaml.indexOf('fill:');
  const valueIdx = yaml.indexOf('value:');
  const expectIdx = yaml.indexOf('expect:');
  const idIdx = yaml.indexOf('id:');
  const noteIdx = yaml.indexOf('note:');
  expect(fillIdx).toBeLessThan(valueIdx);
  expect(valueIdx).toBeLessThan(expectIdx);
  expect(expectIdx).toBeLessThan(idIdx);
  expect(idIdx).toBeLessThan(noteIdx);
});

test('parseFlow reports the step path in validation errors', () => {
  const yaml = `
name: x
steps:
  - open: https://a
  - goto: https://b
  - click: {}
`;
  expect(() => parseFlow(yaml)).toThrow('steps[2].click: target needs at least one locator field');
});

test('parseFlow rejects a step with no recognizable kind', () => {
  const yaml = `
name: x
steps:
  - id: s1
`;
  expect(() => parseFlow(yaml)).toThrow(/steps\[0\]: missing step kind/);
});

test('parseFlow rejects an if step whose then is not a list', () => {
  const yaml = `
name: x
steps:
  - if:
      text: "Aceptar"
    then: not-a-list
`;
  expect(() => parseFlow(yaml)).toThrow('steps[0].then: expected a list of steps');
});

test('parseFlow accepts a conditional step with then/else', () => {
  const yaml = `
name: x
steps:
  - if:
      text: "Aceptar cookies"
    then:
      - click:
          role: button
          name: Aceptar
    else:
      - wait:
          ms: 100
`;
  const flow = parseFlow(yaml);
  const step = flow.steps[0]!;
  expect(step).toMatchObject({ if: { text: 'Aceptar cookies' } });
  if ('if' in step) {
    expect(step.then).toHaveLength(1);
    expect(step.else).toHaveLength(1);
  }
});

// ---------------------------------------------------------------------------
// substitute
// ---------------------------------------------------------------------------

test('substitute replaces {{param}} placeholders', () => {
  expect(substitute('hello {{name}}', { name: 'world' })).toBe('hello world');
});

test('substitute throws on an unknown param', () => {
  expect(() => substitute('{{missing}}', {})).toThrow('unknown param missing');
});

// ---------------------------------------------------------------------------
// request pattern matching
// ---------------------------------------------------------------------------

test('parseRequestPattern parses a status class', () => {
  expect(parseRequestPattern('POST /api/login 2xx')).toEqual({
    method: 'POST',
    path: '/api/login',
    status: { klass: 2 },
  });
});

test('parseRequestPattern parses an exact status', () => {
  expect(parseRequestPattern('GET /api/me 200')).toEqual({
    method: 'GET',
    path: '/api/me',
    status: { exact: 200 },
  });
});

test('matchesRequestPattern matches by status class', () => {
  expect(matchesRequestPattern('POST /api/login 2xx', { method: 'post', url: 'https://x/api/login', status: 201 })).toBe(true);
  expect(matchesRequestPattern('POST /api/login 2xx', { method: 'post', url: 'https://x/api/login', status: 401 })).toBe(false);
});

test('matchesRequestPattern matches an exact status', () => {
  expect(matchesRequestPattern('GET /api/me 200', { method: 'GET', url: 'https://x/api/me', status: 200 })).toBe(true);
  expect(matchesRequestPattern('GET /api/me 200', { method: 'GET', url: 'https://x/api/me', status: 304 })).toBe(false);
});

test('matchesRequestPattern matches a glob path', () => {
  expect(matchesRequestPattern('GET /api/users/* 2xx', { method: 'GET', url: 'https://x/api/users/42', status: 200 })).toBe(true);
  expect(matchesRequestPattern('GET /api/users/* 2xx', { method: 'GET', url: 'https://x/other', status: 200 })).toBe(false);
});

// ---------------------------------------------------------------------------
// expectationFromEffects
// ---------------------------------------------------------------------------

test('expectationFromEffects derives url and request expectations from a login action', () => {
  const loginAction = action({
    id: 1,
    kind: 'click',
    urlBefore: 'https://app.test/login',
    urlAfter: 'https://app.test/panel',
  });
  const attributed = [
    request({ id: 'r1', method: 'POST', url: 'https://app.test/api/login', status: 200, resourceType: 'xhr' }),
  ];
  expect(expectationFromEffects(loginAction, attributed)).toEqual({
    url: '/panel',
    requests: ['POST /api/login 2xx'],
  });
});

test('expectationFromEffects returns undefined with no url change and no interesting requests', () => {
  const clickAction = action({ id: 1, kind: 'click', urlBefore: 'https://app.test/panel' });
  const attributed = [
    request({ id: 'r1', method: 'GET', url: 'https://app.test/img.png', status: 200, resourceType: 'image' }),
  ];
  expect(expectationFromEffects(clickAction, attributed)).toBeUndefined();
});

// ---------------------------------------------------------------------------
// actionsToFlow
// ---------------------------------------------------------------------------

test('actionsToFlow turns a secret password action into a param', () => {
  const actions: ActionRecord[] = [
    action({ id: 1, kind: 'open', urlBefore: '', urlAfter: 'https://app.test/login' }),
    action({
      id: 2,
      kind: 'fill',
      urlBefore: 'https://app.test/login',
      target: { label: 'Password', tag: 'input', inputType: 'password' },
      value: '•••',
      secret: true,
    }),
    action({
      id: 3,
      kind: 'click',
      urlBefore: 'https://app.test/login',
      urlAfter: 'https://app.test/panel',
      target: { role: 'button', name: 'Entrar' },
    }),
  ];
  const attributedByAction = new Map<number, RequestRecord[]>([
    [3, [request({ id: 'r1', method: 'POST', url: 'https://app.test/api/login', status: 200, resourceType: 'xhr' })]],
  ]);

  const flow = actionsToFlow('login', actions, attributedByAction);

  expect(flow.steps).toHaveLength(3);
  expect(flow.params).toEqual({ password: { secret: true } });
  const fillStep = flow.steps[1]!;
  if ('fill' in fillStep) {
    expect(fillStep.value).toBe('{{password}}');
  } else {
    throw new Error('expected a fill step');
  }
  const clickStep = flow.steps[2]!;
  if ('click' in clickStep) {
    expect(clickStep.expect).toEqual({ url: '/panel', requests: ['POST /api/login 2xx'] });
  } else {
    throw new Error('expected a click step');
  }
  expect(flow.steps.every((s) => s.id !== undefined)).toBe(true);
});

test('actionsToFlow skips actions with an error and unmapped kinds', () => {
  const actions: ActionRecord[] = [
    action({ id: 1, kind: 'click', urlBefore: 'https://a', target: { css: '#a' }, error: 'timeout' }),
    action({ id: 2, kind: 'submit', urlBefore: 'https://a' }),
    action({ id: 3, kind: 'scroll', urlBefore: 'https://a' }),
  ];
  const flow = actionsToFlow('x', actions, new Map());
  expect(flow.steps).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// Playwright export
// ---------------------------------------------------------------------------

function loginFlow(): Flow {
  return {
    name: 'login',
    params: { password: { secret: true } },
    steps: [
      { open: 'https://app.test/login', id: 's1' },
      { fill: { label: 'Password' }, value: '{{password}}', id: 's2' },
      {
        click: { role: 'button', name: 'Entrar' },
        expect: { url: '/panel', requests: ['POST /api/login 2xx'] },
        id: 's3',
      },
    ],
  };
}

test('bundleToLocator prefers role+name', () => {
  expect(bundleToLocator({ role: 'button', name: 'Entrar' })).toBe(
    `page.getByRole("button", { name: "Entrar", exact: true })`,
  );
});

test('bundleToLocator falls back through label, testId, placeholder, text, css, id', () => {
  expect(bundleToLocator({ label: 'Email' })).toBe(`page.getByLabel("Email")`);
  expect(bundleToLocator({ testId: 'submit' })).toBe(`page.getByTestId("submit")`);
  expect(bundleToLocator({ placeholder: 'Search' })).toBe(`page.getByPlaceholder("Search")`);
  expect(bundleToLocator({ text: 'Hello' })).toBe(`page.getByText("Hello", { exact: true })`);
  expect(bundleToLocator({ css: '.btn' })).toBe(`page.locator(".btn")`);
  expect(bundleToLocator({ id: 'submit' })).toBe(`page.locator("#submit")`);
});

test('bundleToLocator wraps a frame target in frameLocator', () => {
  const locator = bundleToLocator({ role: 'button', name: 'Pay', frame: 'https://pay.example.com/checkout' });
  expect(locator).toBe(
    `page.frameLocator("iframe[src*=\\"pay.example.com/checkout\\"]").getByRole("button", { name: "Pay", exact: true })`,
  );
});

test('flowToPlaywright exports a 3-step login flow', () => {
  const spec = flowToPlaywright(loginFlow());
  expect(spec).toContain(`import { test, expect } from '@playwright/test';`);
  expect(spec).toContain('const password = process.env.PASSWORD;');
  expect(spec).not.toMatch(/PASSWORD.*\?\?/);
  expect(spec).toContain(`page.getByRole("button", { name: "Entrar", exact: true })`);
  expect(spec).toContain('page.waitForResponse((r) => r.request().method() === "POST"');
  expect(spec).toContain("new URL(r.url()).pathname === \"/api/login\"");
  expect(spec).toContain('r.status() >= 200 && r.status() < 300');
  expect(spec).toContain('await expect(page).toHaveURL(new RegExp("/panel" + \'(\\?|$|#)\'));');
});

test('flowToPlaywright uses an exact status check for a non-class request pattern', () => {
  const flow: Flow = {
    name: 'x',
    steps: [
      {
        click: { role: 'button', name: 'Refresh' },
        expect: { requests: ['GET /api/me 200'] },
        id: 's1',
      },
    ],
  };
  const spec = flowToPlaywright(flow);
  expect(spec).toContain('r.status() === 200');
  expect(spec).not.toContain('r.status() >=');
});

test('flowToPlaywright gives a non-secret param a default from process.env', () => {
  const flow: Flow = {
    name: 'x',
    params: { username: { default: 'guest' } },
    steps: [{ fill: { label: 'User' }, value: '{{username}}', id: 's1' }],
  };
  const spec = flowToPlaywright(flow);
  expect(spec).toContain(`const username = process.env.USERNAME ?? "guest";`);
});

test('flowToPlaywright exports if/else as a conditional block', () => {
  const flow: Flow = {
    name: 'cookies',
    steps: [
      {
        if: { text: 'Aceptar cookies' },
        then: [{ click: { role: 'button', name: 'Aceptar' }, id: 's2' }],
        else: [{ click: { role: 'button', name: 'Rechazar' }, id: 's3' }],
        id: 's1',
      },
    ],
  };
  const spec = flowToPlaywright(flow);
  expect(spec).toContain(`if (await page.getByText("Aceptar cookies").isVisible()) {`);
  expect(spec).toContain(`page.getByRole("button", { name: "Aceptar", exact: true })`);
  expect(spec).toContain('} else {');
  expect(spec).toContain(`page.getByRole("button", { name: "Rechazar", exact: true })`);
});

// ---------------------------------------------------------------------------
// Chrome DevTools Recorder import
// ---------------------------------------------------------------------------

test('selectorsToTarget reads aria role/name and a plain css selector', () => {
  const target = selectorsToTarget([['aria/Entrar[role="button"]'], ['#submit']]);
  expect(target.role).toBe('button');
  expect(target.name).toBe('Entrar');
  expect(target.css).toBe('#submit');
  expect(target.id).toBe('submit');
});

test('importChromeRecording converts navigate + change + click + keyDown', () => {
  const recording = {
    title: 'Login recording',
    steps: [
      { type: 'setViewport', width: 1280, height: 720 },
      { type: 'navigate', url: 'https://app.test/login' },
      {
        type: 'change',
        selectors: [['#email']],
        value: 'a@b.com',
      },
      {
        type: 'click',
        selectors: [['aria/Entrar[role="button"]'], ['#submit']],
        assertedEvents: [{ type: 'navigation', url: 'https://app.test/panel' }],
      },
      { type: 'keyDown', key: 'Enter' },
      { type: 'keyUp', key: 'Enter' },
    ],
  };

  const flow = importChromeRecording(recording);
  expect(flow.name).toBe('Login recording');
  expect(flow.steps[0]).toMatchObject({ open: 'https://app.test/login' });
  expect(flow.steps[1]).toMatchObject({ fill: { css: '#email' }, value: 'a@b.com' });
  const clickStep = flow.steps[2]!;
  expect(clickStep).toMatchObject({ click: { role: 'button', name: 'Entrar', css: '#submit' } });
  if ('click' in clickStep) {
    expect(clickStep.expect).toEqual({ url: '/panel' });
  }
  expect(flow.steps[3]).toMatchObject({ press: 'Enter' });
  expect(flow.steps).toHaveLength(4);
});

test('importChromeRecording rejects a recording missing steps', () => {
  expect(() => importChromeRecording({ title: 'x' })).toThrow(/invalid Chrome recording/);
});
