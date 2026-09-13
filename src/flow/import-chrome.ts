// Converts a Chrome DevTools Recorder export into a Flow. The recording is
// untrusted external input, so its shape is validated with zod before any of
// it is used.

import { z } from 'zod';
import type { Expect, Flow, FlowStep, Target } from './format.ts';
import { parseFlow, stringifyFlow } from './format.ts';

const assertedEventSchema = z
  .object({
    type: z.string().optional(),
    url: z.string().optional(),
  })
  .loose();

const chromeStepSchema = z
  .object({
    type: z.string(),
    url: z.string().optional(),
    selectors: z.array(z.array(z.string())).optional(),
    value: z.string().optional(),
    key: z.string().optional(),
    assertedEvents: z.array(assertedEventSchema).optional(),
  })
  .loose();

const chromeRecordingSchema = z
  .object({
    title: z.string().optional(),
    steps: z.array(chromeStepSchema),
  })
  .loose();

type ChromeStep = z.infer<typeof chromeStepSchema>;

/**
 * Builds a locator bundle from a Chrome Recorder `selectors` array: each
 * inner array is one alternative selector, itself a pierce chain from
 * outermost to innermost when it targets shadow DOM.
 */
export function selectorsToTarget(selectors: string[][]): Target {
  const target: Target = {};

  for (const chain of selectors) {
    if (chain.length === 0) continue;
    const first = chain[0]!;
    const last = chain[chain.length - 1]!;

    if (first.startsWith('aria/')) {
      const body = first.slice('aria/'.length);
      const roleMatch = /^(.*)\[role="([^"]+)"\]$/.exec(body);
      if (roleMatch) {
        if (target.name === undefined) target.name = roleMatch[1];
        if (target.role === undefined) target.role = roleMatch[2];
      } else if (target.name === undefined) {
        target.name = body;
      }
      continue;
    }

    if (first.startsWith('text/')) {
      if (target.text === undefined) target.text = first.slice('text/'.length);
      continue;
    }

    if (first.startsWith('xpath/')) continue; // ignored per spec

    if (first.startsWith('pierce/')) {
      if (target.css === undefined) {
        target.css = chain.length > 1 ? last : first.slice('pierce/'.length);
      }
      continue;
    }

    // Plain CSS chain: a multi-element chain pierces shadow DOM, so only the
    // deepest (last) segment is a usable selector on its own.
    if (target.css === undefined) {
      target.css = last;
      if (target.id === undefined && /^#[a-zA-Z][\w-]*$/.test(last)) {
        target.id = last.slice(1);
      }
    }
  }

  return target;
}

function textFromSelectors(selectors: string[][]): string | undefined {
  const target = selectorsToTarget(selectors);
  return target.text ?? target.name;
}

/**
 * A step's `assertedEvents` describe what the action caused, mirroring the
 * `expect` derived from a recorded action's effects elsewhere in the format.
 */
function applyAssertedUrl(raw: ChromeStep, steps: FlowStep[]): void {
  const navigation = (raw.assertedEvents ?? []).find((event) => event.type === 'navigation' && event.url !== undefined);
  if (!navigation?.url) return;
  const last = steps[steps.length - 1];
  if (!last) return;

  let pathname: string;
  try {
    pathname = new URL(navigation.url).pathname;
  } catch {
    pathname = navigation.url;
  }
  const withExpect = last as { expect?: Expect };
  withExpect.expect = { ...withExpect.expect, url: pathname };
}

export function importChromeRecording(json: unknown): Flow {
  const parsed = chromeRecordingSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`invalid Chrome recording: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
  }
  const recording = parsed.data;

  const steps: FlowStep[] = [];
  let stepIndex = 0;
  let sawNavigate = false;

  const push = (step: FlowStep): void => {
    step.id = `s${++stepIndex}`;
    steps.push(step);
  };

  for (const raw of recording.steps) {
    const before = steps.length;

    switch (raw.type) {
      case 'navigate': {
        if (raw.url) push(sawNavigate ? { goto: raw.url } : { open: raw.url });
        sawNavigate = true;
        break;
      }
      case 'click':
        if (raw.selectors) push({ click: selectorsToTarget(raw.selectors) });
        break;
      case 'doubleClick':
        if (raw.selectors) push({ dblclick: selectorsToTarget(raw.selectors) });
        break;
      case 'hover':
        if (raw.selectors) push({ hover: selectorsToTarget(raw.selectors) });
        break;
      case 'change':
        if (raw.selectors && raw.value !== undefined) {
          push({ fill: selectorsToTarget(raw.selectors), value: raw.value });
        }
        break;
      case 'keyDown':
        if (raw.key) push({ press: raw.key });
        break;
      case 'keyUp':
      case 'scroll':
      case 'setViewport':
      case 'close':
        break; // ignored: no flow-step equivalent
      case 'waitForElement': {
        // ponytail: skipped (no step emitted) when the selectors carry no
        // aria/text signal — a css-only waitForElement has nothing to wait on
        // in Playwright's expect(...).toBeVisible() sense.
        const text = raw.selectors ? textFromSelectors(raw.selectors) : undefined;
        if (text) push({ wait: { text } });
        break;
      }
      default:
        break; // unknown step type, skipped
    }

    if (steps.length > before) applyAssertedUrl(raw, steps);
  }

  const flow: Flow = { name: recording.title ?? 'imported flow', steps };
  // Re-validate through the same schema parseFlow uses, via its public API.
  return parseFlow(stringifyFlow(flow));
}
