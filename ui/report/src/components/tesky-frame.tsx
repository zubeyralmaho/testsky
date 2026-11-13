import { NavItem, PlatformMark } from '@testsky/look/frame';
import { DayGlyph, NightGlyph } from '@testsky/look/glyphs';
import type { ReactNode } from 'react';
import { Logo } from './logo';

/** What testsky's converter writes beside the dump: the run's verdict, where it ran, what it cost. */
export interface RunSummary {
  test: string;
  title: string;
  platform: string;
  device: string;
  engine: string;
  version?: string;
  appBuild?: string;
  outcome: string;
  verdict: string;
  tone: 'neutral' | 'ice' | 'amber';
  detail: string;
  startedAt: number;
  finishedAt: number;
  usd: number;
  tokensIn: number;
  calls: number;
  steps: number;
  passed: number;
  remembered: number;
  agreed?: number;
  treeAlone?: number;
}

/** The run's summary, when the report was written by testsky; Midscene's own reports have none. */
export function readRunSummary(): RunSummary | null {
  const element = document.querySelector('script[type="testsky_run"]');
  if (!element?.textContent) return null;
  try {
    return JSON.parse(element.textContent) as RunSummary;
  } catch {
    return null;
  }
}

const PLATFORM: Record<string, string> = { android: 'Android', ios: 'iOS' };

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

type ReportViewMode = 'human' | 'markdown';

/**
 * The report in Tesky's frame: a floating glass sidebar with the mark, the
 * report's views, its steps and, at its foot, where it ran; beside it the
 * page, named for the run in the serif, with its verdict in a band above
 * Midscene's replay and details.
 */
export function TeskyFrame(props: {
  run: RunSummary | null;
  title?: string;
  eyebrow?: string;
  sidebarWidth: number;
  resizeHandle: ReactNode;
  steps: ReactNode;
  stepCount: number;
  reportViewMode: ReportViewMode;
  onReportViewModeChange: (mode: ReportViewMode) => void;
  replayAllMode: boolean;
  canReplayAll: boolean;
  setReplayAllMode: (on: boolean) => void;
  modelCalls: boolean;
  onModelCallsChange: (on: boolean) => void;
  modelBrief?: string;
  version?: string | null;
  isDarkMode: boolean;
  onToggleTheme: () => void;
  children: ReactNode;
}) {
  const { run } = props;
  const showing = (mode: ReportViewMode) => {
    props.setReplayAllMode(false);
    props.onReportViewModeChange(mode);
  };
  const title = run?.title ?? props.title ?? 'Report';
  // Model calls add the intent, model and token columns to the steps: the
  // sidebar opens out to hold them rather than squeeze them unreadable.
  const sideWidth = props.modelCalls ? Math.max(props.sidebarWidth, 780) : props.sidebarWidth;
  const where = run
    ? `${PLATFORM[run.platform] ?? run.platform} · ${run.device}`
    : props.eyebrow;

  return (
    <div className="ts-frame">
      <aside className="ts-side" style={{ width: sideWidth + 10 }}>
        <div className="ts-side-in">
          <div className="ts-side-logo">
            <Logo />
          </div>
          <nav className="ts-nav" aria-label="Report views">
            <NavItem
              glyph="tests"
              label="Steps"
              count={props.stepCount}
              on={props.reportViewMode === 'human' && !props.replayAllMode}
              onClick={() => showing('human')}
            />
            <NavItem
              glyph="replay"
              label="Replay all"
              on={props.replayAllMode}
              disabled={!props.canReplayAll}
              onClick={() => {
                props.onReportViewModeChange('human');
                props.setReplayAllMode(true);
              }}
            />
            <NavItem
              glyph="report"
              label="Markdown"
              on={props.reportViewMode === 'markdown'}
              onClick={() => showing('markdown')}
            />
            <NavItem
              glyph="chip"
              label="Model calls"
              count={run?.calls}
              on={props.modelCalls}
              toggle
              title="Show each step's model, tokens and cost in the list"
              onClick={() => props.onModelCallsChange(!props.modelCalls)}
            />
          </nav>
          <div className="ts-side-body">{props.steps}</div>
          <div className="ts-side-foot">
            <PlatformMark platform={run?.platform} size={14} />
            <span className="ts-side-foot-text" title={run ? `${run.engine}${props.version ? ` · testsky v${props.version}` : ''}` : undefined}>
              {where ?? 'Midscene report'}
            </span>
            <button
              type="button"
              className="ts-round"
              aria-label={props.isDarkMode ? 'Day theme' : 'Night theme'}
              title={props.isDarkMode ? 'Day theme' : 'Night theme'}
              onClick={props.onToggleTheme}
            >
              {props.isDarkMode ? <NightGlyph /> : <DayGlyph />}
            </button>
          </div>
        </div>
      </aside>
      {props.resizeHandle}
      <main className="ts-main">
        <div className="ts-header">
          <h1 className="ts-title" title={title}>
            {title}
          </h1>
          {run ? (
            <span
              className={`ts-pill ${run.tone === 'neutral' ? '' : run.tone}`}
              title={run.verdict}
            >
              <span className="ts-pill-code">{run.outcome}</span>
              {run.tone === 'neutral' ? null : run.detail}
            </span>
          ) : null}
          <div className="ts-header-right">
            {run ? (
              <>
                <span className="ts-pill mono">
                  {run.passed}/{run.steps} passed
                </span>
                <span className="ts-pill mono">{seconds(run.finishedAt - run.startedAt)}</span>
                <span className="ts-pill mono">
                  {run.usd > 0 ? `$${run.usd.toFixed(4)}` : `${(run.tokensIn / 1000).toFixed(1)}k tokens`}
                </span>
                {run.remembered ? (
                  <span className="ts-pill ice">{run.remembered} from memory</span>
                ) : null}
                {run.agreed ? (
                  <span className="ts-pill ice" title="Targets the model and the accessibility tree found on the same control">
                    {run.agreed} agreed
                  </span>
                ) : null}
                {run.treeAlone ? (
                  <span className="ts-pill ice" title="Targets the accessibility tree held when the model found nothing">
                    {run.treeAlone} by the tree
                  </span>
                ) : null}
              </>
            ) : props.modelBrief ? (
              <span className="ts-pill mono">{props.modelBrief}</span>
            ) : null}
          </div>
        </div>
        <div className="ts-work">{props.children}</div>
      </main>
    </div>
  );
}
