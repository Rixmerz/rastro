import { describe, expect, test } from 'vitest';
import { attributeEvent, attributeRequests, isAnalyticsHost, urlTemplate, type ActionWindow } from '../src/attribution/attribute.ts';
import type { Initiator, RequestRecord } from '../src/core/types.ts';

let seq = 0;

function makeRequest(overrides: Partial<RequestRecord> & { url: string; t: number }): RequestRecord {
  seq += 1;
  const initiator: Initiator = { type: 'other', stackHasInterval: false, ...overrides.initiator };
  return {
    id: `r${seq}`,
    cdpId: `c${seq}`,
    tabId: 'tab1',
    method: 'GET',
    resourceType: 'xhr',
    requestHeaders: {},
    timing: { startMs: overrides.t },
    origin: 'page',
    isNavigation: false,
    actionId: null,
    bucket: null,
    ...overrides,
    initiator,
  };
}

function makeAction(overrides: Partial<ActionWindow> = {}): ActionWindow {
  return { id: 1, t0: 1000, t1: 2000, tabId: 'tab1', navigated: false, openedTabIds: [], ...overrides };
}

describe('urlTemplate', () => {
  test('replaces numeric, uuid, hex and base64-ish path segments with :id', () => {
    expect(urlTemplate('https://example.com/users/123/profile')).toBe('https://example.com/users/:id/profile');
    expect(urlTemplate('https://example.com/orders/550e8400-e29b-41d4-a716-446655440000')).toBe(
      'https://example.com/orders/:id',
    );
    expect(urlTemplate('https://example.com/blob/deadbeef1234')).toBe('https://example.com/blob/:id');
    expect(urlTemplate('https://example.com/t/aZ9bQ7xK2mN4pR8s')).toBe('https://example.com/t/:id');
  });

  test('keeps query keys sorted and drops values, drops fragment', () => {
    expect(urlTemplate('https://example.com/api/poll?t=123&b=2#frag')).toBe('https://example.com/api/poll?b&t');
    expect(urlTemplate('https://example.com/api/poll')).toBe('https://example.com/api/poll');
  });

  test('returns a malformed URL unchanged', () => {
    expect(urlTemplate('not a url')).toBe('not a url');
  });
});

describe('isAnalyticsHost', () => {
  test('matches a listed host and any subdomain of it', () => {
    expect(isAnalyticsHost('google-analytics.com')).toBe(true);
    expect(isAnalyticsHost('www.google-analytics.com')).toBe(true);
    expect(isAnalyticsHost('region1.analytics.google.com')).toBe(true);
  });

  test('does not match an unrelated host', () => {
    expect(isAnalyticsHost('example.com')).toBe(false);
  });
});

describe('attributeRequests', () => {
  test('polling with regular spacing and 3+ prior occurrences is background', () => {
    const action = makeAction();
    const history: RequestRecord[] = [];
    // 7 prior occurrences every 300ms with small jitter, ending shortly before t0.
    for (let i = 0; i < 7; i++) {
      const jitter = i % 2 === 0 ? 5 : -5;
      history.push(makeRequest({ url: `https://app.example/api/poll?t=${i}`, t: 100 + i * 300 + jitter }));
    }
    const pollInWindow = makeRequest({ url: 'https://app.example/api/poll?t=99', t: 1050 });
    const click = makeRequest({
      url: 'https://app.example/api/do',
      t: 1010,
      initiator: { type: 'script', stackHasInterval: false },
    });

    const buckets = attributeRequests(action, [pollInWindow, click], history);

    expect(buckets.get(pollInWindow.id)).toBe('background');
    expect(buckets.get(click.id)).toBe('attributed');
  });

  test('only 2 prior occurrences does not count as recurrence', () => {
    const action = makeAction();
    const history: RequestRecord[] = [
      makeRequest({ url: 'https://app.example/api/poll?t=1', t: 100 }),
      makeRequest({ url: 'https://app.example/api/poll?t=2', t: 400 }),
    ];
    const req = makeRequest({ url: 'https://app.example/api/poll?t=3', t: 700 });

    const buckets = attributeRequests(action, [req], history);

    // Not background via recurrence; falls through to unattributed since
    // initiator is 'other' with no navigation/redirect.
    expect(buckets.get(req.id)).toBe('unattributed');
  });

  test('setInterval stack marks the request background', () => {
    const action = makeAction();
    const req = makeRequest({
      url: 'https://app.example/api/tick',
      t: 1100,
      initiator: { type: 'script', stackHasInterval: true },
    });

    const buckets = attributeRequests(action, [req], []);

    expect(buckets.get(req.id)).toBe('background');
  });

  test('beacon and ping resource types are background', () => {
    const action = makeAction();
    const beacon = makeRequest({ url: 'https://app.example/beacon', t: 1100, resourceType: 'beacon' });
    const ping = makeRequest({ url: 'https://app.example/ping', t: 1100, resourceType: 'ping' });

    const buckets = attributeRequests(action, [beacon, ping], []);

    expect(buckets.get(beacon.id)).toBe('background');
    expect(buckets.get(ping.id)).toBe('background');
  });

  test('analytics host with subdomain is background', () => {
    const action = makeAction();
    const req = makeRequest({
      url: 'https://region1.analytics.google.com/collect',
      t: 1100,
      initiator: { type: 'script', stackHasInterval: false },
    });

    const buckets = attributeRequests(action, [req], []);

    expect(buckets.get(req.id)).toBe('background');
  });

  test('redirect chain inherits attributed from the first request', () => {
    const action = makeAction();
    const post = makeRequest({
      url: 'https://app.example/login',
      t: 1010,
      method: 'POST',
      initiator: { type: 'script', stackHasInterval: false },
    });
    const redirect = makeRequest({
      url: 'https://app.example/panel',
      t: 1020,
      redirectedFrom: post.id,
      initiator: { type: 'redirect', stackHasInterval: false },
    });
    const doc = makeRequest({
      url: 'https://app.example/panel',
      t: 1030,
      redirectedFrom: redirect.id,
      isNavigation: true,
      initiator: { type: 'other', stackHasInterval: false },
    });

    const buckets = attributeRequests(action, [post, redirect, doc], []);

    expect(buckets.get(post.id)).toBe('attributed');
    expect(buckets.get(redirect.id)).toBe('attributed');
    expect(buckets.get(doc.id)).toBe('attributed');
  });

  test('a request initiated by a background request inherits background', () => {
    const action = makeAction();
    const beacon = makeRequest({ url: 'https://app.example/beacon', t: 1100, resourceType: 'beacon' });
    const child = makeRequest({
      url: 'https://app.example/beacon/ack',
      t: 1110,
      initiator: { type: 'script', stackHasInterval: false, parentRequestId: beacon.id },
    });

    const buckets = attributeRequests(action, [beacon, child], []);

    expect(buckets.get(child.id)).toBe('background');
  });

  test('worker origin is unattributed', () => {
    const action = makeAction();
    const req = makeRequest({
      url: 'https://app.example/worker-fetch',
      t: 1100,
      origin: 'worker',
      initiator: { type: 'script', stackHasInterval: false },
    });

    const buckets = attributeRequests(action, [req], []);

    expect(buckets.get(req.id)).toBe('unattributed');
  });

  test('a request in a tab that is neither the action tab nor an opened tab is unattributed', () => {
    const action = makeAction({ openedTabIds: ['tab2'] });
    const req = makeRequest({
      url: 'https://app.example/other-tab',
      t: 1100,
      tabId: 'tab3',
      initiator: { type: 'script', stackHasInterval: false },
    });

    const buckets = attributeRequests(action, [req], []);

    expect(buckets.get(req.id)).toBe('unattributed');
  });

  test('a request in a tab opened by the action is attributed', () => {
    const action = makeAction({ openedTabIds: ['tab2'] });
    const req = makeRequest({
      url: 'https://app.example/opened-tab',
      t: 1100,
      tabId: 'tab2',
      initiator: { type: 'script', stackHasInterval: false },
    });

    const buckets = attributeRequests(action, [req], []);

    expect(buckets.get(req.id)).toBe('attributed');
  });

  test('the navigation document of the action tab is attributed even on an analytics-looking path', () => {
    const action = makeAction();
    const doc = makeRequest({
      url: 'https://app.example/google-analytics.com/panel',
      t: 1010,
      isNavigation: true,
      initiator: { type: 'other', stackHasInterval: false },
    });

    const buckets = attributeRequests(action, [doc], []);

    expect(buckets.get(doc.id)).toBe('attributed');
  });

  test('an "other" initiator with no navigation and no redirect is unattributed', () => {
    const action = makeAction();
    const req = makeRequest({ url: 'https://app.example/mystery', t: 1100 });

    const buckets = attributeRequests(action, [req], []);

    expect(buckets.get(req.id)).toBe('unattributed');
  });
});

describe('attributeEvent', () => {
  const action = makeAction({ openedTabIds: ['tab2'] });

  test('scoped event types are attributed on the action tab or an opened tab', () => {
    expect(attributeEvent(action, 'console', 'tab1', {})).toBe('attributed');
    expect(attributeEvent(action, 'dom_delta', 'tab2', {})).toBe('attributed');
    expect(attributeEvent(action, 'cookie_diff', 'tab3', {})).toBe('unattributed');
  });

  test('tab_close and crash are attributed only on the action tab', () => {
    expect(attributeEvent(action, 'tab_close', 'tab1', {})).toBe('attributed');
    expect(attributeEvent(action, 'crash', 'tab2', {})).toBe('unattributed');
  });

  test('ws_frames is always background', () => {
    expect(attributeEvent(action, 'ws_frames', 'tab1', {})).toBe('background');
  });

  test('action_start and action_end are always attributed', () => {
    expect(attributeEvent(action, 'action_start', 'tab1', {})).toBe('attributed');
    expect(attributeEvent(action, 'action_end', 'tab9', {})).toBe('attributed');
  });
});
