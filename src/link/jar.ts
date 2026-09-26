// A cookie jar for the HTTP runner: the subset of RFC 6265 a replayed session
// needs — domain and path matching, host-only cookies, Secure, expiry, and
// Set-Cookie updates. Seeded from the browser session's cookies and saved with
// mode 0600, since what it holds is a logged-in session.

import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

export interface JarCookie {
  name: string;
  value: string;
  /** Without a leading dot. */
  domain: string;
  hostOnly: boolean;
  path: string;
  secure: boolean;
  /** Seconds since the epoch; -1 for a session cookie. */
  expires: number;
}

/** The shape Playwright's `context.cookies()` returns. */
export interface BrowserCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  secure: boolean;
}

function domainMatches(host: string, cookie: JarCookie): boolean {
  if (cookie.hostOnly) return host === cookie.domain;
  return host === cookie.domain || host.endsWith(`.${cookie.domain}`);
}

function pathMatches(path: string, cookiePath: string): boolean {
  if (path === cookiePath) return true;
  if (!path.startsWith(cookiePath)) return false;
  return cookiePath.endsWith('/') || path[cookiePath.length] === '/';
}

function defaultPath(url: URL): string {
  const path = url.pathname;
  if (!path.startsWith('/') || path === '/') return '/';
  const last = path.lastIndexOf('/');
  return last === 0 ? '/' : path.slice(0, last);
}

export class CookieJar {
  cookies: JarCookie[];

  constructor(cookies: JarCookie[] = []) {
    this.cookies = cookies;
  }

  /** Only the cookies a request to one of `hosts` would carry: exporting the
   * whole profile would put every other site's session in a plain file. */
  static fromBrowser(cookies: BrowserCookie[], hosts?: string[]): CookieJar {
    const jar = new CookieJar(
      cookies.map((c) => ({
        name: c.name,
        value: c.value,
        // Playwright marks a domain cookie with a leading dot; a bare host is host-only.
        domain: c.domain.replace(/^\./, ''),
        hostOnly: !c.domain.startsWith('.'),
        path: c.path || '/',
        secure: c.secure,
        expires: c.expires,
      })),
    );
    if (hosts !== undefined) jar.cookies = jar.cookies.filter((c) => hosts.some((h) => domainMatches(h, c)));
    return jar;
  }

  static load(file: string): CookieJar {
    if (!existsSync(file)) return new CookieJar();
    return new CookieJar(JSON.parse(readFileSync(file, 'utf8')) as JarCookie[]);
  }

  save(file: string): void {
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.cookies), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
  }

  private live(now: number): JarCookie[] {
    this.cookies = this.cookies.filter((c) => c.expires === -1 || c.expires > now / 1000);
    return this.cookies;
  }

  /** The `Cookie` header for a request to `url`, longest path first. */
  header(url: string, now = Date.now()): string {
    const u = new URL(url);
    // Browsers treat loopback as a secure context, so a Secure cookie set
    // there still goes back over plain http.
    const secure = u.protocol === 'https:' || u.hostname === '127.0.0.1' || u.hostname === 'localhost';
    return this.live(now)
      .filter((c) => domainMatches(u.hostname, c) && pathMatches(u.pathname, c.path) && (!c.secure || secure))
      .sort((a, b) => b.path.length - a.path.length)
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');
  }

  get(name: string, url: string, now = Date.now()): string | undefined {
    const u = new URL(url);
    return this.live(now).find((c) => c.name === name && domainMatches(u.hostname, c) && pathMatches(u.pathname, c.path))?.value;
  }

  /** Applies `Set-Cookie` headers received from `url`. */
  store(url: string, setCookies: string[], now = Date.now()): void {
    const u = new URL(url);
    for (const line of setCookies) {
      const [pair, ...attrs] = line.split(';');
      const eq = pair?.indexOf('=') ?? -1;
      if (!pair || eq <= 0) continue;
      const cookie: JarCookie = {
        name: pair.slice(0, eq).trim(),
        value: pair.slice(eq + 1).trim(),
        domain: u.hostname,
        hostOnly: true,
        path: defaultPath(u),
        secure: false,
        expires: -1,
      };
      let maxAge: number | undefined;
      for (const attr of attrs) {
        const [rawKey, ...rest] = attr.split('=');
        const key = rawKey?.trim().toLowerCase();
        const value = rest.join('=').trim();
        if (key === 'domain' && value) {
          const domain = value.replace(/^\./, '').toLowerCase();
          // A server may only set cookies for itself or a parent domain.
          if (u.hostname !== domain && !u.hostname.endsWith(`.${domain}`)) continue;
          cookie.domain = domain;
          cookie.hostOnly = false;
        } else if (key === 'path' && value.startsWith('/')) {
          cookie.path = value;
        } else if (key === 'secure') {
          cookie.secure = true;
        } else if (key === 'max-age' && /^-?\d+$/.test(value)) {
          maxAge = Number(value);
        } else if (key === 'expires') {
          const t = Date.parse(value);
          if (!Number.isNaN(t)) cookie.expires = Math.floor(t / 1000);
        }
      }
      if (maxAge !== undefined) cookie.expires = maxAge <= 0 ? 0 : Math.floor(now / 1000) + maxAge;

      this.cookies = this.cookies.filter(
        (c) => !(c.name === cookie.name && c.domain === cookie.domain && c.path === cookie.path),
      );
      if (cookie.expires === -1 || cookie.expires > now / 1000) this.cookies.push(cookie);
    }
  }
}
