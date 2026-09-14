// Reading a secret from the person at the keyboard, without it passing through
// argv, the shell history, or this process's stdin (which may be a pipe from an
// agent). The value is read from the controlling terminal with echo disabled.

import { spawnSync } from 'node:child_process';
import { closeSync, openSync, readSync, writeSync } from 'node:fs';
import { RastroError } from '../core/types.ts';

/** Terminals tried, in order, when the command was started without a tty. */
const TERMINALS = ['kitty', 'alacritty', 'foot', 'wezterm', 'gnome-terminal', 'konsole', 'xterm'];

function hasTty(): boolean {
  try {
    closeSync(openSync('/dev/tty', 'r'));
    return true;
  } catch {
    return false;
  }
}

/** Reads one line from /dev/tty with echo off. Falls back to echo on only if
 * `stty` is missing — better a visible prompt than no way to enter the value. */
export function promptSecret(label: string): string {
  const fd = openSync('/dev/tty', 'r+');
  const echoOff = spawnSync('stty', ['-echo'], { stdio: [fd, 'ignore', 'ignore'] }).status === 0;
  try {
    writeSync(fd, `${label}: `);
    const chunks: Buffer[] = [];
    const buf = Buffer.alloc(1);
    for (;;) {
      const read = readSync(fd, buf, 0, 1, null);
      if (read === 0 || buf[0] === 0x0a) break;
      chunks.push(Buffer.from(buf));
    }
    writeSync(fd, '\n');
    return Buffer.concat(chunks).toString('utf8').replace(/\r$/, '');
  } finally {
    if (echoOff) spawnSync('stty', ['echo'], { stdio: [fd, 'ignore', 'ignore'] });
    closeSync(fd);
  }
}

/** Runs `rastro secret set <name>` again inside a terminal emulator and waits.
 * This is the "open a terminal to ask" path: the agent's own process has no
 * tty, and piping the value in would defeat the point of the prompt. */
export function promptInTerminal(argv: string[]): never {
  const term = TERMINALS.find((t) => spawnSync('sh', ['-c', `command -v ${t}`], { stdio: 'ignore' }).status === 0);
  if (!term) {
    throw new RastroError('no terminal to ask in, and this process has no tty', `run it yourself: rastro ${argv.join(' ')}`);
  }
  const self = process.argv[1] ?? 'rastro';
  const open = term === 'gnome-terminal' ? ['--wait', '--'] : ['-e'];
  // Held open on purpose: the command prints one line and exits, so otherwise
  // the window appears and vanishes and nobody sees whether it worked. The
  // command is passed as "$@" rather than interpolated, so no argument is
  // re-parsed by the shell.
  const hold = ['sh', '-c', '"$@"; printf "\\n[enter] "; read _', 'sh'];
  const res = spawnSync(term, [...open, ...hold, process.execPath, self, ...argv], { stdio: 'inherit' });
  process.exit(res.status ?? 1);
}

export function readSecretInteractively(label: string, argv: string[]): string {
  if (!hasTty()) promptInTerminal(argv);
  return promptSecret(label);
}
