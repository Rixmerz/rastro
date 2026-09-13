import { describe, expect, test } from 'vitest';
import type { AriaNode } from '../src/core/types.ts';
import { estimateTokens } from '../src/format/text.ts';
import {
  buildView,
  findRef,
  formatView,
  interactiveItems,
  newInteractiveCount,
} from '../src/perception/view.ts';

// The exact page.ariaSnapshotJSON({ mode: 'ai' }) output documented for the
// task: nav (2 links), main (login form: 2 textboxes, a combobox with a
// selected option, a checkbox, a submit button, a paragraph) and a footer
// (1 link).
const SAMPLE: AriaNode[] = [
  {
    role: 'generic',
    active: true,
    ref: 'e1',
    children: [
      {
        role: 'navigation',
        ref: 'e2',
        children: [
          { role: 'link', name: 'X', ref: 'e3', cursor: 'pointer', url: '/x' },
          { role: 'link', name: 'Y', ref: 'e4', cursor: 'pointer', url: '/y' },
        ],
      },
      {
        role: 'main',
        ref: 'e5',
        children: [
          { role: 'heading', name: 'Login', level: 1, ref: 'e6' },
          {
            role: 'generic',
            ref: 'e7',
            children: [
              { role: 'textbox', name: 'Email', ref: 'e8' },
              { role: 'textbox', name: 'Pass', ref: 'e9' },
              {
                role: 'combobox',
                name: 'Pais',
                ref: 'e10',
                children: [{ role: 'option', name: 'CL', selected: true }],
              },
              { role: 'checkbox', name: 'Recordar', ref: 'e11' },
              { role: 'button', name: 'Entrar', ref: 'e12' },
            ],
          },
          { role: 'paragraph', ref: 'e13', text: 'texto' },
        ],
      },
      {
        role: 'contentinfo',
        ref: 'e14',
        children: [{ role: 'link', name: 'Z', ref: 'e15', cursor: 'pointer', url: '/z' }],
      },
    ],
  },
];

function nav42(): AriaNode[] {
  const links: AriaNode[] = Array.from({ length: 42 }, (_, i) => ({
    role: 'link',
    name: `Link ${i}`,
    ref: `e${i + 1}`,
    url: `/l${i}`,
  }));
  return [{ role: 'navigation', ref: 'e0', children: links }];
}

describe('interactiveItems', () => {
  test('flattens the sample tree with regions in document order', () => {
    const items = interactiveItems(SAMPLE);
    expect(items.map((i) => [i.ref, i.role, i.region]))
      .toEqual([
        ['e3', 'link', 'nav'],
        ['e4', 'link', 'nav'],
        ['e8', 'textbox', 'main'],
        ['e9', 'textbox', 'main'],
        ['e10', 'combobox', 'main'],
        ['e11', 'checkbox', 'main'],
        ['e12', 'button', 'main'],
        ['e15', 'link', 'footer'],
      ]);
    const combobox = items.find((i) => i.ref === 'e10');
    expect(combobox?.selected).toBe('CL');
  });

  test('heading and paragraph are excluded (not interactive roles)', () => {
    const refs = interactiveItems(SAMPLE).map((i) => i.ref);
    expect(refs).not.toContain('e6');
    expect(refs).not.toContain('e13');
  });

  test('options inside a combobox have no ref and are never their own item', () => {
    const items = interactiveItems(SAMPLE);
    expect(items.some((i) => i.name === 'CL')).toBe(false);
  });
});

describe('formatView — sample page', () => {
  test('exact expected text, no urls', () => {
    const view = buildView({ url: 'https://example.test/login', title: 'Login', tree: SAMPLE });
    const text = formatView(view);
    expect(text).toBe(
      [
        'https://example.test/login · «Login»',
        'nav: [e3] link «X» · [e4] link «Y»',
        'main: [e8] textbox «Email» · [e9] textbox «Pass» · [e10] combobox «Pais» =«CL» · [e11] checkbox «Recordar» · [e12] button «Entrar»',
        'footer: [e15] link «Z»',
      ].join('\n'),
    );
  });

  test('link urls only appear with urls: true', () => {
    const view = buildView({ url: 'https://example.test/login', title: 'Login', tree: SAMPLE });
    const text = formatView(view, { urls: true });
    expect(text).toContain('[e3] link «X» → /x');
    expect(text).toContain('[e15] link «Z» → /z');
  });
});

describe('region collapsing', () => {
  test('a region with 42 links collapses to a role count with a hint', () => {
    const view = buildView({ url: 'https://example.test/', title: 'Home', tree: nav42() });
    expect(view.regions).toHaveLength(1);
    expect(view.regions[0]).toMatchObject({ name: 'nav', collapsed: true });
    const text = formatView(view);
    expect(text).toContain('nav: 42 links (rastro view --region nav)');
  });

  test('--region nav expands all 42, one per line', () => {
    const view = buildView({ url: 'https://example.test/', title: 'Home', tree: nav42() }, { region: 'nav' });
    expect(view.regions[0]?.collapsed).toBe(false);
    expect(view.regions[0]?.items).toHaveLength(42);
    const text = formatView(view, { expanded: true });
    const lines = text.split('\n');
    expect(lines[1]).toBe('nav:');
    expect(lines).toContain('  [e1] link «Link 0»');
    // one item per line, indented by two spaces
    expect(lines.filter((l) => l.startsWith('  [e')).length).toBe(42);
  });

  test('a region at exactly the threshold (8) is not collapsed', () => {
    const links: AriaNode[] = Array.from({ length: 8 }, (_, i) => ({
      role: 'link',
      name: `L${i}`,
      ref: `e${i + 1}`,
    }));
    const view = buildView({ url: 'u', title: 't', tree: [{ role: 'navigation', ref: 'e0', children: links }] });
    expect(view.regions[0]?.collapsed).toBe(false);
  });
});

describe('find filter', () => {
  test('matches by substring, case-insensitive', () => {
    const view = buildView({ url: 'u', title: 't', tree: SAMPLE }, { find: 'entrar' });
    expect(view.regions).toHaveLength(1);
    expect(view.regions[0]?.items.map((i) => i.ref)).toEqual(['e12']);
  });

  test('normalises case but not diacritics: query with ñ matches name with ñ', () => {
    const tree: AriaNode[] = [{ role: 'textbox', name: 'Contraseña', ref: 'e1' }];
    const view = buildView({ url: 'u', title: 't', tree }, { find: 'contraseña' });
    expect(view.regions[0]?.items.map((i) => i.ref)).toEqual(['e1']);
  });

  test('does not strip diacritics: query without ñ does not match name with ñ', () => {
    const tree: AriaNode[] = [{ role: 'textbox', name: 'Contraseña', ref: 'e1' }];
    const view = buildView({ url: 'u', title: 't', tree }, { find: 'Contrasena' });
    expect(view.regions).toHaveLength(0);
  });

  test('found regions are never collapsed and empty regions are dropped', () => {
    const view = buildView({ url: 'u', title: 't', tree: nav42() }, { find: 'Link 1' });
    // "Link 1", "Link 10".."Link 19", "Link 1" substring also inside e.g. Link 21? no.
    expect(view.regions[0]?.collapsed).toBe(false);
    expect(view.regions).toHaveLength(1);
  });
});

describe('region ordering', () => {
  test('dialog, header, nav, search, main, aside, page, footer', () => {
    const tree: AriaNode[] = [
      { role: 'contentinfo', ref: 'e1', children: [{ role: 'link', name: 'F', ref: 'e2' }] },
      { role: 'complementary', ref: 'e3', children: [{ role: 'link', name: 'A', ref: 'e4' }] },
      { role: 'main', ref: 'e5', children: [{ role: 'link', name: 'M', ref: 'e6' }] },
      { role: 'search', ref: 'e7', children: [{ role: 'searchbox', name: 'S', ref: 'e8' }] },
      { role: 'navigation', ref: 'e9', children: [{ role: 'link', name: 'N', ref: 'e10' }] },
      { role: 'banner', ref: 'e11', children: [{ role: 'link', name: 'H', ref: 'e12' }] },
      { role: 'dialog', ref: 'e13', children: [{ role: 'button', name: 'D', ref: 'e14' }] },
      { role: 'button', name: 'P', ref: 'e15' },
    ];
    const view = buildView({ url: 'u', title: 't', tree });
    expect(view.regions.map((r) => r.name)).toEqual([
      'dialog',
      'header',
      'nav',
      'search',
      'main',
      'aside',
      'page',
      'footer',
    ]);
  });

  test('a named form does not introduce its own region', () => {
    const tree: AriaNode[] = [
      {
        role: 'main',
        ref: 'e1',
        children: [
          {
            role: 'form',
            name: 'Login form',
            ref: 'e2',
            children: [{ role: 'button', name: 'Go', ref: 'e3' }],
          },
        ],
      },
    ];
    const view = buildView({ url: 'u', title: 't', tree });
    expect(view.regions.map((r) => r.name)).toEqual(['main']);
  });
});

describe('state markers', () => {
  test('checked, mixed, disabled, expanded, combobox selected', () => {
    const tree: AriaNode[] = [
      { role: 'checkbox', name: 'A', ref: 'e1', checked: true },
      { role: 'checkbox', name: 'B', ref: 'e2', checked: 'mixed' },
      { role: 'button', name: 'C', ref: 'e3', disabled: true },
      { role: 'button', name: 'D', ref: 'e4', expanded: true },
      {
        role: 'combobox',
        name: 'E',
        ref: 'e5',
        children: [{ role: 'option', name: 'V1' }, { role: 'option', name: 'V2', selected: true }],
      },
    ];
    const view = buildView({ url: 'u', title: 't', tree });
    const text = formatView(view);
    expect(text).toContain('[e1] checkbox «A» [x]');
    expect(text).toContain('[e2] checkbox «B» [-]');
    expect(text).toContain('[e3] button «C» (disabled)');
    expect(text).toContain('[e4] button «D» (expanded)');
    expect(text).toContain('[e5] combobox «E» =«V2»');
  });
});

describe('page-originated names get quoted and sanitised', () => {
  test('a name containing « and newlines is cleaned and delimited', () => {
    const tree: AriaNode[] = [{ role: 'button', name: 'Say «hi»\nnow', ref: 'e1' }];
    const view = buildView({ url: 'u', title: 't', tree });
    const text = formatView(view);
    expect(text).toContain('[e1] button «Say ‹hi› now»');
    expect(text).not.toContain('\n  [e1]'); // no raw newline leaked into the line
  });
});

describe('no interactive elements', () => {
  test('prints a dedicated line', () => {
    const view = buildView({ url: 'u', title: 't', tree: [{ role: 'heading', name: 'Hi', level: 1, ref: 'e1' }] });
    expect(formatView(view)).toBe('u · «t»\n(no interactive elements)');
  });
});

describe('findRef', () => {
  test('finds a nested ref', () => {
    expect(findRef(SAMPLE, 'e10')?.role).toBe('combobox');
    expect(findRef(SAMPLE, 'e999')).toBeNull();
  });
});

describe('newInteractiveCount', () => {
  test('counts every item when before is null', () => {
    expect(newInteractiveCount(null, SAMPLE)).toBe(interactiveItems(SAMPLE).length);
  });

  test('counts only refs absent from before', () => {
    const before: AriaNode[] = [{ role: 'button', name: 'A', ref: 'e1' }];
    const after: AriaNode[] = [
      { role: 'button', name: 'A', ref: 'e1' },
      { role: 'button', name: 'B', ref: 'e2' },
    ];
    expect(newInteractiveCount(before, after)).toBe(1);
  });
});

describe('token budget', () => {
  test('a login-like page (2 nav links, 3 form controls, 9 footer links) formats to at most 400 tokens', () => {
    const footerLinks: AriaNode[] = Array.from({ length: 9 }, (_, i) => ({
      role: 'link',
      name: `Foot ${i}`,
      ref: `f${i + 1}`,
      url: `/foot${i}`,
    }));
    const tree: AriaNode[] = [
      {
        role: 'navigation',
        ref: 'n0',
        children: [
          { role: 'link', name: 'Home', ref: 'n1' },
          { role: 'link', name: 'About', ref: 'n2' },
        ],
      },
      {
        role: 'main',
        ref: 'm0',
        children: [
          { role: 'textbox', name: 'Email', ref: 'm1' },
          { role: 'textbox', name: 'Password', ref: 'm2' },
          { role: 'button', name: 'Sign in', ref: 'm3' },
        ],
      },
      { role: 'contentinfo', ref: 'f0', children: footerLinks },
    ];
    const view = buildView({ url: 'https://example.test/login', title: 'Login', tree });
    const text = formatView(view);
    expect(estimateTokens(text)).toBeLessThanOrEqual(400);
  });
});
