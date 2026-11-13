// testsky: a model call whole -- what it was asked, the picture and the tree
// lines it was shown, what it thought and what it answered -- and what the
// accessibility tree said on its own. Midscene keeps a call's usage and its
// parsed result; why a run went as it did is in the conversation.
import './model-call.less';

import {
  DownOutlined,
  ExpandAltOutlined,
  RightOutlined,
} from '@ant-design/icons';
import { Modal } from 'antd';
import { type ReactNode, useState } from 'react';

/** A call as the report's dump carries it; its picture arrives resolved, as a data URI. */
export interface ReportCall {
  purpose: string;
  model?: string;
  provider?: string;
  tier: number;
  shown: string;
  latencyMs: number;
  tokensIn?: number;
  tokensOut?: number;
  usd: number;
  system?: string;
  prompt?: string;
  treeSpan?: [number, number];
  picture?: { base64?: string };
  thinking?: string;
  answer?: string;
}

const PURPOSE: Record<string, string> = {
  plan: 'plan',
  ground: 'locate',
  assert: 'check',
  extract: 'read',
  popup: 'pop-up check',
};

const SHOWN: Record<string, string> = {
  vision: 'screenshot',
  tree: 'tree only',
  fused: 'screenshot + tree',
};

const THINK = /^\s*<think>[\s\S]*?<\/think>\s*/i;

/** JSON laid out to be read: an object a key a line, a list of plain values on one line. */
function layJson(value: unknown, indent = ''): string {
  if (Array.isArray(value)) {
    if (value.every((each) => each === null || typeof each !== 'object')) {
      return `[${value.map((each) => JSON.stringify(each)).join(', ')}]`;
    }
    const inner = `${indent}  `;
    return `[\n${value.map((each) => `${inner}${layJson(each, inner)}`).join(',\n')}\n${indent}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value);
    if (!entries.length) return '{}';
    const inner = `${indent}  `;
    return `{\n${entries.map(([key, each]) => `${inner}${JSON.stringify(key)}: ${layJson(each, inner)}`).join(',\n')}\n${indent}}`;
  }
  return JSON.stringify(value);
}

/** An answer as it reads best: its JSON laid out, with any words around it kept; else as it came. */
export function prettyAnswer(answer: string): string {
  const text = answer.replace(THINK, '');
  const unfenced = text.replace(/```(?:json)?/gi, '');
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start === -1 || end <= start) return text;
  try {
    const laid = layJson(JSON.parse(unfenced.slice(start, end + 1)));
    const around = `${unfenced.slice(0, start)}${unfenced.slice(end + 1)}`.trim();
    return around ? `${around}\n\n${laid}` : laid;
  } catch {
    return text;
  }
}

const lineCount = (text: string): number => text.split('\n').length;
const tokens = (count: number | undefined): string =>
  Math.round(count ?? 0).toLocaleString('en-US');

/** A titled block that opens and closes. */
export const Fold = (props: {
  title: string;
  open?: boolean;
  children: ReactNode;
}) => {
  const [open, setOpen] = useState(props.open ?? false);
  return (
    <div className={`ts-fold${open ? ' is-open' : ''}`}>
      <button
        type="button"
        className="ts-fold-head"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {open ? <DownOutlined /> : <RightOutlined />}
        <span>{props.title}</span>
      </button>
      {open && <div className="ts-fold-body">{props.children}</div>}
    </div>
  );
};

const Part = (props: { label: string; children: ReactNode }) => (
  <div className="ts-call-part">
    <div className="ts-call-label">{props.label}</div>
    {props.children}
  </div>
);

/** One line of what a call was: what for, which model, what it was shown, how long, how much. */
const factsOf = (call: ReportCall): string =>
  [
    PURPOSE[call.purpose] ?? call.purpose,
    call.model
      ? `${call.model}${call.provider ? ` via ${call.provider}` : ''}`
      : undefined,
    SHOWN[call.shown] ?? call.shown,
    `tier ${call.tier}`,
    call.latencyMs < 1000
      ? `${Math.round(call.latencyMs)} ms`
      : `${(call.latencyMs / 1000).toFixed(1)} s`,
    call.tokensIn !== undefined || call.tokensOut !== undefined
      ? `${tokens(call.tokensIn)} → ${tokens(call.tokensOut)} tokens`
      : undefined,
    call.usd > 0 ? `$${call.usd.toFixed(4)}` : undefined,
  ]
    .filter(Boolean)
    .join(' · ');

/** What a call was asked, thought and answered: the question with the tree lines apart from the words around them. */
const Conversation = ({ call }: { call: ReportCall }) => {
  const { prompt } = call;
  const span =
    prompt && call.treeSpan && call.treeSpan[1] <= prompt.length
      ? call.treeSpan
      : undefined;
  const before = span ? prompt!.slice(0, span[0]).replace(/\n+$/, '') : prompt;
  const tree = span ? prompt!.slice(span[0], span[1]) : undefined;
  const after = span ? prompt!.slice(span[1]).replace(/^\n+/, '') : '';
  return (
    <>
      <Part label="asked">
        {call.system && (
          <Fold title="instructions">
            <pre className="ts-call-text">{call.system}</pre>
          </Fold>
        )}
        {prompt === undefined ? (
          <div className="ts-call-none">
            not kept: the run is older than keeping questions
          </div>
        ) : (
          <>
            {before && <pre className="ts-call-text">{before}</pre>}
            {tree && (
              <Fold title={`accessibility tree · ${lineCount(tree)} lines`}>
                <pre className="ts-call-text ts-tree-lines">{tree}</pre>
              </Fold>
            )}
            {after && <pre className="ts-call-text">{after}</pre>}
          </>
        )}
      </Part>
      <Part label="thought">
        {call.thinking ? (
          <pre className="ts-call-text">{call.thinking}</pre>
        ) : (
          <div className="ts-call-none">its host sent no thinking back</div>
        )}
      </Part>
      <Part label="answered">
        {call.answer === undefined ? (
          <div className="ts-call-none">not kept</div>
        ) : (
          <pre className="ts-call-text">{prettyAnswer(call.answer)}</pre>
        )}
      </Part>
    </>
  );
};

export const ModelCall = ({ call }: { call: ReportCall }) => {
  const [large, setLarge] = useState(false);
  const [wide, setWide] = useState(false);
  const picture = call.picture?.base64;
  const facts = factsOf(call);
  return (
    <div className="ts-call">
      <div className="ts-call-head">
        <div className="ts-call-facts">{facts}</div>
        <button
          type="button"
          className="ts-call-open"
          title="Read the whole call, wide"
          onClick={() => setWide(true)}
        >
          <ExpandAltOutlined />
        </button>
      </div>
      {picture && (
        <button
          type="button"
          className={`ts-call-picture${large ? ' is-large' : ''}`}
          title={large ? 'Smaller' : 'Larger'}
          onClick={() => setLarge(!large)}
        >
          <img src={picture} alt="The picture the model was shown" />
        </button>
      )}
      <Conversation call={call} />
      <Modal
        open={wide}
        onCancel={() => setWide(false)}
        footer={null}
        width="min(1280px, 94vw)"
        title={<span className="ts-call-facts">{facts}</span>}
        className="ts-call-modal"
        destroyOnHidden
      >
        <div className={`ts-call ts-call-wide${picture ? '' : ' no-picture'}`}>
          {picture && (
            <div className="ts-call-seen">
              <img src={picture} alt="The picture the model was shown" />
            </div>
          )}
          <div className="ts-call-words-column">
            <Conversation call={call} />
          </div>
        </div>
      </Modal>
    </div>
  );
};

/** What the accessibility tree said on its own, and the lines it was read from. */
export const TreeSide = (props: {
  answer?: string;
  said?: string[];
  lines?: string;
  linesTitle: string;
}) => (
  <div className="ts-call">
    {props.answer && (
      <Part label="on its own">
        <div className="ts-call-words">{props.answer}</div>
      </Part>
    )}
    {props.said?.length ? (
      <Part label="it said">
        <div className="ts-call-words">
          {props.said.join('; ')} -- a second look was told so
        </div>
      </Part>
    ) : null}
    {props.lines && (
      <Fold title={`${props.linesTitle} · ${lineCount(props.lines)} lines`}>
        <pre className="ts-call-text ts-tree-lines">{props.lines}</pre>
      </Fold>
    )}
  </div>
);
