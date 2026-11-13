/**
 * Silences the device stack's own chatter.
 *
 * appium-adb logs at debug level straight to the process streams, and
 * Midscene's dist calls `console.error` directly when adb is missing -- so
 * listing devices on a machine without adb prints a debug line, a stack trace
 * and a PATH dump before our own one-line explanation ever appears. Neither
 * logger is ours to configure (appium's only mute is its `_TESTING` flag,
 * which changes behaviour, not just output), so the noise is caught at the
 * streams and released when `--verbose` asks for it.
 *
 * Only short device calls are wrapped, and every error inside them is
 * re-thrown with our own message -- nothing diagnostic is lost.
 */
/** What the streams were before the first quiet call still open. */
let saved:
  | { log: typeof console.log; error: typeof console.error; warn: typeof console.warn; info: typeof console.info; stdout: typeof process.stdout.write; stderr: typeof process.stderr.write }
  | undefined;
/**
 * Quiet calls still open. Calls overlap -- an MCP server lists devices while
 * it attaches to a phone -- and each one restoring what it saw on the way in
 * left the streams silenced for good when the first one in finished first.
 * The streams are swapped by the first and given back by the last.
 */
let open = 0;

export async function quietly<T>(fn: () => Promise<T>, verbose = false): Promise<T> {
  if (verbose) return fn();
  if (open === 0) {
    saved = {
      log: console.log,
      error: console.error,
      warn: console.warn,
      info: console.info,
      // The methods themselves, put back as they were found.
      stdout: process.stdout.write,
      stderr: process.stderr.write,
    };
    const swallow = () => {};
    const swallowWrite = ((_chunk: unknown, encodingOrCb?: unknown, cb?: unknown): boolean => {
      const done = typeof encodingOrCb === "function" ? encodingOrCb : cb;
      if (typeof done === "function") (done as () => void)();
      return true;
    }) as typeof process.stdout.write;
    console.log = swallow;
    console.error = swallow;
    console.warn = swallow;
    console.info = swallow;
    process.stdout.write = swallowWrite;
    process.stderr.write = swallowWrite;
  }
  open += 1;
  try {
    return await fn();
  } finally {
    open -= 1;
    if (open === 0 && saved) {
      console.log = saved.log;
      console.error = saved.error;
      console.warn = saved.warn;
      console.info = saved.info;
      process.stdout.write = saved.stdout;
      process.stderr.write = saved.stderr;
      saved = undefined;
    }
  }
}

/**
 * Drops the device stack's debug chatter from the process streams for good.
 *
 * `quietly()` covers a single call; a run interleaves our own progress lines
 * with appium's, so windowing does not work there. This filters by line
 * instead: appium's logger prefixes every line with its level and component,
 * and nothing of ours looks like that.
 */
/** A line of the device stack's own chatter, once its colours are taken off. */
export function isDeviceChatter(line: string): boolean {
  // npmlog colours the level tag, so the raw line starts with an escape
  // sequence rather than the word. Strip those before matching.
  return /^(dbug|info|warn|error|verb|sill)\s+(ADB|Midscene|AndroidDevice)\s/.test(line.replace(/\u001B\[[0-9;]*m/g, ""));
}

export function installLogFilter(verbose: boolean): void {
  if (verbose) return;
  for (const stream of [process.stdout, process.stderr]) {
    const original = stream.write.bind(stream);
    stream.write = ((chunk: unknown, encodingOrCb?: unknown, cb?: unknown): boolean => {
      const text = typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : "";
      if (text && isDeviceChatter(text)) {
        const done = typeof encodingOrCb === "function" ? encodingOrCb : cb;
        if (typeof done === "function") (done as () => void)();
        return true;
      }
      return original(chunk as never, encodingOrCb as never, cb as never);
    }) as typeof stream.write;
  }
}
