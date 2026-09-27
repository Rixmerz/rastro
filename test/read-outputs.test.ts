import { describe, expect, test } from 'vitest';
import { filterLines, normalizeText, regionRoots } from '../src/perception/read.ts';
import { project, selectJson } from '../src/flow/json-path.ts';
import { matchesRequestPattern, parseFlow, stringifyFlow } from '../src/flow/format.ts';
import { formatOutputs } from '../src/routines/result.ts';
import type { AriaNode } from '../src/core/types.ts';

describe('read helpers', () => {
  test('normalizes text: trims, drops icon glyphs, collapses blank runs', () => {
    expect(normalizeText('  Hola profe,  \n\n\n\n  ¿qué nota?  \n\n')).toBe('Hola profe,\n\n¿qué nota?');
  });

  test('find keeps matching lines with two lines of context', () => {
    const text = ['a', 'b', 'c', 'EV.2 Backend', 'd', 'e', 'f', 'g', 'h', 'EV.2 otra', 'i'].join('\n');
    expect(filterLines(text, 'ev.2')).toBe(['b', 'c', 'EV.2 Backend', 'd', 'e', '…', 'g', 'h', 'EV.2 otra', 'i'].join('\n'));
  });

  test('region roots are the outermost landmarks of that region', () => {
    const tree: AriaNode[] = [
      { role: 'generic', ref: 'e1', children: [
        { role: 'navigation', ref: 'e2', children: [{ role: 'navigation', ref: 'e3' }] },
        { role: 'complementary', ref: 'e4' },
        { role: 'navigation', ref: 'e5' },
      ] } as AriaNode,
    ];
    expect(regionRoots(tree, 'nav').map((n) => n.ref)).toEqual(['e2', 'e5']);
    expect(regionRoots(tree, 'aside').map((n) => n.ref)).toEqual(['e4']);
  });
});

describe('json path', () => {
  const inbox = { Body: { Conversations: [
    { Topic: 'EV.2 Backend', From: { Name: 'Nicol' }, Unread: 1 },
    { Topic: 'Capacitación', From: { Name: 'María' }, Unread: 0 },
  ] } };

  test('dotted names, indexes and [*]', () => {
    expect(selectJson(inbox, 'Body.Conversations[1].Topic')).toBe('Capacitación');
    expect(selectJson(inbox, 'Body.Conversations[*].From.Name')).toEqual(['Nicol', 'María']);
    expect(selectJson(inbox, 'Body.Missing')).toBeUndefined();
  });

  test('fields project each element', () => {
    expect(project(selectJson(inbox, 'Body.Conversations'), { from: 'From.Name', subject: 'Topic' })).toEqual([
      { from: 'Nicol', subject: 'EV.2 Backend' },
      { from: 'María', subject: 'Capacitación' },
    ]);
  });

  test('a JSON document nested in a string is parsed on the way', () => {
    expect(selectJson({ d: JSON.stringify([{ title: 'Clase' }]) }, 'd[0].title')).toBe('Clase');
  });
});

describe('flow steps with outputs', () => {
  const FLOW = `name: leer
steps:
  - open: https://mail.example/inbox
  - capture:
      request: "POST /owa/service.svc?action=FindConversation* 2xx"
      json: Body.Conversations
      fields: { from: From.Name, subject: Topic }
    as: bandeja
  - read: { region: main, find: "{{asunto}}" }
    as: cuerpo
`;

  test('read and capture parse, round-trip and keep their names', () => {
    const flow = parseFlow(FLOW);
    expect(flow.steps[1]).toMatchObject({ as: 'bandeja', capture: { json: 'Body.Conversations' } });
    expect(flow.steps[2]).toMatchObject({ as: 'cuerpo', read: { region: 'main', find: '{{asunto}}' } });
    expect(parseFlow(stringifyFlow(flow))).toEqual(flow);
  });

  test('an output needs a name, a unique one, and only read or capture have one', () => {
    expect(() => parseFlow(FLOW.replace('    as: cuerpo\n', ''))).toThrow(/read step names its output/);
    expect(() => parseFlow(FLOW.replace('as: cuerpo', 'as: bandeja'))).toThrow(/bandeja: named twice/);
    expect(() => parseFlow('name: x\nsteps:\n  - reload: true\n    as: y\n')).toThrow(/only read and capture/);
  });

  test('a request pattern with a query matches path and query', () => {
    const p = 'POST /owa/service.svc?action=FindConversation* 2xx';
    expect(matchesRequestPattern(p, { method: 'POST', url: 'https://o.test/owa/service.svc?action=FindConversation&app=Mail', status: 200 })).toBe(true);
    expect(matchesRequestPattern(p, { method: 'POST', url: 'https://o.test/owa/service.svc?action=GetItem&app=Mail', status: 200 })).toBe(false);
    expect(matchesRequestPattern('POST /owa/service.svc 2xx', { method: 'POST', url: 'https://o.test/owa/service.svc?action=GetItem', status: 200 })).toBe(true);
  });

  test('outputs print a string as a block and a list one line per item', () => {
    expect(formatOutputs({ cuerpo: 'Hola\nprofe', bandeja: [{ from: 'Nicol' }] })).toEqual(['cuerpo:', 'Hola\nprofe', 'bandeja: 1 item', '{"from":"Nicol"}']);
  });
});
