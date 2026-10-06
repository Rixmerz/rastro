// Eval harness: connects a real MCP client to a real `rastro mcp` process
// (stdio or Streamable HTTP), backed by a real daemon and Chromium, and keeps
// the token cost of every tool response an agent would read.

import { spawn, type ChildProcess } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

export type TransportKind = 'stdio' | 'http';

const BIN = new URL('../bin/rastro.js', import.meta.url).pathname;

/** The same estimate the specs use for budgets: characters divided by 4. */
export function tokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface Step {
  transport: TransportKind;
  scenario: string;
  tool: string;
  tokens: number;
}

export interface Outcome {
  transport: TransportKind;
  scenario: string;
  passed: boolean;
  steps: number;
  tokens: number;
}

export class Recorder {
  readonly steps: Step[] = [];
  readonly outcomes: Outcome[] = [];
  connection: Partial<Record<TransportKind, { tools: number; toolsTokens: number; instructionsTokens: number }>> = {};

  outcome(transport: TransportKind, scenario: string, passed: boolean): void {
    const mine = this.steps.filter((s) => s.transport === transport && s.scenario === scenario);
    this.outcomes.push({ transport, scenario, passed, steps: mine.length, tokens: mine.reduce((n, s) => n + s.tokens, 0) });
  }

  report(): string {
    const lines = ['', '## rastro MCP evals', '', '| transport | scenario | result | tool calls | tokens read |', '| --- | --- | --- | ---: | ---: |'];
    for (const o of this.outcomes) {
      lines.push(`| ${o.transport} | ${o.scenario} | ${o.passed ? 'pass' : 'FAIL'} | ${o.steps} | ${o.tokens} |`);
    }
    lines.push('', '| transport | tools | tools/list tokens | instructions tokens |', '| --- | ---: | ---: | ---: |');
    for (const [kind, c] of Object.entries(this.connection)) {
      lines.push(`| ${kind} | ${c.tools} | ${c.toolsTokens} | ${c.instructionsTokens} |`);
    }
    const views = this.steps.filter((s) => s.tool === 'rastro_view').map((s) => s.tokens);
    const acts = this.steps.filter((s) => s.tool === 'rastro_act').map((s) => s.tokens);
    if (views.length > 0) lines.push('', `rastro_view: ${Math.min(...views)}-${Math.max(...views)} tokens over ${views.length} calls`);
    if (acts.length > 0) lines.push(`rastro_act: ${Math.min(...acts)}-${Math.max(...acts)} tokens over ${acts.length} calls`);
    return lines.join('\n');
  }

  /** Writes the raw numbers when `RASTRO_EVAL_OUT` names a file. */
  save(): void {
    const out = process.env.RASTRO_EVAL_OUT;
    if (out === undefined || out === '') return;
    writeFileSync(out, `${JSON.stringify({ outcomes: this.outcomes, connection: this.connection, steps: this.steps }, null, 2)}\n`);
  }
}

export interface Agent {
  /** Calls a tool and returns its text, recording what it cost to read. */
  call(tool: string, args?: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
  /** Everything every tool returned in this scenario, to check for leaks. */
  transcript(): string;
}

export interface Connection {
  client: Client;
  close(): Promise<void>;
}

async function startHttp(): Promise<{ child: ChildProcess; url: string }> {
  const child = spawn(process.execPath, [BIN, 'mcp', '--http', '--port', '0'], { env: process.env, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  const url = await new Promise<string>((resolve, reject) => {
    child.stderr!.on('data', (c: Buffer) => {
      stderr += c.toString('utf8');
      const m = /listening on (\S+)/.exec(stderr);
      if (m) resolve(m[1]!);
    });
    child.on('exit', (code) => reject(new Error(`rastro mcp --http exited ${code}: ${stderr}`)));
  });
  return { child, url };
}

/** Starts `rastro mcp` over `kind` and connects a client to it. */
export async function connect(kind: TransportKind): Promise<Connection> {
  const client = new Client({ name: 'rastro-evals', version: '0.0.0' });
  let transport: Transport;
  let child: ChildProcess | undefined;
  if (kind === 'stdio') {
    transport = new StdioClientTransport({ command: process.execPath, args: [BIN, 'mcp'], env: process.env as Record<string, string>, stderr: 'ignore' });
  } else {
    const token = process.env.RASTRO_MCP_TOKEN;
    if (!token) throw new Error('RASTRO_MCP_TOKEN must be set for the http evals');
    const started = await startHttp();
    child = started.child;
    transport = new StreamableHTTPClientTransport(new URL(started.url), { requestInit: { headers: { authorization: `Bearer ${token}` } } });
  }
  await client.connect(transport);
  return {
    client,
    close: async () => {
      await client.close();
      child?.kill('SIGTERM');
    },
  };
}

export function agent(conn: Connection, rec: Recorder, transport: TransportKind, scenario: string, session: string): Agent {
  const texts: string[] = [];
  return {
    async call(tool, args = {}) {
      const result = await conn.client.callTool({ name: tool, arguments: { ...args, session } });
      const text = (result.content as { type: string; text?: string }[])
        .map((c) => c.text ?? '')
        .join('\n');
      texts.push(text);
      rec.steps.push({ transport, scenario, tool, tokens: tokens(text) });
      return { text, isError: result.isError === true };
    },
    transcript: () => texts.join('\n'),
  };
}

/** The ref of the first element whose accessible name contains `name`, from view text. */
export function refOf(view: string, name: string): string {
  for (const m of view.matchAll(/\[([a-z0-9]+)\] [\w-]+ «([^»]*)»/g)) {
    if (m[2]!.includes(name)) return m[1]!;
  }
  throw new Error(`no element named "${name}" in view:\n${view}`);
}

/** The action number an action summary starts with (`#3 → ...`). */
export function actionOf(summary: string): number {
  const m = /^#(\d+)/.exec(summary.trim());
  if (!m) throw new Error(`no action id in: ${summary}`);
  return Number(m[1]);
}
