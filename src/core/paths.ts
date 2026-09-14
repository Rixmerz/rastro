import { RastroError } from './types.ts';
import { mkdirSync, chmodSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

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

/**
 * Where a flow named without a path lives: the repository's own `.rastro/flows`
 * when it exists, so flows land in git next to the code they drive, and the
 * user's config directory otherwise. Config and not `rastroHome()`, because
 * these are hand-authored source — `rastroHome()` holds what Rastro generated
 * and may delete.
 */
export function flowsDir(): string {
  const local = join(process.cwd(), '.rastro', 'flows');
  if (existsSync(local)) return local;
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
  return join(base, 'rastro', 'flows');
}

/**
 * Resolves a `flow save`/`flow run` argument. Anything that looks like a path
 * (a separator, or a .yaml/.yml suffix) stays a path, so every existing
 * invocation keeps working; a bare name resolves under `flowsDir()`.
 */
export function resolveFlowRef(arg: string): string {
  if (arg.includes('/') || /\.ya?ml$/i.test(arg)) return resolve(arg);
  if (!FLOW_NAME.test(arg)) {
    throw new RastroError(`invalid flow name "${arg}"`, 'use letters, digits, dot, dash or underscore, or give a path');
  }
  return join(flowsDir(), `${arg}.yaml`);
}

const FLOW_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

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
  uploads: string;
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
    uploads: join(root, 'uploads'),
    exports: join(root, 'exports'),
    out: join(root, 'out'),
    profile: join(rastroHome(), 'profiles', name),
    socket: join(runtimeDir(), `${name}.sock`),
  };
}

export function ensureSessionDirs(paths: SessionPaths): void {
  for (const dir of [paths.root, paths.bodies, paths.downloads, paths.uploads, paths.exports, paths.out, paths.profile]) {
    ensurePrivateDir(dir);
  }
  ensurePrivateDir(runtimeDir());
}

// A `sockaddr_un.sun_path` is 108 bytes including the trailing NUL, so a socket
// path over 107 bytes fails to bind/connect with a bare EINVAL that gives no
// clue where the path came from. Check early and point at the fix.
const MAX_SOCKET_PATH_BYTES = 107;

export function assertSocketPathFits(socketPath: string): void {
  const bytes = Buffer.byteLength(socketPath, 'utf8');
  if (bytes > MAX_SOCKET_PATH_BYTES) {
    throw new RastroError(
      `session socket path is too long (${bytes} bytes, limit ${MAX_SOCKET_PATH_BYTES}): ${socketPath}`,
      'set a shorter $XDG_RUNTIME_DIR or $RASTRO_HOME so the session socket path fits the platform Unix-socket limit',
    );
  }
}
