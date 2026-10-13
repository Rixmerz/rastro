// What a flood refuses to touch, what it types into a form, and robots.txt.
// Pure, so every rule here is unit-tested without a browser.

/** Session-ending, destructive or money-moving names, English and Spanish. */
const DENY =
  /\b(?:log ?out|sign ?out|log ?off|delete|remove|destroy|erase|purge|unsubscribe|deactivate|close (?:my )?account|cancel (?:my )?(?:account|subscription|order)|pay|checkout|place order|buy|purchase|transfer|send money|reset)\b|cerrar sesi[oó]n|salir|desconectar|eliminar|borrar|quitar|darse de baja|dar de baja|desuscrib|cancelar (?:cuenta|suscripci[oó]n|pedido)|pagar|comprar|finalizar compra|transferir|restablecer/i;

export interface DenyRules {
  /** Extra name patterns (case-insensitive substrings) never activated. */
  skip: string[];
  /** Name substrings activated even when DENY matches. */
  include: string[];
}

/** Returns why an element must not be activated, or undefined. */
export function denyReason(name: string, rules: DenyRules): string | undefined {
  const lower = name.toLowerCase();
  if (rules.include.some((s) => s !== '' && lower.includes(s.toLowerCase()))) return undefined;
  if (rules.skip.some((s) => s !== '' && lower.includes(s.toLowerCase()))) return 'skip';
  if (DENY.test(name)) return 'denylist';
  return undefined;
}

/** Second-level labels under which a registrable domain takes three labels. */
const SECOND_LEVEL = new Set(['co', 'com', 'net', 'org', 'gov', 'edu', 'gob', 'ac', 'mil', 'nom']);

/** `a.b.shop.com.ar` → `shop.com.ar`. A heuristic, not the public suffix
 * list: good enough to tell "this site" from "somewhere else". */
export function registrableDomain(host: string): string {
  const bare = host.replace(/:\d+$/, '').toLowerCase();
  if (/^[\d.]+$/.test(bare) || !bare.includes('.')) return bare;
  const labels = bare.split('.');
  const take = labels.length >= 3 && SECOND_LEVEL.has(labels[labels.length - 2]!) && labels[labels.length - 1]!.length === 2 ? 3 : 2;
  return labels.slice(-take).join('.');
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/** True when `url` leaves the flood's site, or is not a web page at all. */
export function isExternal(url: string, seedHost: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false; // relative: same site
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return true;
  return registrableDomain(parsed.hostname) !== registrableDomain(seedHost);
}

/** Neutral values by input type. Never a secret: password fields are left
 * empty by the worker. */
export function fillerFor(inputType: string | undefined, name: string): string {
  const type = (inputType ?? 'text').toLowerCase();
  if (type === 'email' || /e-?mail|correo/i.test(name)) return 'flood@example.test';
  if (type === 'number' || type === 'range') return '1';
  if (type === 'tel' || /phone|tel[eé]fono/i.test(name)) return '5550100';
  if (type === 'url') return 'https://example.test';
  if (type === 'date') return '2026-01-01';
  if (type === 'time') return '12:00';
  if (type === 'datetime-local') return '2026-01-01T12:00';
  if (type === 'month') return '2026-01';
  if (type === 'week') return '2026-W01';
  if (type === 'color') return '#336699';
  if (type === 'search' || /search|buscar/i.test(name)) return 'test';
  return 'flood';
}

/** Disallow/Allow rules for `User-agent: *`, longest match wins, as Google
 * and RFC 9309 read them. Returns a predicate over a URL path. */
export function parseRobots(text: string): (path: string) => boolean {
  const rules: { allow: boolean; pattern: string }[] = [];
  let applies = false;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const field = m[1]!.toLowerCase();
    const value = m[2]!.trim();
    if (field === 'user-agent') {
      if (!lastWasAgent) applies = false;
      if (value === '*') applies = true;
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!applies) continue;
    if ((field === 'disallow' || field === 'allow') && value !== '') rules.push({ allow: field === 'allow', pattern: value });
  }
  const toRegex = (pattern: string): RegExp => {
    const anchored = pattern.endsWith('$');
    const body = (anchored ? pattern.slice(0, -1) : pattern)
      .split('*')
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*');
    return new RegExp(`^${body}${anchored ? '$' : ''}`);
  };
  const compiled = rules.map((r) => ({ ...r, re: toRegex(r.pattern), len: r.pattern.length }));
  return (path: string) => {
    let best: { allow: boolean; len: number } | undefined;
    for (const r of compiled) {
      if (!r.re.test(path)) continue;
      if (!best || r.len > best.len || (r.len === best.len && r.allow)) best = { allow: r.allow, len: r.len };
    }
    return best?.allow ?? true;
  };
}
