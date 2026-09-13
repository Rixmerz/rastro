// Content-addressed storage for response bodies. See design.md decision 3.

import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const HASH_RE = /^[0-9a-f]{64}$/;

export class BodyStore {
  private readonly dir: string;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    this.dir = dir;
  }

  /** Writes `data` under its sha256 hex name, skipping the write if already present. */
  put(data: Buffer): { hash: string; size: number } {
    const hash = createHash('sha256').update(data).digest('hex');
    const dest = this.path(hash);
    if (!existsSync(dest)) {
      writeFileSync(dest, data, { mode: 0o600 });
      chmodSync(dest, 0o600);
    }
    return { hash, size: data.length };
  }

  path(hash: string): string {
    if (!HASH_RE.test(hash)) {
      throw new Error(`invalid body hash "${hash}": expected 64 hex characters`);
    }
    return join(this.dir, hash);
  }

  read(hash: string, maxBytes?: number): Buffer | null {
    const src = this.path(hash);
    if (!existsSync(src)) return null;
    const buf = readFileSync(src);
    return maxBytes !== undefined ? buf.subarray(0, maxBytes) : buf;
  }
}
