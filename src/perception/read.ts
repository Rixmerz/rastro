// Reads the text a person sees, which the minimal view deliberately leaves
// out: `view` lists what can be acted on, and a mail body or a paragraph is
// not. Regions are the view's own (main, aside, nav, dialog...), resolved
// through the same aria refs, so what `view` names `read` can open.

import type { Locator, Page } from 'playwright-core';
import type { AriaNode } from '../core/types.ts';
import { RastroError } from '../core/types.ts';
import { LANDMARK_REGION } from './view.ts';

export const DEFAULT_READ_MAX = 12_000;
const CONTEXT_LINES = 2;

export interface ReadOptions {
  region?: string | undefined;
  /** A single element instead of a region. */
  locator?: Locator | undefined;
  find?: string | undefined;
  max?: number | undefined;
  timeoutMs?: number | undefined;
}

export interface ReadResult {
  text: string;
  /** The region read, or `element` for a locator. */
  region: string;
  chars: number;
  truncated: boolean;
}

/** Outermost landmark nodes of `region`, in document order. */
export function regionRoots(tree: AriaNode[], region: string): AriaNode[] {
  const out: AriaNode[] = [];
  const walk = (node: AriaNode): void => {
    if (node.ref && LANDMARK_REGION[node.role] === region) {
      out.push(node);
      return;
    }
    for (const child of node.children ?? []) walk(child);
  };
  for (const node of tree) walk(node);
  return out;
}

/** Trims lines, drops icon-font glyphs (private use area) and collapses runs
 * of blank lines, so what is left reads like the page does. */
export function normalizeText(raw: string): string {
  const lines = raw
    .replace(/[-]/g, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim());
  const out: string[] = [];
  for (const line of lines) {
    if (line === '' && (out.length === 0 || out.at(-1) === '')) continue;
    out.push(line);
  }
  while (out.at(-1) === '') out.pop();
  return out.join('\n');
}

/** The lines holding `needle`, each with two lines around it; separate
 * stretches are joined by an ellipsis line. */
export function filterLines(text: string, needle: string): string {
  const lines = text.split('\n');
  const want = needle.normalize('NFC').toLowerCase();
  const keep = new Set<number>();
  lines.forEach((line, i) => {
    if (!line.normalize('NFC').toLowerCase().includes(want)) return;
    for (let j = Math.max(0, i - CONTEXT_LINES); j <= Math.min(lines.length - 1, i + CONTEXT_LINES); j++) keep.add(j);
  });
  const out: string[] = [];
  let last = -2;
  for (const i of [...keep].sort((a, b) => a - b)) {
    if (i !== last + 1 && out.length > 0) out.push('…');
    out.push(lines[i]!);
    last = i;
  }
  return out.join('\n');
}

export async function readText(page: Page, opts: ReadOptions = {}): Promise<ReadResult> {
  const timeout = opts.timeoutMs ?? 10_000;
  let region: string;
  let raw: string;

  if (opts.locator) {
    region = 'element';
    raw = await opts.locator.first().innerText({ timeout });
  } else {
    const wanted = opts.region ?? 'main';
    const tree = (await page.ariaSnapshotJSON({ mode: 'ai' })) as unknown as AriaNode[];
    const roots = wanted === 'page' ? [] : regionRoots(tree, wanted);
    if (roots.length > 0) {
      region = wanted;
      const parts: string[] = [];
      for (const root of roots) parts.push(await page.locator(`aria-ref=${root.ref!}`).innerText({ timeout }));
      raw = parts.join('\n\n');
    } else if (wanted === 'page' || opts.region === undefined) {
      region = 'page';
      raw = await page.locator('body').innerText({ timeout });
    } else {
      throw new RastroError(`no ${wanted} region on this page`, 'rastro view lists the regions it has');
    }
  }

  let text = normalizeText(raw);
  if (opts.find) {
    text = filterLines(text, opts.find);
    if (text === '') throw new RastroError(`"${opts.find}" is not in the ${region} text`, 'try another --region, or rastro read with no --find');
  }
  const max = opts.max ?? DEFAULT_READ_MAX;
  const chars = text.length;
  const truncated = chars > max;
  if (truncated) {
    text = `${text.slice(0, max)}\n… ${chars - max} more characters cut; narrow it with --find <text>, --ref <ref> or a raised --max`;
  }
  return { text, region, chars, truncated };
}
