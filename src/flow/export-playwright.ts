// Turns a Flow into a @playwright/test spec file. Pure string generation:
// no filesystem access, no Playwright import.

import type { Condition, Expect, Flow, FlowParam, FlowStep, Target } from './format.ts';
import { parseRequestPattern, stepKind } from './format.ts';

// The suffix appended to a URL-assertion path so a path match doesn't also
// match a longer path that merely starts with it.
const URL_SUFFIX_LITERAL = "'(\\?|$|#)'";

function cssEscapeIdent(id: string): string {
  // ponytail: covers the punctuation CSS.escape would touch in an element id;
  // not a full CSS.escape port (unavailable outside a DOM), fine for ids.
  return id.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
}

function baseLocator(target: Target): string {
  if (target.role && target.name) {
    return `page.getByRole(${JSON.stringify(target.role)}, { name: ${JSON.stringify(target.name)}, exact: true })`;
  }
  if (target.role) return `page.getByRole(${JSON.stringify(target.role)})`;
  if (target.label) return `page.getByLabel(${JSON.stringify(target.label)})`;
  if (target.testId) return `page.getByTestId(${JSON.stringify(target.testId)})`;
  if (target.placeholder) return `page.getByPlaceholder(${JSON.stringify(target.placeholder)})`;
  if (target.text) return `page.getByText(${JSON.stringify(target.text)}, { exact: true })`;
  if (target.css) return `page.locator(${JSON.stringify(target.css)})`;
  if (target.id) return `page.locator(${JSON.stringify(`#${cssEscapeIdent(target.id)}`)})`;
  throw new Error('target has no locator field');
}

export function bundleToLocator(target: Target): string {
  const base = baseLocator(target);
  if (!target.frame) return base;

  let src: string;
  try {
    const url = new URL(target.frame);
    src = `${url.host}${url.pathname}`;
  } catch {
    src = target.frame;
  }
  const frameExpr = `page.frameLocator(${JSON.stringify(`iframe[src*="${src}"]`)})`;
  return base.startsWith('page.') ? `${frameExpr}.${base.slice('page.'.length)}` : base;
}

function escapeRegExpLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// S8 (CWE-94): `condition.request` isn't validated as a request pattern (it
// only needs to match something at run time, see `checkExpect`), so it can
// contain anything — including a newline that would close the `//` comment
// this is emitted into and let the rest of the line run as code.
function commentSafe(text: string): string {
  return text.replace(/[\r\n]+/g, ' ');
}

function toHaveUrlLine(indent: string, path: string): string {
  return `${indent}await expect(page).toHaveURL(new RegExp(${JSON.stringify(escapeRegExpLiteral(path))} + ${URL_SUFFIX_LITERAL}));`;
}

function waitForUrlLine(indent: string, path: string): string {
  return `${indent}await page.waitForURL(new RegExp(${JSON.stringify(escapeRegExpLiteral(path))} + ${URL_SUFFIX_LITERAL}));`;
}

function valueExprFor(value: string): string {
  const soleParam = /^\{\{\s*([a-zA-Z0-9_]+)\s*\}\}$/.exec(value);
  if (soleParam) return soleParam[1]!;
  if (value.includes('{{')) {
    const body = value
      .replace(/\\/g, '\\\\')
      .replace(/`/g, '\\`')
      .replace(/\$\{/g, '\\${')
      .replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, '${$1}');
    return `\`${body}\``;
  }
  return JSON.stringify(value);
}

// A small local mirror of format.ts's glob translation: that one produces a
// boolean match, this one has to produce the *source text* of a RegExp
// constructor call embedded in generated code, so it isn't the same function.
function regexSourceForGlob(glob: string): string {
  return glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
}

function waitForResponseExpr(pattern: string): string {
  const { method, path, status } = parseRequestPattern(pattern);
  const pathExpr = path.includes('*')
    ? `new RegExp(${JSON.stringify(`^${regexSourceForGlob(path)}$`)}).test(new URL(r.url()).pathname)`
    : `new URL(r.url()).pathname === ${JSON.stringify(path)}`;
  const statusExpr =
    status.exact !== undefined
      ? `r.status() === ${status.exact}`
      : `r.status() >= ${(status.klass ?? 0) * 100} && r.status() < ${((status.klass ?? 0) + 1) * 100}`;
  return `page.waitForResponse((r) => r.request().method() === ${JSON.stringify(method)} && ${pathExpr} && ${statusExpr})`;
}

interface RespCounter {
  n: number;
}

function emitActionLines(indent: string, actionExpr: string, expect: Expect | undefined, resp: RespCounter): string[] {
  const lines: string[] = [];
  const requests = expect?.requests ?? [];

  if (requests.length > 0) {
    const names = requests.map(() => `resp${++resp.n}`);
    lines.push(`${indent}const [${names.join(', ')}] = await Promise.all([`);
    for (const pattern of requests) lines.push(`${indent}  ${waitForResponseExpr(pattern)},`);
    lines.push(`${indent}  ${actionExpr},`);
    lines.push(`${indent}]);`);
  } else {
    lines.push(`${indent}await ${actionExpr};`);
  }

  if (expect?.url !== undefined) lines.push(toHaveUrlLine(indent, expect.url));
  return lines;
}

function emitWait(indent: string, wait: { text?: string; url?: string; ms?: number }): string[] {
  const lines: string[] = [];
  if (wait.text !== undefined) lines.push(`${indent}await expect(page.getByText(${JSON.stringify(wait.text)})).toBeVisible();`);
  if (wait.url !== undefined) lines.push(waitForUrlLine(indent, wait.url));
  if (wait.ms !== undefined) lines.push(`${indent}await page.waitForTimeout(${wait.ms});`);
  return lines;
}

function emitAssert(indent: string, condition: Condition): string[] {
  if (condition.text !== undefined) {
    return [`${indent}await expect(page.getByText(${JSON.stringify(condition.text)})).toBeVisible();`];
  }
  if (condition.url !== undefined) return [toHaveUrlLine(indent, condition.url)];
  if (condition.request !== undefined) {
    return [`${indent}// assert request ${commentSafe(condition.request)} (checked at recording time)`];
  }
  return [];
}

function emitIf(
  indent: string,
  step: { if: Condition; then: FlowStep[]; else?: FlowStep[] },
  resp: RespCounter,
): string[] {
  const condition = step.if;
  if (condition.request !== undefined) {
    return [`${indent}// if request ${commentSafe(condition.request)} (checked at recording time) — not exportable, step skipped`];
  }

  const predicate =
    condition.text !== undefined
      ? `await page.getByText(${JSON.stringify(condition.text)}).isVisible()`
      : condition.url !== undefined
        ? `new URL(page.url()).pathname === ${JSON.stringify(condition.url)}`
        : 'true';

  const lines: string[] = [`${indent}if (${predicate}) {`, ...emitSteps(step.then, `${indent}  `, resp)];
  if (step.else && step.else.length > 0) {
    lines.push(`${indent}} else {`, ...emitSteps(step.else, `${indent}  `, resp));
  }
  lines.push(`${indent}}`);
  return lines;
}

function emitStep(step: FlowStep, indent: string, resp: RespCounter): string[] {
  const kind = stepKind(step);
  const raw = step as unknown as Record<string, unknown>;
  const expect = raw['expect'] as Expect | undefined;

  switch (kind) {
    case 'open':
      return emitActionLines(indent, `page.goto(${valueExprFor(raw['open'] as string)})`, expect, resp);
    case 'goto':
      return emitActionLines(indent, `page.goto(${valueExprFor(raw['goto'] as string)})`, expect, resp);
    case 'back':
      return emitActionLines(indent, 'page.goBack()', expect, resp);
    case 'forward':
      return emitActionLines(indent, 'page.goForward()', expect, resp);
    case 'reload':
      return emitActionLines(indent, 'page.reload()', expect, resp);
    case 'click':
      return emitActionLines(indent, `${bundleToLocator(raw['click'] as Target)}.click()`, expect, resp);
    case 'dblclick':
      return emitActionLines(indent, `${bundleToLocator(raw['dblclick'] as Target)}.dblclick()`, expect, resp);
    case 'hover':
      return emitActionLines(indent, `${bundleToLocator(raw['hover'] as Target)}.hover()`, expect, resp);
    case 'check':
      return emitActionLines(indent, `${bundleToLocator(raw['check'] as Target)}.check()`, expect, resp);
    case 'uncheck':
      return emitActionLines(indent, `${bundleToLocator(raw['uncheck'] as Target)}.uncheck()`, expect, resp);
    case 'fill':
      return emitActionLines(
        indent,
        `${bundleToLocator(raw['fill'] as Target)}.fill(${valueExprFor(raw['value'] as string)})`,
        expect,
        resp,
      );
    case 'type':
      return emitActionLines(
        indent,
        `${bundleToLocator(raw['type'] as Target)}.pressSequentially(${valueExprFor(raw['value'] as string)})`,
        expect,
        resp,
      );
    case 'upload':
      return emitActionLines(
        indent,
        `${bundleToLocator(raw['upload'] as Target)}.setInputFiles(${valueExprFor(raw['value'] as string)})`,
        expect,
        resp,
      );
    case 'select':
      return emitActionLines(
        indent,
        `${bundleToLocator(raw['select'] as Target)}.selectOption(${valueExprFor(raw['value'] as string)})`,
        expect,
        resp,
      );
    case 'press': {
      const key = raw['press'] as string;
      const target = raw['target'] as Target | undefined;
      const expr = target
        ? `${bundleToLocator(target)}.press(${JSON.stringify(key)})`
        : `page.keyboard.press(${JSON.stringify(key)})`;
      return emitActionLines(indent, expr, expect, resp);
    }
    case 'wait':
      return emitWait(indent, raw['wait'] as { text?: string; url?: string; ms?: number });
    case 'assert':
      return emitAssert(indent, raw['assert'] as Condition);
    case 'if':
      return emitIf(indent, step as unknown as { if: Condition; then: FlowStep[]; else?: FlowStep[] }, resp);
  }
}

function emitSteps(steps: FlowStep[], indent: string, resp: RespCounter): string[] {
  return steps.flatMap((step) => emitStep(step, indent, resp));
}

function envVarName(param: string): string {
  return param.replace(/[^a-zA-Z0-9]+/g, '_').toUpperCase();
}

function constsFor(params: Record<string, FlowParam> | undefined): string[] {
  if (!params) return [];
  return Object.entries(params).map(([name, def]) => {
    const env = `process.env.${envVarName(name)}`;
    const value = !def.secret && def.default !== undefined ? `${env} ?? ${JSON.stringify(def.default)}` : env;
    return `const ${name} = ${value};`;
  });
}

export function flowToPlaywright(flow: Flow): string {
  const lines: string[] = [`import { test, expect } from '@playwright/test';`, ''];

  const consts = constsFor(flow.params);
  if (consts.length > 0) {
    lines.push(...consts, '');
  }

  lines.push(`test(${JSON.stringify(flow.name)}, async ({ page }) => {`);
  lines.push(...emitSteps(flow.steps, '  ', { n: 0 }));
  lines.push('});', '');

  return lines.join('\n');
}
