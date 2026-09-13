import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type {
  ActionRecord,
  NewTraceEvent,
  RequestRecord,
  SessionRecord,
  SnapshotRecord,
} from '../src/core/types.ts';
import { BodyStore } from '../src/store/bodies.ts';
import { TraceStore } from '../src/store/db.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rastro-store-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function event(overrides: Partial<NewTraceEvent> = {}): NewTraceEvent {
  return {
    t: 0,
    type: 'navigation',
    actionId: null,
    bucket: null,
    tabId: 'tab1',
    requestId: null,
    data: {},
    ...overrides,
  };
}

function request(overrides: Partial<RequestRecord> = {}): RequestRecord {
  return {
    id: 'r1',
    cdpId: 'cdp1',
    tabId: 'tab1',
    t: 0,
    method: 'GET',
    url: 'https://example.com/',
    resourceType: 'document',
    initiator: { type: 'other', stackHasInterval: false },
    requestHeaders: {},
    timing: { startMs: 0 },
    origin: 'page',
    isNavigation: true,
    actionId: null,
    bucket: null,
    ...overrides,
  };
}

function action(overrides: Partial<ActionRecord> = {}): ActionRecord {
  return {
    id: 1,
    source: 'agent',
    kind: 'click',
    tabId: 'tab1',
    secret: false,
    t0: 0,
    urlBefore: 'https://example.com/',
    ...overrides,
  };
}

describe('TraceStore.open', () => {
  test('creates parent dir and sets db file mode 0600', () => {
    const dbPath = join(dir, 'nested', 'trace.db');
    const store = TraceStore.open(dbPath);
    expect(existsSync(dbPath)).toBe(true);
    expect(statSync(dbPath).mode & 0o777).toBe(0o600);
    store.close();
  });

  test('schema creation is idempotent across reopen', () => {
    const dbPath = join(dir, 'trace.db');
    const s1 = TraceStore.open(dbPath);
    s1.setSession({ name: 'a', startedAt: 'x', mode: 'agent' });
    s1.close();
    const s2 = TraceStore.open(dbPath);
    expect(s2.getSession()?.name).toBe('a');
    s2.close();
  });
});

describe('SessionRecord round-trip', () => {
  test('preserves all fields, and absent optional field stays absent', () => {
    const store = TraceStore.open(join(dir, 'trace.db'));
    const withVersion: SessionRecord = {
      name: 'sess',
      startedAt: '2026-09-13T00:00:00Z',
      mode: 'human',
      chromiumVersion: '130.0',
    };
    store.setSession(withVersion);
    expect(store.getSession()).toEqual(withVersion);

    const withoutVersion: SessionRecord = { name: 'sess2', startedAt: 'y', mode: 'agent' };
    store.setSession(withoutVersion);
    const got = store.getSession();
    expect(got).toEqual(withoutVersion);
    expect(got).not.toHaveProperty('chromiumVersion');
    store.close();
  });

  test('getSession returns null when unset', () => {
    const store = TraceStore.open(join(dir, 'trace.db'));
    expect(store.getSession()).toBeNull();
    store.close();
  });
});

describe('events', () => {
  test('addEvent returns an id and round-trips every field', () => {
    const store = TraceStore.open(join(dir, 'trace.db'));
    const id = store.addEvent(
      event({ t: 5, type: 'console', tabId: 'tab2', requestId: 'r1', data: { level: 'error' } }),
    );
    expect(typeof id).toBe('number');
    const [got] = store.events();
    expect(got).toEqual({
      id,
      t: 5,
      type: 'console',
      actionId: null,
      bucket: null,
      tabId: 'tab2',
      requestId: 'r1',
      data: { level: 'error' },
    });
    store.close();
  });

  test('events() sorts ascending by t then id', () => {
    const store = TraceStore.open(join(dir, 'trace.db'));
    store.addEvent(event({ t: 10 }));
    store.addEvent(event({ t: 5 }));
    store.addEvent(event({ t: 5 }));
    const rows = store.events();
    expect(rows.map((e) => e.t)).toEqual([5, 5, 10]);
    expect(rows[0]!.id).toBeLessThan(rows[1]!.id);
  });

  test('filters by actionId, time range, types, buckets, tabId', () => {
    const store = TraceStore.open(join(dir, 'trace.db'));
    const idA = store.addEvent(event({ t: 1, type: 'navigation', tabId: 'a', bucket: 'background' }));
    const idB = store.addEvent(event({ t: 2, type: 'console', tabId: 'b' }));
    const idC = store.addEvent(
      event({ t: 3, type: 'request', tabId: 'a', bucket: 'unattributed' }),
    );
    store.setEventAttribution([idB], 7, 'attributed');

    expect(store.events({ tabId: 'a' }).map((e) => e.id)).toEqual([idA, idC]);
    expect(store.events({ types: ['console'] }).map((e) => e.id)).toEqual([idB]);
    expect(store.events({ since: 2, until: 2 }).map((e) => e.id)).toEqual([idB]);
    expect(store.events({ actionId: 7 }).map((e) => e.id)).toEqual([idB]);
    expect(store.events({ buckets: ['attributed'] }).map((e) => e.id)).toEqual([idB]);
    expect(store.events({ buckets: ['background', 'unattributed'] }).map((e) => e.id)).toEqual([
      idA,
      idC,
    ]);
    store.close();
  });

  test('limit and offset paginate in order', () => {
    const store = TraceStore.open(join(dir, 'trace.db'));
    const ids = [0, 1, 2, 3, 4].map((t) => store.addEvent(event({ t })));
    expect(store.events({ limit: 2 }).map((e) => e.id)).toEqual(ids.slice(0, 2));
    expect(store.events({ limit: 2, offset: 2 }).map((e) => e.id)).toEqual(ids.slice(2, 4));
    expect(store.events({ offset: 4 }).map((e) => e.id)).toEqual(ids.slice(4));
    store.close();
  });

  test('countEvents matches the same filters as events()', () => {
    const store = TraceStore.open(join(dir, 'trace.db'));
    store.addEvent(event({ t: 1, tabId: 'a' }));
    store.addEvent(event({ t: 2, tabId: 'b' }));
    expect(store.countEvents()).toBe(2);
    expect(store.countEvents({ tabId: 'a' })).toBe(1);
    store.close();
  });

  test('setEventAttribution updates action_id and bucket for exactly the given ids', () => {
    const store = TraceStore.open(join(dir, 'trace.db'));
    const idA = store.addEvent(event());
    const idB = store.addEvent(event());
    store.setEventAttribution([idA], 3, 'attributed');
    const [a, b] = store.events();
    const byId = new Map([a, b].map((e) => [e!.id, e!]));
    expect(byId.get(idA)).toMatchObject({ actionId: 3, bucket: 'attributed' });
    expect(byId.get(idB)).toMatchObject({ actionId: null, bucket: null });
    store.close();
  });
});

describe('requests', () => {
  test('round-trips every field, including nested initiator/timing', () => {
    const store = TraceStore.open(join(dir, 'trace.db'));
    const rec = request({
      id: 'r1',
      statusText: 'OK',
      status: 200,
      responseHeaders: { 'content-type': 'text/html' },
      bodyHash: 'a'.repeat(64),
      bodySize: 100,
      mimeType: 'text/html',
      redirectedFrom: 'r0',
      initiator: { type: 'script', url: 'https://x/', line: 3, stackHasInterval: true },
      timing: { startMs: 0, responseMs: 5, endMs: 10 },
    });
    store.upsertRequest(rec);
    expect(store.getRequest('r1')).toEqual(rec);
    store.close();
  });

  test('absent optional fields stay absent, not null', () => {
    const store = TraceStore.open(join(dir, 'trace.db'));
    const rec = request({ id: 'r2' });
    store.upsertRequest(rec);
    const got = store.getRequest('r2');
    expect(got).toEqual(rec);
    expect(got).not.toHaveProperty('status');
    expect(got).not.toHaveProperty('redirectedFrom');
    store.close();
  });

  test('getRequestByCdpId returns the most recent record with that cdpId', () => {
    const store = TraceStore.open(join(dir, 'trace.db'));
    store.upsertRequest(request({ id: 'r1', cdpId: 'shared', t: 0 }));
    store.upsertRequest(request({ id: 'r2', cdpId: 'shared', t: 5 }));
    expect(store.getRequestByCdpId('shared')?.id).toBe('r2');
    expect(store.getRequestByCdpId('missing')).toBeNull();
    store.close();
  });

  test('upsertRequest replaces the record for an existing public id', () => {
    const store = TraceStore.open(join(dir, 'trace.db'));
    store.upsertRequest(request({ id: 'r1', status: 200 }));
    store.upsertRequest(request({ id: 'r1', status: 404 }));
    expect(store.getRequest('r1')?.status).toBe(404);
    store.close();
  });

  test('filters by actionId, time range, buckets, tabId, and limit', () => {
    const store = TraceStore.open(join(dir, 'trace.db'));
    store.upsertRequest(request({ id: 'r1', t: 1, tabId: 'a' }));
    store.upsertRequest(request({ id: 'r2', t: 2, tabId: 'b' }));
    store.upsertRequest(request({ id: 'r3', t: 3, tabId: 'a' }));
    store.setRequestAttribution('r2', 9, 'attributed');

    expect(store.requests({ tabId: 'a' }).map((r) => r.id)).toEqual(['r1', 'r3']);
    expect(store.requests({ since: 2, until: 2 }).map((r) => r.id)).toEqual(['r2']);
    expect(store.requests({ actionId: 9 }).map((r) => r.id)).toEqual(['r2']);
    expect(store.requests({ buckets: ['attributed'] }).map((r) => r.id)).toEqual(['r2']);
    expect(store.requests({ limit: 2 }).map((r) => r.id)).toEqual(['r1', 'r2']);
    store.close();
  });

  test('requests() sorts ascending by t', () => {
    const store = TraceStore.open(join(dir, 'trace.db'));
    store.upsertRequest(request({ id: 'r1', t: 5 }));
    store.upsertRequest(request({ id: 'r2', t: 1 }));
    expect(store.requests().map((r) => r.id)).toEqual(['r2', 'r1']);
    store.close();
  });

  test('setRequestAttribution updates the stored record', () => {
    const store = TraceStore.open(join(dir, 'trace.db'));
    store.upsertRequest(request({ id: 'r1' }));
    store.setRequestAttribution('r1', 4, 'background');
    const got = store.getRequest('r1');
    expect(got?.actionId).toBe(4);
    expect(got?.bucket).toBe('background');
    store.close();
  });

  test('nextRequestId increments and persists across reopen', () => {
    const dbPath = join(dir, 'trace.db');
    const s1 = TraceStore.open(dbPath);
    expect(s1.nextRequestId()).toBe('r1');
    expect(s1.nextRequestId()).toBe('r2');
    s1.close();
    const s2 = TraceStore.open(dbPath);
    expect(s2.nextRequestId()).toBe('r3');
    s2.close();
  });
});

describe('actions', () => {
  test('round-trips every field including optional ones', () => {
    const store = TraceStore.open(join(dir, 'trace.db'));
    const rec = action({
      id: 1,
      ref: 'e12',
      target: { role: 'button', name: 'Submit' },
      targetName: 'Submit',
      value: 'hunter2',
      secret: true,
      t1: 10,
      urlAfter: 'https://example.com/next',
      summary: {
        requests: 2,
        failed: [],
        cookies: { added: 0, changed: 0, removed: 0 },
        newElements: 1,
        consoleErrors: 0,
        dialogs: [],
        tabsOpened: [],
        downloads: [],
        blockedWrites: [],
        hiddenBackground: 0,
        hiddenUnattributed: 0,
      },
      error: 'timeout',
      snapshotBefore: 1,
      snapshotAfter: 2,
    });
    store.addAction(rec);
    expect(store.getAction(1)).toEqual(rec);
    store.close();
  });

  test('absent optional fields stay absent, not null', () => {
    const store = TraceStore.open(join(dir, 'trace.db'));
    const rec = action({ id: 1 });
    store.addAction(rec);
    const got = store.getAction(1);
    expect(got).toEqual(rec);
    expect(got).not.toHaveProperty('ref');
    expect(got).not.toHaveProperty('error');
    store.close();
  });

  test('getAction returns null for a missing id', () => {
    const store = TraceStore.open(join(dir, 'trace.db'));
    expect(store.getAction(99)).toBeNull();
    store.close();
  });

  test('updateAction merges a patch into the existing record', () => {
    const store = TraceStore.open(join(dir, 'trace.db'));
    store.addAction(action({ id: 1 }));
    store.updateAction(1, { t1: 20, urlAfter: 'https://example.com/done' });
    const got = store.getAction(1);
    expect(got?.t1).toBe(20);
    expect(got?.urlAfter).toBe('https://example.com/done');
    expect(got?.kind).toBe('click');
    store.close();
  });

  test('updateAction throws for a missing id', () => {
    const store = TraceStore.open(join(dir, 'trace.db'));
    expect(() => store.updateAction(1, { t1: 1 })).toThrow();
    store.close();
  });

  test('actions() ascending by id, with from/to bounds', () => {
    const store = TraceStore.open(join(dir, 'trace.db'));
    for (let i = 1; i <= 5; i++) store.addAction(action({ id: i }));
    expect(store.actions().map((a) => a.id)).toEqual([1, 2, 3, 4, 5]);
    expect(store.actions({ from: 2, to: 4 }).map((a) => a.id)).toEqual([2, 3, 4]);
  });

  test('actions() with limit and no bounds returns the last n, still ascending', () => {
    const store = TraceStore.open(join(dir, 'trace.db'));
    for (let i = 1; i <= 5; i++) store.addAction(action({ id: i }));
    expect(store.actions({ limit: 2 }).map((a) => a.id)).toEqual([4, 5]);
  });

  test('lastAction returns the highest id, or null when empty', () => {
    const store = TraceStore.open(join(dir, 'trace.db'));
    expect(store.lastAction()).toBeNull();
    store.addAction(action({ id: 1 }));
    store.addAction(action({ id: 2 }));
    expect(store.lastAction()?.id).toBe(2);
    store.close();
  });

  test('nextActionId increments and persists across reopen', () => {
    const dbPath = join(dir, 'trace.db');
    const s1 = TraceStore.open(dbPath);
    expect(s1.nextActionId()).toBe(1);
    expect(s1.nextActionId()).toBe(2);
    s1.close();
    const s2 = TraceStore.open(dbPath);
    expect(s2.nextActionId()).toBe(3);
    s2.close();
  });
});

describe('snapshots', () => {
  test('addSnapshot returns an id and round-trips the record', () => {
    const store = TraceStore.open(join(dir, 'trace.db'));
    const snap: Omit<SnapshotRecord, 'id'> = {
      t: 5,
      tabId: 'tab1',
      url: 'https://example.com/',
      title: 'Example',
      tree: [{ role: 'button', name: 'Go' }],
    };
    const id = store.addSnapshot(snap);
    expect(store.getSnapshot(id)).toEqual({ id, ...snap });
    store.close();
  });

  test('getSnapshot returns null for a missing id', () => {
    const store = TraceStore.open(join(dir, 'trace.db'));
    expect(store.getSnapshot(1)).toBeNull();
    store.close();
  });
});

describe('BodyStore', () => {
  test('creates the directory with mode 0700', () => {
    const bodiesDir = join(dir, 'bodies');
    new BodyStore(bodiesDir);
    expect(statSync(bodiesDir).mode & 0o777).toBe(0o700);
  });

  test('put writes a file named by sha256 hex digest, mode 0600', () => {
    const store = new BodyStore(join(dir, 'bodies'));
    const data = Buffer.from('hello world');
    const { hash, size } = store.put(data);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(size).toBe(data.length);
    const p = store.path(hash);
    expect(existsSync(p)).toBe(true);
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });

  test('put dedupes identical content to a single file, no rewrite', () => {
    const store = new BodyStore(join(dir, 'bodies'));
    const data = Buffer.from('same content');
    const first = store.put(data);
    const before = statSync(store.path(first.hash));
    const second = store.put(data);
    expect(second.hash).toBe(first.hash);
    const after = statSync(store.path(first.hash));
    expect(after.ctimeMs).toBe(before.ctimeMs);
  });

  test('read returns the stored bytes, or null when absent', () => {
    const store = new BodyStore(join(dir, 'bodies'));
    const { hash } = store.put(Buffer.from('payload'));
    expect(store.read(hash)?.toString()).toBe('payload');
    expect(store.read('f'.repeat(64))).toBeNull();
  });

  test('read respects maxBytes', () => {
    const store = new BodyStore(join(dir, 'bodies'));
    const { hash } = store.put(Buffer.from('0123456789'));
    expect(store.read(hash, 4)?.toString()).toBe('0123');
  });

  test('path throws for an invalid hash', () => {
    const store = new BodyStore(join(dir, 'bodies'));
    expect(() => store.path('not-a-hash')).toThrow();
    expect(() => store.path('a'.repeat(63))).toThrow();
    expect(() => store.path('g'.repeat(64))).toThrow();
  });
});
