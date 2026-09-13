// Session trace storage: schema, inserts, queries. See design.md decision 3.
//
// Every table stores the full record as a JSON blob in a `data` column;
// filterable fields are duplicated into plain columns and indexed for the
// queries below. `JSON.stringify` drops keys whose value is `undefined`, so
// an absent optional field round-trips as absent, never as `null`.

import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  ActionRecord,
  EventBucket,
  EventType,
  NewTraceEvent,
  RequestRecord,
  SessionRecord,
  SnapshotRecord,
  TraceEvent,
} from '../core/types.ts';

export interface EventQuery {
  actionId?: number;
  since?: number;
  until?: number;
  types?: EventType[];
  buckets?: EventBucket[];
  tabId?: string;
  limit?: number;
  offset?: number;
}

export interface RequestQuery {
  actionId?: number;
  since?: number;
  until?: number;
  buckets?: EventBucket[];
  tabId?: string;
  limit?: number;
}

interface ActionQuery {
  from?: number;
  to?: number;
  limit?: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS session (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  data TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  t INTEGER NOT NULL,
  type TEXT NOT NULL,
  action_id INTEGER,
  bucket TEXT,
  tab_id TEXT NOT NULL,
  request_id TEXT,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_t ON events(t);
CREATE INDEX IF NOT EXISTS idx_events_action ON events(action_id);
CREATE INDEX IF NOT EXISTS idx_events_bucket ON events(bucket);
CREATE INDEX IF NOT EXISTS idx_events_tab ON events(tab_id);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);

CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY,
  cdp_id TEXT NOT NULL,
  t INTEGER NOT NULL,
  tab_id TEXT NOT NULL,
  action_id INTEGER,
  bucket TEXT,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_requests_cdp ON requests(cdp_id);
CREATE INDEX IF NOT EXISTS idx_requests_t ON requests(t);
CREATE INDEX IF NOT EXISTS idx_requests_action ON requests(action_id);
CREATE INDEX IF NOT EXISTS idx_requests_bucket ON requests(bucket);
CREATE INDEX IF NOT EXISTS idx_requests_tab ON requests(tab_id);

CREATE TABLE IF NOT EXISTS actions (
  id INTEGER PRIMARY KEY,
  data TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  data TEXT NOT NULL
);
`;

interface WhereClause {
  sql: string;
  params: (number | string)[];
}

/** Shared WHERE builder for `events` (has `types`) and `requests` (does not). */
function buildWhere(opts: {
  actionId?: number;
  since?: number;
  until?: number;
  buckets?: EventBucket[];
  tabId?: string;
  types?: EventType[];
}): WhereClause {
  const clauses: string[] = [];
  const params: (number | string)[] = [];
  if (opts.actionId !== undefined) {
    clauses.push('action_id = ?');
    params.push(opts.actionId);
  }
  if (opts.since !== undefined) {
    clauses.push('t >= ?');
    params.push(opts.since);
  }
  if (opts.until !== undefined) {
    clauses.push('t <= ?');
    params.push(opts.until);
  }
  if (opts.tabId !== undefined) {
    clauses.push('tab_id = ?');
    params.push(opts.tabId);
  }
  if (opts.buckets && opts.buckets.length > 0) {
    clauses.push(`bucket IN (${opts.buckets.map(() => '?').join(', ')})`);
    params.push(...opts.buckets);
  }
  if (opts.types && opts.types.length > 0) {
    clauses.push(`type IN (${opts.types.map(() => '?').join(', ')})`);
    params.push(...opts.types);
  }
  return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

function parseData<T>(row: Record<string, unknown> | undefined): T | null {
  return row ? (JSON.parse(row.data as string) as T) : null;
}

export class TraceStore {
  private readonly db: DatabaseSync;

  private constructor(db: DatabaseSync) {
    this.db = db;
  }

  static open(dbPath: string): TraceStore {
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(SCHEMA);
    chmodSync(dbPath, 0o600);
    for (const suffix of ['-wal', '-shm']) {
      const sidecar = `${dbPath}${suffix}`;
      if (existsSync(sidecar)) chmodSync(sidecar, 0o600);
    }
    return new TraceStore(db);
  }

  close(): void {
    this.db.close();
  }

  setSession(rec: SessionRecord): void {
    this.db
      .prepare(
        'INSERT INTO session (id, data) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data',
      )
      .run(JSON.stringify(rec));
  }

  getSession(): SessionRecord | null {
    const row = this.db.prepare('SELECT data FROM session WHERE id = 1').get();
    return parseData<SessionRecord>(row);
  }

  addEvent(e: NewTraceEvent): number {
    const { lastInsertRowid } = this.db
      .prepare(
        'INSERT INTO events (t, type, action_id, bucket, tab_id, request_id, data) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(e.t, e.type, e.actionId, e.bucket, e.tabId, e.requestId, '');
    const id = Number(lastInsertRowid);
    const full: TraceEvent = { id, ...e };
    this.db.prepare('UPDATE events SET data = ? WHERE id = ?').run(JSON.stringify(full), id);
    return id;
  }

  setEventAttribution(ids: number[], actionId: number | null, bucket: EventBucket): void {
    const getStmt = this.db.prepare('SELECT data FROM events WHERE id = ?');
    const updStmt = this.db.prepare(
      'UPDATE events SET action_id = ?, bucket = ?, data = ? WHERE id = ?',
    );
    for (const id of ids) {
      const rec = parseData<TraceEvent>(getStmt.get(id));
      if (!rec) continue;
      rec.actionId = actionId;
      rec.bucket = bucket;
      updStmt.run(actionId, bucket, JSON.stringify(rec), id);
    }
  }

  events(q: EventQuery = {}): TraceEvent[] {
    const { sql: where, params } = buildWhere(q);
    const args: (number | string)[] = [...params];
    let sql = `SELECT data FROM events ${where} ORDER BY t ASC, id ASC`;
    if (q.limit !== undefined) {
      sql += ' LIMIT ?';
      args.push(q.limit);
      if (q.offset !== undefined) {
        sql += ' OFFSET ?';
        args.push(q.offset);
      }
    } else if (q.offset !== undefined) {
      sql += ' LIMIT -1 OFFSET ?';
      args.push(q.offset);
    }
    return this.db
      .prepare(sql)
      .all(...args)
      .map((row) => JSON.parse(row.data as string) as TraceEvent);
  }

  countEvents(q: EventQuery = {}): number {
    const { sql: where, params } = buildWhere(q);
    const row = this.db.prepare(`SELECT COUNT(*) as c FROM events ${where}`).get(...params);
    return Number(row?.c ?? 0);
  }

  nextRequestId(): string {
    return `r${this.nextSeq('request_seq')}`;
  }

  upsertRequest(r: RequestRecord): void {
    this.db
      .prepare(
        `INSERT INTO requests (id, cdp_id, t, tab_id, action_id, bucket, data)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           cdp_id = excluded.cdp_id, t = excluded.t, tab_id = excluded.tab_id,
           action_id = excluded.action_id, bucket = excluded.bucket, data = excluded.data`,
      )
      .run(r.id, r.cdpId, r.t, r.tabId, r.actionId, r.bucket, JSON.stringify(r));
  }

  getRequest(id: string): RequestRecord | null {
    const row = this.db.prepare('SELECT data FROM requests WHERE id = ?').get(id);
    return parseData<RequestRecord>(row);
  }

  /** Redirects reuse the CDP request id; the most recently inserted record wins. */
  getRequestByCdpId(cdpId: string): RequestRecord | null {
    const row = this.db
      .prepare('SELECT data FROM requests WHERE cdp_id = ? ORDER BY t DESC, rowid DESC LIMIT 1')
      .get(cdpId);
    return parseData<RequestRecord>(row);
  }

  requests(q: RequestQuery = {}): RequestRecord[] {
    const { sql: where, params } = buildWhere(q);
    const args: (number | string)[] = [...params];
    let sql = `SELECT data FROM requests ${where} ORDER BY t ASC, rowid ASC`;
    if (q.limit !== undefined) {
      sql += ' LIMIT ?';
      args.push(q.limit);
    }
    return this.db
      .prepare(sql)
      .all(...args)
      .map((row) => JSON.parse(row.data as string) as RequestRecord);
  }

  setRequestAttribution(id: string, actionId: number | null, bucket: EventBucket): void {
    const row = this.db.prepare('SELECT data FROM requests WHERE id = ?').get(id);
    const rec = parseData<RequestRecord>(row);
    if (!rec) return;
    rec.actionId = actionId;
    rec.bucket = bucket;
    this.db
      .prepare('UPDATE requests SET action_id = ?, bucket = ?, data = ? WHERE id = ?')
      .run(actionId, bucket, JSON.stringify(rec), id);
  }

  nextActionId(): number {
    return this.nextSeq('action_seq');
  }

  addAction(a: ActionRecord): void {
    this.db.prepare('INSERT INTO actions (id, data) VALUES (?, ?)').run(a.id, JSON.stringify(a));
  }

  updateAction(id: number, patch: Partial<Omit<ActionRecord, 'id'>>): void {
    const row = this.db.prepare('SELECT data FROM actions WHERE id = ?').get(id);
    const existing = parseData<ActionRecord>(row);
    if (!existing) {
      throw new Error(`no action with id ${id}`);
    }
    const merged: ActionRecord = { ...existing, ...patch, id };
    this.db.prepare('UPDATE actions SET data = ? WHERE id = ?').run(JSON.stringify(merged), id);
  }

  getAction(id: number): ActionRecord | null {
    const row = this.db.prepare('SELECT data FROM actions WHERE id = ?').get(id);
    return parseData<ActionRecord>(row);
  }

  /**
   * `from`/`to` bound the action id range (actions.id is the sort key used
   * everywhere else in this store). With `limit` and neither bound, returns
   * the last `limit` actions, still ascending.
   */
  actions(q: ActionQuery = {}): ActionRecord[] {
    if (q.limit !== undefined && q.from === undefined && q.to === undefined) {
      const rows = this.db
        .prepare('SELECT data FROM actions ORDER BY id DESC LIMIT ?')
        .all(q.limit);
      return rows.reverse().map((row) => JSON.parse(row.data as string) as ActionRecord);
    }
    const clauses: string[] = [];
    const params: number[] = [];
    if (q.from !== undefined) {
      clauses.push('id >= ?');
      params.push(q.from);
    }
    if (q.to !== undefined) {
      clauses.push('id <= ?');
      params.push(q.to);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    let sql = `SELECT data FROM actions ${where} ORDER BY id ASC`;
    const args = [...params];
    if (q.limit !== undefined) {
      sql += ' LIMIT ?';
      args.push(q.limit);
    }
    return this.db
      .prepare(sql)
      .all(...args)
      .map((row) => JSON.parse(row.data as string) as ActionRecord);
  }

  lastAction(): ActionRecord | null {
    const row = this.db.prepare('SELECT data FROM actions ORDER BY id DESC LIMIT 1').get();
    return parseData<ActionRecord>(row);
  }

  addSnapshot(s: Omit<SnapshotRecord, 'id'>): number {
    const { lastInsertRowid } = this.db.prepare('INSERT INTO snapshots (data) VALUES (?)').run('');
    const id = Number(lastInsertRowid);
    const full: SnapshotRecord = { id, ...s };
    this.db.prepare('UPDATE snapshots SET data = ? WHERE id = ?').run(JSON.stringify(full), id);
    return id;
  }

  getSnapshot(id: number): SnapshotRecord | null {
    const row = this.db.prepare('SELECT data FROM snapshots WHERE id = ?').get(id);
    return parseData<SnapshotRecord>(row);
  }

  private nextSeq(key: string): number {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
    const current = row ? Number(row.value) : 0;
    const next = current + 1;
    this.db
      .prepare(
        'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, next);
    return next;
  }
}
