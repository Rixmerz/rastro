import { describe, expect, test } from 'vitest';
import { toHar } from '../src/export/har.ts';
import { toPerfetto } from '../src/export/perfetto.ts';
import { MASK } from '../src/security/redact.ts';
import type { ActionRecord, RequestRecord, TraceEvent } from '../src/core/types.ts';

const STARTED_AT = '2026-01-01T00:00:00.000Z';

function makeRequest(overrides: Partial<RequestRecord> = {}): RequestRecord {
  return {
    id: 'r1',
    cdpId: 'cdp1',
    tabId: 'tab1',
    t: 100,
    method: 'GET',
    url: 'https://example.com/api?token=abc',
    resourceType: 'fetch',
    status: 200,
    statusText: 'OK',
    initiator: { type: 'script', stackHasInterval: false },
    requestHeaders: { Authorization: 'Bearer secret', 'User-Agent': 'test' },
    responseHeaders: { 'content-type': 'application/json' },
    timing: { startMs: 100, responseMs: 150, endMs: 160 },
    origin: 'page',
    isNavigation: false,
    actionId: 1,
    bucket: 'attributed',
    ...overrides,
  };
}

function makeAction(overrides: Partial<ActionRecord> = {}): ActionRecord {
  return {
    id: 1,
    source: 'agent',
    kind: 'click',
    tabId: 'tab1',
    targetName: 'Submit',
    secret: false,
    t0: 0,
    t1: 200,
    urlBefore: 'https://example.com/',
    ...overrides,
  };
}

describe('toHar', () => {
  test('produces one entry per request with timings and status', () => {
    const har = toHar({
      startedAt: STARTED_AT,
      creatorVersion: '0.1.0',
      requests: [makeRequest()],
      actions: [makeAction()],
    });
    const log = har.log as { entries: Record<string, unknown>[]; version: string; creator: Record<string, unknown> };
    expect(log.version).toBe('1.2');
    expect(log.creator).toEqual({ name: 'rastro', version: '0.1.0' });
    expect(log.entries).toHaveLength(1);
    const entry = log.entries[0]!;
    expect(entry['startedDateTime']).toBe('2026-01-01T00:00:00.100Z');
    expect(entry['pageref']).toBe('action_1');
    expect((entry['response'] as Record<string, unknown>)['status']).toBe(200);
    expect(entry['timings']).toEqual({ send: 0, wait: 50, receive: 10 });
    expect(entry['time']).toBe(60);
  });

  test('failed requests report status 0', () => {
    const har = toHar({
      startedAt: STARTED_AT,
      creatorVersion: '0.1.0',
      requests: [makeRequest({ status: undefined, failed: 'net::ERR_FAILED' })],
      actions: [],
    });
    const entry = har.log['entries'] as Record<string, unknown>[];
    expect((entry[0]!['response'] as Record<string, unknown>)['status']).toBe(0);
  });

  test('redirect location surfaces on redirectURL', () => {
    const har = toHar({
      startedAt: STARTED_AT,
      creatorVersion: '0.1.0',
      requests: [
        makeRequest({
          responseHeaders: { location: 'https://example.com/next' },
        }),
      ],
      actions: [],
    });
    const entry = (har.log['entries'] as Record<string, unknown>[])[0]!;
    expect((entry['response'] as Record<string, unknown>)['redirectURL']).toBe('https://example.com/next');
  });

  test('mask is applied to request and response headers', () => {
    const har = toHar({
      startedAt: STARTED_AT,
      creatorVersion: '0.1.0',
      requests: [makeRequest()],
      actions: [],
      mask: (headers) =>
        Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, k.toLowerCase() === 'authorization' ? '***' : v])),
    });
    const entry = (har.log['entries'] as Record<string, unknown>[])[0]!;
    const headers = (entry['request'] as Record<string, unknown>)['headers'] as { name: string; value: string }[];
    const auth = headers.find((h) => h.name === 'Authorization');
    expect(auth?.value).toBe('***');
  });

  test('with no mask fn, defaults to masking Authorization/Cookie headers and a urlencoded password body', () => {
    const har = toHar({
      startedAt: STARTED_AT,
      creatorVersion: '0.1.0',
      requests: [
        makeRequest({
          requestHeaders: {
            Authorization: 'Bearer secret',
            Cookie: 'sid=abc123',
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          postData: 'user=jp&password=hunter2',
        }),
      ],
      actions: [],
    });
    const entry = (har.log['entries'] as Record<string, unknown>[])[0]!;
    const headers = (entry['request'] as Record<string, unknown>)['headers'] as { name: string; value: string }[];
    expect(headers.find((h) => h.name === 'Authorization')?.value).toBe(`Bearer ${MASK}`);
    expect(headers.find((h) => h.name === 'Cookie')?.value).toBe(`sid=${MASK}`);
    const postData = (entry['request'] as Record<string, unknown>)['postData'] as { text: string };
    expect(postData.text).toBe(`user=jp&password=${MASK}`);
    expect(postData.text).not.toContain('hunter2');
  });

  test('reveal: true disables the default masking', () => {
    const har = toHar({
      startedAt: STARTED_AT,
      creatorVersion: '0.1.0',
      requests: [
        makeRequest({
          requestHeaders: {
            Authorization: 'Bearer secret',
            Cookie: 'sid=abc123',
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          postData: 'user=jp&password=hunter2',
        }),
      ],
      actions: [],
      reveal: true,
    });
    const entry = (har.log['entries'] as Record<string, unknown>[])[0]!;
    const headers = (entry['request'] as Record<string, unknown>)['headers'] as { name: string; value: string }[];
    expect(headers.find((h) => h.name === 'Authorization')?.value).toBe('Bearer secret');
    expect(headers.find((h) => h.name === 'Cookie')?.value).toBe('sid=abc123');
    const postData = (entry['request'] as Record<string, unknown>)['postData'] as { text: string };
    expect(postData.text).toBe('user=jp&password=hunter2');
  });

  test('pages are created for navigation-kind actions and url-changing actions', () => {
    const har = toHar({
      startedAt: STARTED_AT,
      creatorVersion: '0.1.0',
      requests: [],
      actions: [
        makeAction({ id: 1, kind: 'goto', urlAfter: 'https://example.com/next' }),
        makeAction({ id: 2, kind: 'click', urlBefore: 'https://example.com/next' }),
        makeAction({ id: 3, kind: 'fill', urlBefore: 'https://example.com/next', urlAfter: 'https://example.com/other' }),
      ],
    });
    const pages = har.log['pages'] as { id: string; title: string }[];
    expect(pages.map((p) => p.id)).toEqual(['action_1', 'action_3']);
    expect(pages[0]!.title).toBe('https://example.com/next');
  });

  test('body callback fills content text and encoding', () => {
    const har = toHar({
      startedAt: STARTED_AT,
      creatorVersion: '0.1.0',
      requests: [makeRequest({ bodyHash: 'hash1' })],
      actions: [],
      body: (hash) => (hash === 'hash1' ? { text: 'aGVsbG8=', encoding: 'base64' } : undefined),
    });
    const entry = (har.log['entries'] as Record<string, unknown>[])[0]!;
    const content = (entry['response'] as Record<string, unknown>)['content'] as Record<string, unknown>;
    expect(content['text']).toBe('aGVsbG8=');
    expect(content['encoding']).toBe('base64');
  });

  test('output is valid JSON serializable', () => {
    const har = toHar({
      startedAt: STARTED_AT,
      creatorVersion: '0.1.0',
      requests: [makeRequest()],
      actions: [makeAction()],
    });
    expect(() => JSON.parse(JSON.stringify(har))).not.toThrow();
  });
});

describe('toPerfetto', () => {
  test('each action produces a matching B/E pair on the actions thread', () => {
    const output = toPerfetto({
      requests: [],
      actions: [makeAction()],
      events: [],
      sessionName: 'session-1',
    });
    const actionEvents = output.traceEvents.filter((e) => e['cat'] === 'action');
    expect(actionEvents).toHaveLength(2);
    const begin = actionEvents.find((e) => e['ph'] === 'B')!;
    const end = actionEvents.find((e) => e['ph'] === 'E')!;
    expect(begin['tid']).toBe(end['tid']);
    expect(begin['ts']).toBe(0);
    expect(end['ts']).toBe(200000);
  });

  test('each request produces a matching b/e pair on the network thread', () => {
    const output = toPerfetto({
      requests: [makeRequest({ actionId: null, bucket: 'unattributed' })],
      actions: [],
      events: [],
      sessionName: 'session-1',
    });
    const netEvents = output.traceEvents.filter((e) => e['cat'] === 'net,unattributed');
    expect(netEvents).toHaveLength(2);
    const begin = netEvents.find((e) => e['ph'] === 'b')!;
    const end = netEvents.find((e) => e['ph'] === 'e')!;
    expect(begin['id']).toBe('r1');
    expect(end['id']).toBe('r1');
    expect(begin['ts']).toBe(100000);
    expect(end['ts']).toBe(160000);
  });

  test('attributed requests get a flow s/f pair with matching ids; unattributed get none', () => {
    const attributed = makeRequest({ id: 'r1', actionId: 1 });
    const unattributed = makeRequest({ id: 'r2', actionId: null, bucket: 'unattributed' });
    const output = toPerfetto({
      requests: [attributed, unattributed],
      actions: [makeAction({ id: 1 })],
      events: [],
      sessionName: 'session-1',
    });
    const flows = output.traceEvents.filter((e) => e['cat'] === 'flow');
    expect(flows).toHaveLength(2);
    const start = flows.find((e) => e['ph'] === 's')!;
    const finish = flows.find((e) => e['ph'] === 'f')!;
    expect(start['id']).toBe('flow_r1');
    expect(finish['id']).toBe('flow_r1');
    expect(start['tid']).toBe(1);
    expect(finish['tid']).toBe(2);
  });

  test('non-request trace events become instant events on the page thread', () => {
    const events: TraceEvent[] = [
      {
        id: 1,
        t: 50,
        type: 'console',
        actionId: 1,
        bucket: 'attributed',
        tabId: 'tab1',
        requestId: null,
        data: { level: 'error', text: 'boom' },
      },
    ];
    const output = toPerfetto({ requests: [], actions: [], events, sessionName: 'session-1' });
    const instants = output.traceEvents.filter((e) => e['ph'] === 'i');
    expect(instants).toHaveLength(1);
    expect(instants[0]!['tid']).toBe(3);
    expect(instants[0]!['s']).toBe('t');
    expect(instants[0]!['args']).toEqual({ level: 'error', text: 'boom' });
  });

  test('metadata reflects the session name', () => {
    const output = toPerfetto({ requests: [], actions: [], events: [], sessionName: 'my-session' });
    expect(output.metadata).toEqual({ source: 'rastro', session: 'my-session' });
  });

  test('traceEvents are sorted by ts ascending', () => {
    const output = toPerfetto({
      requests: [makeRequest({ id: 'r1', t: 500, timing: { startMs: 500, responseMs: 520, endMs: 530 } })],
      actions: [makeAction({ id: 1, t0: 10, t1: 20 })],
      events: [],
      sessionName: 'session-1',
    });
    const ts = output.traceEvents.map((e) => e['ts'] as number).filter((t) => typeof t === 'number');
    const sorted = [...ts].sort((a, b) => a - b);
    expect(ts).toEqual(sorted);
  });

  test('structural check: every B has a matching E on the same tid, and ts are finite numbers', () => {
    const output = toPerfetto({
      requests: [makeRequest()],
      actions: [makeAction()],
      events: [],
      sessionName: 'session-1',
    });
    for (const e of output.traceEvents) {
      if (typeof e['ts'] === 'number') expect(Number.isFinite(e['ts'])).toBe(true);
    }
    const begins = output.traceEvents.filter((e) => e['ph'] === 'B');
    const ends = output.traceEvents.filter((e) => e['ph'] === 'E');
    expect(begins).toHaveLength(ends.length);
    for (const b of begins) {
      expect(ends.some((e) => e['tid'] === b['tid'])).toBe(true);
    }
  });

  test('output is valid JSON serializable', () => {
    const output = toPerfetto({
      requests: [makeRequest()],
      actions: [makeAction()],
      events: [],
      sessionName: 'session-1',
    });
    expect(() => JSON.parse(JSON.stringify(output))).not.toThrow();
  });
});
