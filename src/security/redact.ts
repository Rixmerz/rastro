// Masks secrets in headers, cookies and request bodies before they reach any
// command output or the trace, per the "Secret masking" write-safety spec.

export const MASK = '•••';

/** Exact-token matches: the whole token must equal one of these. */
const SENSITIVE_TOKENS = new Set([
  'pass',
  'pwd',
  'pin',
  'otp',
  'cvv',
  'cvc',
  'card',
  'secret',
  'token',
  'apikey',
  'passcode',
  'ssn',
]);

/**
 * Substring matches against the whole field name. Kept separate from
 * SENSITIVE_TOKENS because these are safe as substrings (e.g. "session" in
 * "sessionId"), whereas the short tokens above ("pin", "card"...) would
 * produce false positives as substrings ("spinner", "cardigan").
 */
const SENSITIVE_SUBSTRINGS = [
  'password',
  'passwd',
  'secret',
  'token',
  'apikey',
  'api_key',
  'creditcard',
  'cardnumber',
  'authorization',
  'session',
];

function tokenize(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((token) => token.toLowerCase());
}

/**
 * Sensitive when any camelCase/separator token exactly matches a short
 * credential word, or the field name (in any of its separator forms)
 * contains one of the longer substrings.
 *
 * Deliberate false positive, documented in a test: `tokenizer_version`
 * matches the "token" substring rule. The spec lists "token" as a substring
 * to catch, and over-masking a version field is a cheaper mistake than
 * under-masking a real token.
 */
export function isSensitiveFieldName(name: string): boolean {
  const tokens = tokenize(name);
  if (tokens.some((token) => SENSITIVE_TOKENS.has(token))) {
    return true;
  }
  const haystacks = [name.toLowerCase(), tokens.join(''), tokens.join('_')];
  return SENSITIVE_SUBSTRINGS.some((needle) => haystacks.some((h) => h.includes(needle)));
}

function maskAuthorizationValue(value: string): string {
  const match = /^(\S+)\s+(.+)$/.exec(value);
  return match ? `${match[1]} ${MASK}` : MASK;
}

export function maskCookieHeader(value: string, reveal: boolean): string {
  if (reveal) return value;
  return value
    .split(';')
    .map((part) => {
      const idx = part.indexOf('=');
      if (idx === -1) return part.trim();
      return `${part.slice(0, idx).trim()}=${MASK}`;
    })
    .join('; ');
}

export function maskSetCookie(value: string, reveal: boolean): string {
  if (reveal) return value;
  const [first = '', ...rest] = value.split(';');
  const idx = first.indexOf('=');
  const maskedFirst = idx === -1 ? first : `${first.slice(0, idx).trim()}=${MASK}`;
  return [maskedFirst, ...rest].join(';');
}

export function maskHeaders(
  headers: Record<string, string>,
  reveal: boolean,
): Record<string, string> {
  if (reveal) return { ...headers };
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (lower === 'cookie') {
      out[name] = maskCookieHeader(value, false);
    } else if (lower === 'set-cookie') {
      out[name] = maskSetCookie(value, false);
    } else if (lower === 'authorization' || lower === 'proxy-authorization') {
      out[name] = maskAuthorizationValue(value);
    } else if (isSensitiveFieldName(name)) {
      out[name] = MASK;
    } else {
      out[name] = value;
    }
  }
  return out;
}

function maskJsonNode(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(maskJsonNode);
  if (node !== null && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (isSensitiveFieldName(key) && (typeof value === 'string' || typeof value === 'number')) {
        out[key] = MASK;
      } else {
        out[key] = maskJsonNode(value);
      }
    }
    return out;
  }
  return node;
}

function maskJsonBody(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed !== null && typeof parsed === 'object') {
      return JSON.stringify(maskJsonNode(parsed));
    }
    return body;
  } catch {
    return body;
  }
}

function looksLikeJsonObjectOrArray(body: string): boolean {
  const trimmed = body.trim();
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return false;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed !== null && typeof parsed === 'object';
  } catch {
    return false;
  }
}

function looksLikeFormUrlEncoded(body: string): boolean {
  return /^[^\s=&]+=[^\s&]*(&[^\s=&]+=[^\s&]*)*$/.test(body);
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function maskFormUrlEncoded(body: string): string {
  return body
    .split('&')
    .map((pair) => {
      const idx = pair.indexOf('=');
      if (idx === -1) return pair;
      const key = safeDecodeURIComponent(pair.slice(0, idx));
      return isSensitiveFieldName(key) ? `${pair.slice(0, idx)}=${MASK}` : pair;
    })
    .join('&');
}

function maskMultipart(body: string, contentType: string): string {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2];
  if (!boundary) return body;
  const delimiter = `--${boundary}`;
  const segments = body.split(delimiter);
  const masked = segments.map((segment) => {
    const nameMatch = /name="([^"]*)"/i.exec(segment);
    const partName = nameMatch?.[1];
    if (partName === undefined || !isSensitiveFieldName(partName)) return segment;
    const blank = /\r?\n\r?\n/.exec(segment);
    if (!blank) return segment;
    const headerEnd = blank.index + blank[0].length;
    const headers = segment.slice(0, headerEnd);
    const rest = segment.slice(headerEnd);
    const trailing = /\r?\n$/.exec(rest)?.[0] ?? '';
    return `${headers}${MASK}${trailing}`;
  });
  return masked.join(delimiter);
}

export function maskBody(
  body: string,
  contentType: string | undefined,
  reveal: boolean,
): string {
  if (reveal) return body;
  const ct = (contentType ?? '').toLowerCase();

  if (ct.includes('multipart/form-data')) return maskMultipart(body, contentType ?? '');
  if (ct.includes('json')) return maskJsonBody(body);
  if (ct.includes('x-www-form-urlencoded')) return maskFormUrlEncoded(body);

  if (!ct) {
    if (looksLikeJsonObjectOrArray(body)) return maskJsonBody(body);
    if (looksLikeFormUrlEncoded(body)) return maskFormUrlEncoded(body);
  }
  return body;
}

/**
 * Values seen in password fields or passed via --secret, kept in memory only
 * so they can be scrubbed from any output that happens to echo them back
 * outside the structured masking above (e.g. a page title that leaked one).
 */
export class SecretRegistry {
  readonly #values = new Set<string>();

  // ponytail: values under 3 chars are ignored so common short page text
  // ("ok", "no") doesn't get mass-redacted; short secrets aren't realistic.
  add(value: string): void {
    if (value.length < 3) return;
    this.#values.add(value);
  }

  has(value: string): boolean {
    return this.#values.has(value);
  }

  get size(): number {
    return this.#values.size;
  }

  mask(text: string): string {
    if (!text || this.#values.size === 0) return text;
    const byLengthDesc = [...this.#values].sort((a, b) => b.length - a.length);
    return byLengthDesc.reduce((acc, value) => {
      const encoded = encodeURIComponent(value);
      const next = acc.replaceAll(value, MASK);
      return encoded === value ? next : next.replaceAll(encoded, MASK);
    }, text);
  }
}
