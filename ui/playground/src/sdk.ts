import type { FormValue, PlaygroundSDKLike } from '@testsky/visualizer';

/** What the server says about the phone it holds. */
export interface PlaygroundStatus {
  platform: 'android' | 'ios';
  device: string;
  kind: string;
  engine: string;
  size: { width: number; height: number } | null;
  /** The screen as last seen, turned or not. */
  screen: { width: number; height: number } | null;
  /** The phone streams its screen as it moves (live.ts); otherwise it is polled. */
  live: boolean;
  /** The test file "save as a step" writes to, if the playground was given one. */
  test: string | null;
  /** This playground, as against one before a restart. */
  session: string;
  tree: boolean;
  busy: boolean;
}

const refusal = (error: string) => ({ result: null, dump: null, reportHTML: null, error });

/** Said on window when an instruction starts and ends, so the screen panel knows its tree is about to go stale. */
export const INSTRUCTION_EVENT = 'testsky-instruction';

/** Said on window by the sidebar's Tree entry: read the tree, or show or hide the one read. */
export const TREE_EVENT = 'testsky-tree';
const announce = (phase: 'start' | 'end') =>
  window.dispatchEvent(new CustomEvent(INSTRUCTION_EVENT, { detail: { phase } }));

/**
 * The playground's SDK. Every instruction goes to the testsky server, which
 * runs it as a one-step test on the phone and answers in the dump format the
 * conversation replays. There is nothing to configure here: the model the
 * server was started with is the one that answers.
 */
export class TestskySDK implements PlaygroundSDKLike {
  readonly id = 'testsky';

  async executeAction(actionType: string, value: FormValue): Promise<unknown> {
    announce('start');
    try {
      return await this.send(actionType, value);
    } finally {
      announce('end');
    }
  }

  private async send(actionType: string, value: FormValue): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch('/api/execute', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: actionType,
          prompt: value.prompt ?? '',
          params: value.params ?? {},
        }),
      });
    } catch (error) {
      return refusal(
        `the playground server did not answer: ${(error as Error).message}`,
      );
    }
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
      result?: unknown;
    };
    if (!response.ok) {
      return refusal(
        body.error ?? `the playground server answered ${response.status}`,
      );
    }
    // JSON has no undefined: an action's answer arrives without a result, and
    // the conversation shows no output only for a result that is there and
    // undefined.
    if (!('result' in body)) body.result = undefined;
    return body;
  }

  // Empty, so the prompt offers Midscene's whole list; what a phone cannot do
  // comes back from the server as a refusal that says so.
  async getActionSpace() {
    return [];
  }

  async checkStatus() {
    return (await fetchStatus()) !== null;
  }

  getServiceMode() {
    return 'Server' as const;
  }
}

export async function fetchStatus(): Promise<PlaygroundStatus | null> {
  try {
    const response = await fetch('/api/status', { cache: 'no-store' });
    return response.ok ? ((await response.json()) as PlaygroundStatus) : null;
  } catch {
    return null;
  }
}
