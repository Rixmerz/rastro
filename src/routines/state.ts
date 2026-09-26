// Machine-local routine bookkeeping. Verification is content-addressed: a
// marker named after the sha256 of a file's bytes exists once a run of exactly
// those bytes succeeded. An edit changes the hash, so there is nothing to
// invalidate; a rename or move keeps it, because the bytes are the same.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensurePrivateDir, routinesStateDir } from '../core/paths.ts';

const HASH_RE = /^[0-9a-f]{64}$/;

export function contentHash(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function fileHash(file: string): string {
  return contentHash(readFileSync(file));
}

function markerPath(kind: 'verified' | 'verified-links', hash: string): string {
  if (!HASH_RE.test(hash)) throw new Error(`invalid content hash "${hash}"`);
  return join(routinesStateDir(), kind, hash);
}

/** Atomic enough for markers written by concurrent daemons: write aside, rename. */
function writePrivate(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
}

export function isVerified(hash: string, kind: 'verified' | 'verified-links' = 'verified'): boolean {
  return existsSync(markerPath(kind, hash));
}

export function markVerified(hash: string, file: string, kind: 'verified' | 'verified-links' = 'verified'): void {
  ensurePrivateDir(join(routinesStateDir(), kind));
  writePrivate(markerPath(kind, hash), `${JSON.stringify({ file, at: new Date().toISOString() })}\n`);
}

export interface RunRecord {
  at: string;
  ok: boolean;
  engine: 'browser' | 'http';
  hash: string;
  reason?: string;
}

const NAME_RE = /^[A-Za-z0-9_-]{1,128}$/;

function runPath(name: string): string {
  if (!NAME_RE.test(name)) throw new Error(`invalid routine name "${name}"`);
  return join(routinesStateDir(), 'runs', `${name}.json`);
}

export function recordRun(name: string, run: RunRecord): void {
  ensurePrivateDir(join(routinesStateDir(), 'runs'));
  writePrivate(runPath(name), `${JSON.stringify(run)}\n`);
}

export function lastRun(name: string): RunRecord | undefined {
  try {
    return JSON.parse(readFileSync(runPath(name), 'utf8')) as RunRecord;
  } catch {
    return undefined;
  }
}
