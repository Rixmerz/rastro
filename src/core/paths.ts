import { mkdirSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SESSION_NAME = /^[A-Za-z0-9_-]{1,64}$/;

export function assertSessionName(name: string): string {
  if (!SESSION_NAME.test(name)) {
    throw new Error(`invalid session name "${name}": use letters, digits, _ or -`);
  }
  return name;
}

export function rastroHome(): string {
  return process.env.RASTRO_HOME ?? join(homedir(), '.local', 'share', 'rastro');
}

export function runtimeDir(): string {
  const base = process.env.XDG_RUNTIME_DIR;
  return base ? join(base, 'rastro') : join(rastroHome(), 'run');
}

/** Creates the directory (recursively) and restricts it to the owner. */
export function ensurePrivateDir(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

export interface SessionPaths {
  root: string;
  db: string;
  bodies: string;
  downloads: string;
  exports: string;
  out: string;
  profile: string;
  socket: string;
}

export function sessionPaths(name: string): SessionPaths {
  assertSessionName(name);
  const root = join(rastroHome(), 'sessions', name);
  return {
    root,
    db: join(root, 'trace.db'),
    bodies: join(root, 'bodies'),
    downloads: join(root, 'downloads'),
    exports: join(root, 'exports'),
    out: join(root, 'out'),
    profile: join(rastroHome(), 'profiles', name),
    socket: join(runtimeDir(), `${name}.sock`),
  };
}

export function ensureSessionDirs(paths: SessionPaths): void {
  for (const dir of [paths.root, paths.bodies, paths.downloads, paths.exports, paths.out, paths.profile]) {
    ensurePrivateDir(dir);
  }
  ensurePrivateDir(runtimeDir());
}
