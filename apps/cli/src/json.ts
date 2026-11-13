/**
 * `--json`: the answer is one object on stdout, and stdout is nothing else.
 *
 * Whoever reads it -- a script, CI, an agent -- parses the whole of stdout,
 * so a progress line or a device library's debug output there is a broken
 * answer. While it is on, everything written to stdout goes to stderr
 * instead, ours and the device stack's alike, and the answer alone is
 * written to the real one. A command refused before it has an answer is
 * answered too: with its exit code and the last thing it said.
 */

import { format } from "node:util";

export class JsonAnswer {
  private readonly stdout: (text: string) => boolean;
  private said = "";
  private answered = false;

  constructor() {
    this.stdout = process.stdout.write.bind(process.stdout) as (text: string) => boolean;
    process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;
    const error = console.error.bind(console);
    console.error = (...args: unknown[]) => {
      // The last line of what was said, without its colours: what a refusal is answered with.
      const lines = format(...args).replace(/\u001B\[[0-9;]*m/g, "").trim().split("\n").filter(Boolean);
      if (lines.length) this.said = lines.at(-1)!.trim();
      error(...args);
    };
  }

  /** The answer, once; a second is not written, as stdout holds one object. */
  answer(value: Record<string, unknown>): void {
    if (this.answered) return;
    this.answered = true;
    this.stdout(`${JSON.stringify(value)}\n`);
  }

  /** The command is over: an answer it never gave is given now. */
  end(code: number): void {
    this.answer({ outcome: code === 0 ? "OK" : "ERROR", exitCode: code, ...(this.said ? { detail: this.said } : {}) });
  }
}
