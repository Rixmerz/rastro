// In-page locator bundle capture and resolution: turns a live Playwright
// Locator into the durable `LocatorBundle` stored with an action, and turns a
// stored bundle back into a fresh Locator (used for flow replay and as the
// fallback when a ref no longer resolves).

import type { Frame, Locator, Page } from 'playwright-core';
import type { AriaNode, LocatorBundle } from '../core/types.ts';
import { RastroError } from '../core/types.ts';

type Locatable = Page | Frame;

interface CapturedInPage {
  testId?: string;
  id?: string;
  label?: string;
  placeholder?: string;
  tag?: string;
  inputType?: string;
  text?: string;
  css: string;
}

/** Runs in the page; keep this free of references to outer-scope bindings
 * other than its own argument, since Playwright serializes it to the page. */
function captureInPage(el: Element): CapturedInPage {
  const attr = (name: string): string | undefined => el.getAttribute(name) ?? undefined;
  const testId = attr('data-testid') ?? attr('data-test') ?? attr('data-qa');
  const id = el.id || undefined;

  let label: string | undefined;
  const labelledby = attr('aria-labelledby');
  if (labelledby) {
    label =
      labelledby
        .split(/\s+/)
        .map((refId) => document.getElementById(refId)?.textContent?.trim())
        .filter((t): t is string => Boolean(t))
        .join(' ') || undefined;
  } else if ('labels' in el) {
    const labels = (el as HTMLInputElement).labels;
    if (labels && labels.length > 0) {
      label = Array.from(labels).map((l) => l.textContent?.trim()).filter(Boolean).join(' ') || undefined;
    }
  }

  const placeholder = attr('placeholder');
  const tag = el.tagName.toLowerCase();
  const inputType = tag === 'input' ? (attr('type') ?? 'text') : undefined;
  const text = (el.textContent ?? '').trim().slice(0, 80) || undefined;

  function cssPath(node: Element): string {
    if (node.id) return `#${CSS.escape(node.id)}`;
    const nodeTestId = node.getAttribute('data-testid') ?? node.getAttribute('data-test') ?? node.getAttribute('data-qa');
    if (nodeTestId) return `[data-testid="${nodeTestId}"]`;
    const parent = node.parentElement;
    if (!parent) return node.tagName.toLowerCase();
    const siblings = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
    const nth = siblings.indexOf(node) + 1;
    const parentPath = parent === document.body ? 'body' : cssPath(parent);
    return `${parentPath} > ${node.tagName.toLowerCase()}:nth-of-type(${nth})`;
  }

  return { testId, id, label, placeholder, tag, inputType, text, css: cssPath(el) };
}

/** Captures a durable bundle for `locator`. `node` supplies role/name from the
 * accessibility snapshot the caller already has; everything else comes from
 * a single in-page evaluation. */
export async function captureBundle(locator: Locator, node?: AriaNode): Promise<LocatorBundle> {
  const captured = await locator.evaluate(captureInPage);

  const bundle: LocatorBundle = { css: captured.css };
  if (node?.role) bundle.role = node.role;
  if (node?.name) bundle.name = node.name;
  if (captured.testId !== undefined) bundle.testId = captured.testId;
  if (captured.id !== undefined) bundle.id = captured.id;
  if (captured.label !== undefined) bundle.label = captured.label;
  if (captured.placeholder !== undefined) bundle.placeholder = captured.placeholder;
  if (captured.tag !== undefined) bundle.tag = captured.tag;
  if (captured.inputType !== undefined) bundle.inputType = captured.inputType;
  if (captured.text !== undefined) bundle.text = captured.text;

  const handle = await locator.elementHandle();
  const frame = await handle?.ownerFrame();
  if (frame && frame !== frame.page().mainFrame()) bundle.frame = frame.url();
  await handle?.dispose();

  return bundle;
}

async function uniqueOrNull(locator: Locator): Promise<Locator | null> {
  return (await locator.count()) === 1 ? locator : null;
}

/** Resolves a stored bundle back into a Locator, trying the most specific
 * strategy first and accepting the first one that matches exactly one
 * element. */
export async function resolveBundle(page: Page, b: LocatorBundle): Promise<Locator> {
  const scope: Locatable = b.frame ? (page.frame({ url: b.frame }) ?? page) : page;

  const attempts: (() => Locator)[] = [];
  if (b.role) {
    const role = b.role as Parameters<Locatable['getByRole']>[0];
    attempts.push(() => scope.getByRole(role, b.name !== undefined ? { name: b.name, exact: true } : undefined));
  }
  if (b.testId) attempts.push(() => scope.getByTestId(b.testId!));
  if (b.label) attempts.push(() => scope.getByLabel(b.label!, { exact: true }));
  if (b.placeholder) attempts.push(() => scope.getByPlaceholder(b.placeholder!, { exact: true }));
  if (b.text) attempts.push(() => scope.getByText(b.text!, { exact: true }));
  if (b.css) attempts.push(() => scope.locator(b.css!));

  for (const attempt of attempts) {
    const found = await uniqueOrNull(attempt());
    if (found) return found;
  }

  throw new RastroError(`locator for ${JSON.stringify(b)} not found`, 'run rastro view');
}
