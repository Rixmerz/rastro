// What a coordinator and a worker session say to each other over the daemon's
// RPC. Kept apart from both sides so neither imports the other.

import type { FloodElement } from './state.ts';

export interface StepParams {
  /** URL the state is reached from. */
  start: string;
  /** Element keys clicked from `start` to reach the state. */
  path: string[];
  /** Element to activate; absent for a plain visit. */
  key?: string;
  /** Hash of the state; when the page is already in it, reaching is skipped. */
  expect?: string;
  /** Fill a form's empty fields with neutral values before submitting it. */
  fill?: boolean;
  /** Per-action timeout, short: a flood moves on rather than wait. */
  timeoutMs?: number;
}

export type StateElement = Omit<FloodElement, 'ref'>;

export interface StateView {
  url: string;
  title: string;
  hash: string;
  /** Structure alone, without the URL. */
  structure: string;
  elements: StateElement[];
}

export interface StepRequest {
  /** `r31`, in the worker session's trace. */
  id: string;
  action: number;
  phase: 'reach' | 'activate';
  method: string;
  url: string;
  resourceType: string;
  status?: number;
  failed?: string;
  mimeType?: string;
  retryAfter?: string;
  /** A write the guard aborted: it never left the browser. */
  blocked?: boolean;
  /** Masked body of a write (sent or blocked). */
  body?: string;
}

export interface StepResult {
  /** False when the path to the state no longer works. */
  reached: boolean;
  reachError?: string;
  /** Reaching was skipped because the page already was in the state. */
  reused: boolean;
  /** The page the element was looked up in (after reaching). */
  before: StateView;
  /** Set when an element was activated. */
  activated?: { action: number; kind: string; error?: string };
  after: StateView;
  /** The activation changed the URL (a navigation or a pushState). */
  navigated: boolean;
  requests: StepRequest[];
  /** captcha | 2fa | bot-block, from the activation or the reach. */
  blocked?: string;
  dialogs: string[];
  tabsOpened: number;
  downloads: string[];
  /** Every action the step recorded, reach included. */
  actions: number[];
}

/** Cookies and storage handed from the seed session to the workers. */
export interface SeedState {
  cookies: {
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite: 'Strict' | 'Lax' | 'None';
  }[];
  origins: { origin: string; localStorage: { name: string; value: string }[] }[];
}
