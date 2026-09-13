// Builds and formats the "minimal view": the subset of the accessibility tree
// an agent needs to act on a page — interactive elements only, grouped by
// landmark region, collapsed when a region is too large to read at once.

import type { AriaNode, ViewParams } from '../core/types.ts';
import { quote } from '../format/text.ts';

export const INTERACTIVE_ROLES: ReadonlySet<string> = new Set([
  'link',
  'button',
  'textbox',
  'searchbox',
  'combobox',
  'listbox',
  'option',
  'checkbox',
  'radio',
  'switch',
  'slider',
  'spinbutton',
  'tab',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'treeitem',
]);

export interface ViewItem {
  ref: string;
  role: string;
  name: string;
  region: string;
  url?: string;
  checked?: boolean | 'mixed';
  disabled?: boolean;
  expanded?: boolean;
  /** Selected option name for comboboxes. */
  selected?: string;
}

export interface ViewRegion {
  name: string;
  items: ViewItem[];
  counts: Record<string, number>;
  collapsed: boolean;
}

export interface MinimalView {
  url: string;
  title: string;
  regions: ViewRegion[];
  total: number;
}

/** Landmark roles that introduce a new region for their descendants. `form` is
 * deliberately absent: even a named form stays in whatever region it was
 * already in. */
const LANDMARK_REGION: Readonly<Record<string, string>> = {
  dialog: 'dialog',
  alertdialog: 'dialog',
  banner: 'header',
  navigation: 'nav',
  main: 'main',
  complementary: 'aside',
  contentinfo: 'footer',
  search: 'search',
};

/** Output order for regions, independent of first-seen order in the tree. */
const REGION_ORDER = ['dialog', 'header', 'nav', 'search', 'main', 'aside', 'page', 'footer'];

function comboboxSelected(node: AriaNode): string | undefined {
  const option = node.children?.find((child) => child.role === 'option' && child.selected === true);
  return option?.name;
}

function walk(node: AriaNode, region: string, out: ViewItem[]): void {
  if (node.ref && INTERACTIVE_ROLES.has(node.role)) {
    const item: ViewItem = { ref: node.ref, role: node.role, name: node.name ?? '', region };
    if (node.url !== undefined) item.url = node.url;
    if (node.checked !== undefined) item.checked = node.checked;
    if (node.disabled !== undefined) item.disabled = node.disabled;
    if (node.expanded !== undefined) item.expanded = node.expanded;
    if (node.role === 'combobox') {
      const selected = comboboxSelected(node);
      if (selected !== undefined) item.selected = selected;
    }
    out.push(item);
  }
  const childRegion = LANDMARK_REGION[node.role] ?? region;
  for (const child of node.children ?? []) {
    walk(child, childRegion, out);
  }
}

/** Flattens the tree into every interactive element, each tagged with its
 * landmark region, in document order. */
export function interactiveItems(tree: AriaNode[]): ViewItem[] {
  const out: ViewItem[] = [];
  for (const node of tree) {
    walk(node, 'page', out);
  }
  return out;
}

function normalize(text: string): string {
  return text.normalize('NFC').toLowerCase();
}

function pluralizeRole(role: string): string {
  return /(?:x|ch|sh)$/.test(role) ? `${role}es` : `${role}s`;
}

export function buildView(
  input: { url: string; title: string; tree: AriaNode[] },
  opts: ViewParams & { collapseOver?: number } = {},
): MinimalView {
  const collapseOver = opts.collapseOver ?? 8;
  let items = interactiveItems(input.tree);

  if (opts.find) {
    const needle = normalize(opts.find);
    items = items.filter((item) => normalize(item.name).includes(needle));
  }
  if (opts.region) {
    items = items.filter((item) => item.region === opts.region);
  }
  const neverCollapse = Boolean(opts.find) || Boolean(opts.region);

  const byRegion = new Map<string, ViewItem[]>();
  for (const item of items) {
    const bucket = byRegion.get(item.region);
    if (bucket) bucket.push(item);
    else byRegion.set(item.region, [item]);
  }

  const regions: ViewRegion[] = [];
  for (const name of REGION_ORDER) {
    const regionItems = byRegion.get(name);
    if (!regionItems || regionItems.length === 0) continue;
    const counts: Record<string, number> = {};
    for (const item of regionItems) counts[item.role] = (counts[item.role] ?? 0) + 1;
    const collapsed = !neverCollapse && regionItems.length > collapseOver;
    regions.push({ name, items: collapsed ? [] : regionItems, counts, collapsed });
  }

  return { url: input.url, title: input.title, regions, total: items.length };
}

function formatCounts(counts: Record<string, number>): string {
  return Object.entries(counts)
    .sort(([roleA, a], [roleB, b]) => b - a || roleA.localeCompare(roleB))
    .map(([role, count]) => `${count} ${pluralizeRole(role)}`)
    .join(' · ');
}

function formatItem(item: ViewItem, opts: { urls?: boolean }): string {
  let text = `[${item.ref}] ${item.role} ${quote(item.name)}`;
  if (item.checked === true) text += ' [x]';
  else if (item.checked === 'mixed') text += ' [-]';
  if (item.disabled) text += ' (disabled)';
  if (item.expanded) text += ' (expanded)';
  if (item.selected !== undefined) text += ` =${quote(item.selected)}`;
  if (opts.urls && item.url) text += ` → ${item.url}`;
  return text;
}

export function formatView(view: MinimalView, opts: { urls?: boolean; expanded?: boolean } = {}): string {
  const lines = [`${view.url} · ${quote(view.title)}`];

  if (view.regions.length === 0) {
    lines.push('(no interactive elements)');
    return lines.join('\n');
  }

  for (const region of view.regions) {
    if (region.collapsed) {
      lines.push(`${region.name}: ${formatCounts(region.counts)} (rastro view --region ${region.name})`);
      continue;
    }
    if (opts.expanded) {
      lines.push(`${region.name}:`);
      for (const item of region.items) lines.push(`  ${formatItem(item, opts)}`);
    } else {
      lines.push(`${region.name}: ${region.items.map((item) => formatItem(item, opts)).join(' · ')}`);
    }
  }

  return lines.join('\n');
}

export function findRef(tree: AriaNode[], ref: string): AriaNode | null {
  for (const node of tree) {
    if (node.ref === ref) return node;
    const found = findRef(node.children ?? [], ref);
    if (found) return found;
  }
  return null;
}

export function newInteractiveCount(before: AriaNode[] | null, after: AriaNode[]): number {
  const afterRefs = interactiveItems(after);
  if (before === null) return afterRefs.length;
  const beforeRefs = new Set(interactiveItems(before).map((item) => item.ref));
  return afterRefs.filter((item) => !beforeRefs.has(item.ref)).length;
}
