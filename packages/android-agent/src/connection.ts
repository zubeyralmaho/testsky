/**
 * The agent's protocol on the host side: a line per request, answered in
 * order by "ok <length>" and that many bytes, or by "err <reason>".
 *
 * Requests queue behind each other, so there is only ever one answer awaited
 * and nothing to match up. A request that is not answered in time ends the
 * connection: its late answer would otherwise be read as the next one's.
 */

import type { Socket } from "node:net";

/** The agent answered, and its answer was no. The connection is fine. */
export class AgentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentError";
  }
}

/** The agent is gone or stopped answering: nothing more goes over this connection. */
export class AgentGoneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentGoneError";
  }
}

interface Waiting {
  resolve(body: Buffer): void;
  reject(error: Error): void;
}

export class AgentConnection {
  private buffer: Buffer = Buffer.alloc(0);
  private waiting?: Waiting;
  private queue: Promise<unknown> = Promise.resolve();
  private gone?: AgentGoneError;
  private readonly socket: Socket;

  constructor(socket: Socket) {
    this.socket = socket;
    socket.setNoDelay(true);
    socket.on("data", (chunk: Buffer) => {
      this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
      this.drain();
    });
    socket.on("error", (error) => this.end(new AgentGoneError(`the agent's connection failed: ${error.message}`)));
    socket.on("close", () => this.end(new AgentGoneError("the agent closed its connection")));
  }

  /** Whether requests can still be made. */
  get open(): boolean {
    return !this.gone;
  }

  /** Sends one request line and resolves with its answer. Requests wait their turn. */
  request(line: string, timeoutMs = 15_000): Promise<Buffer> {
    if (/[\r\n]/.test(line)) return Promise.reject(new AgentError("a request is a single line"));
    const turn = this.queue.then(() => this.send(line, timeoutMs));
    this.queue = turn.catch(() => undefined);
    return turn;
  }

  destroy(): void {
    this.end(new AgentGoneError("the connection was closed"));
  }

  private send(line: string, timeoutMs: number): Promise<Buffer> {
    if (this.gone) return Promise.reject(this.gone);
    return new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => this.end(new AgentGoneError(`the agent did not answer "${line.split(" ")[0]}" within ${timeoutMs} ms`)), timeoutMs);
      this.waiting = {
        resolve: (body) => {
          clearTimeout(timer);
          resolve(body);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      this.socket.write(`${line}\n`);
    });
  }

  private drain(): void {
    while (this.waiting) {
      const newline = this.buffer.indexOf(10);
      if (newline < 0) return;
      const head = this.buffer.subarray(0, newline).toString("utf8");
      if (head.startsWith("err ")) {
        this.buffer = this.buffer.subarray(newline + 1);
        this.settle().reject(new AgentError(head.slice(4)));
        continue;
      }
      const ok = /^ok (\d+)$/.exec(head);
      if (!ok) {
        this.end(new AgentGoneError(`the agent said something that is not an answer: ${JSON.stringify(head.slice(0, 80))}`));
        return;
      }
      const length = Number(ok[1]);
      if (this.buffer.length < newline + 1 + length) return;
      const body = Buffer.from(this.buffer.subarray(newline + 1, newline + 1 + length));
      this.buffer = this.buffer.subarray(newline + 1 + length);
      this.settle().resolve(body);
    }
  }

  private settle(): Waiting {
    const waiting = this.waiting!;
    delete this.waiting;
    return waiting;
  }

  private end(error: AgentGoneError): void {
    if (!this.gone) this.gone = error;
    if (this.waiting) this.settle().reject(this.gone);
    if (!this.socket.destroyed) this.socket.destroy();
  }
}
