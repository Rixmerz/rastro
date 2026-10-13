// Path segments that are names rather than structure (`/tag/love/`,
// `/author/Jane-Austen`) look like any other word, so they are learned from
// the links a flood sees: when enough sibling links differ in one segment and
// agree on the rest, that segment is a variable.

import { screenPath, templatePath } from './state.ts';

/** Distinct values a segment needs before it counts as a variable. */
const MIN_VALUES = 5;

function split(url: string): { host: string; segments: string[]; hashRoute: string } | undefined {
  try {
    const u = new URL(url);
    const hashRoute = u.hash.startsWith('#/') ? `#${templatePath(u.hash.slice(1))}` : '';
    return { host: u.host, segments: templatePath(u.pathname).split('/'), hashRoute };
  } catch {
    return undefined;
  }
}

/** A trailing slash does not make another family: `/author/x` (a redirect)
 * and `/author/x/` (its target) learn from each other. */
function restKey(host: string, segments: string[], i: number): string {
  const trimmed = segments.length > 1 && segments[segments.length - 1] === '' ? segments.slice(0, -1) : segments;
  return `${host}|${trimmed.map((s, j) => (j === i ? '*' : s)).join('/')}`;
}

export class PathLearner {
  private readonly values = new Map<string, Set<string>>();

  observe(url: string): void {
    const parts = split(url);
    if (!parts) return;
    const { host, segments } = parts;
    segments.forEach((seg, i) => {
      if (seg === '' || seg === '{id}') return;
      // A slot only generalises next to a literal it shares: `/tag/*/` does,
      // a bare `/*` (login, about, contact) never does.
      if (!segments.some((s, j) => j !== i && s !== '' && s !== '{id}')) return;
      const key = restKey(host, segments, i);
      let set = this.values.get(key);
      if (!set) this.values.set(key, (set = new Set()));
      if (set.size < MIN_VALUES) set.add(seg);
    });
  }

  /** A screen's `host/path`: ids and learned slugs folded, `index.html`
   * dropped. */
  template(url: string): string {
    const parts = split(url);
    if (!parts) return url;
    return `${parts.host}${screenPath(this.path(parts.host, parts.segments))}${parts.hashRoute}`;
  }

  /** Path only (for endpoints, which keep their host apart). */
  templatePath(host: string, pathname: string): string {
    return this.path(host, templatePath(pathname).split('/'));
  }

  private path(host: string, segments: string[]): string {
    const out = segments.map((seg, i) => ((this.values.get(restKey(host, segments, i))?.size ?? 0) >= MIN_VALUES ? '{slug}' : seg));
    return out.join('/') || '/';
  }
}
