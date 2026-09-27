// A small JSON path for pulling what a caller wants out of an API response:
// dotted names, `[n]`, and `[*]`, which maps the rest of the path over each
// element of an array. A string met with path still to go is parsed as JSON,
// since some APIs (ASP.NET's `{ "d": "<json>" }`) nest a document in a string.

const TOKEN = /[^.[\]]+|\[\d+\]|\[\*\]/g;

function tokens(path: string): string[] {
  return path.trim() === '' ? [] : (path.match(TOKEN) ?? []);
}

function step(node: unknown, rest: string[]): unknown {
  if (rest.length === 0) return node;
  if (typeof node === 'string') {
    try {
      return step(JSON.parse(node), rest);
    } catch {
      return undefined;
    }
  }
  const [head, ...tail] = rest as [string, ...string[]];
  if (head === '[*]') {
    if (!Array.isArray(node)) return undefined;
    return node.map((el) => step(el, tail)).filter((v) => v !== undefined);
  }
  if (node === null || typeof node !== 'object') return undefined;
  if (head.startsWith('[')) {
    return Array.isArray(node) ? step(node[Number(head.slice(1, -1))], tail) : undefined;
  }
  return step((node as Record<string, unknown>)[head], tail);
}

export function selectJson(root: unknown, path: string): unknown {
  return step(root, tokens(path));
}

/** `{ name: path }` applied to each element of an array, or to one object. */
export function project(value: unknown, fields: Record<string, string>): unknown {
  const one = (el: unknown): Record<string, unknown> =>
    Object.fromEntries(Object.entries(fields).map(([name, path]) => [name, selectJson(el, path) ?? null]));
  return Array.isArray(value) ? value.map(one) : one(value);
}
