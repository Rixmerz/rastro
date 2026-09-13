// Fake Engine used by daemon/CLI tests so they never depend on the real
// browser engine (src/engine/engine.ts), which is built in parallel.

import type { Engine, RpcMethod, RpcResult } from '../../src/core/types.ts';
import { RastroError } from '../../src/core/types.ts';

function echo(method: RpcMethod, params: Record<string, unknown>): RpcResult {
  return { text: `${method} ${JSON.stringify(params)}`, data: { method, params } };
}

export async function createEngine(_session: string): Promise<Engine & { shutdown(): Promise<void> }> {
  const methods = {} as Engine;
  for (const method of [
    'open',
    'goto',
    'back',
    'forward',
    'reload',
    'view',
    'act',
    'detail',
    'history',
    'effects',
    'trace',
    'request',
    'snapshot',
    'screenshot',
    'console',
    'cookies',
    'storage',
    'tabs',
    'eval',
    'replay',
    'export',
    'recordStart',
    'recordStop',
    'flowSave',
    'flowRun',
    'flowExport',
    'flowImport',
    'status',
    'close',
  ] as const satisfies readonly RpcMethod[]) {
    methods[method] = (params: Record<string, unknown>) => Promise.resolve(echo(method, params));
  }

  // `trace` returns a large payload to exercise the >4 KB output path.
  methods.trace = (params: Record<string, unknown>) => {
    const text = 'x'.repeat(10 * 1024);
    return Promise.resolve({ text, data: { method: 'trace', params } });
  };

  // `goto` throws a RastroError to exercise the error + hint path.
  methods.goto = () => {
    throw new RastroError('boom', 'try again');
  };

  methods.close = () => Promise.resolve({ text: 'closed', data: { method: 'close' } });

  return {
    ...methods,
    shutdown: () => Promise.resolve(),
  };
}
