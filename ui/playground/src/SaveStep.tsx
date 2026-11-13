import { useState } from 'react';

/** What the server says about an instruction it ran, beside the answer Midscene's page reads. */
interface Ran {
  instruction: string;
  session: string;
  savable: boolean;
}

/** What was said about each instruction saved, kept across the conversation's re-renders. */
const said = new Map<string, string>();

const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;

/**
 * "Save as step", under a result: the instruction goes into the test file
 * the playground was started with, as a step in its own words -- and, when
 * it passed, with where it pressed, for the next run to replay once that
 * checks out. An instruction from before the playground restarted is not
 * this one's to save, and gets no button.
 */
export function SaveStep({ result, session }: { result: unknown; session?: string }) {
  const ran = (result as { testsky?: Ran } | null)?.testsky;
  const key = ran ? `${ran.session}/${ran.instruction}` : '';
  const [state, setState] = useState<{ kind: 'idle' | 'saving' | 'saved' | 'refused'; text?: string }>(() =>
    said.has(key) ? { kind: 'saved', text: said.get(key) } : { kind: 'idle' },
  );
  if (!ran?.savable || ran.session !== session) return null;

  const save = async () => {
    setState({ kind: 'saving' });
    try {
      const response = await fetch('/api/steps', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ instruction: ran.instruction, session: ran.session }),
      });
      const body = (await response.json().catch(() => ({}))) as { stepId?: string; test?: string; remembered?: boolean; error?: string };
      if (!response.ok) {
        setState({ kind: 'refused', text: body.error ?? `it could not be saved (${response.status})` });
        return;
      }
      const text = `Saved as ${body.stepId} · ${fileName(body.test ?? '')}${body.remembered ? ' · with where it pressed' : ''}`;
      said.set(key, text);
      setState({ kind: 'saved', text });
    } catch (error) {
      setState({ kind: 'refused', text: (error as Error).message });
    }
  };

  return (
    <div className="save-step">
      {state.kind === 'saved' ? (
        <span className="save-step-done">{state.text}</span>
      ) : (
        <button type="button" className="save-step-button" disabled={state.kind === 'saving'} onClick={save}>
          {state.kind === 'saving' ? 'Saving...' : 'Save as step'}
        </button>
      )}
      {state.kind === 'refused' ? <span className="save-step-refused">{state.text}</span> : null}
    </div>
  );
}
