import '@testsky/look/fonts';
import { NavItem, PlatformMark } from '@testsky/look/frame';
import { DayGlyph, NightGlyph } from '@testsky/look/glyphs';
import { teskyTheme } from '@testsky/look/theme';
import {
  type UniversalPlaygroundConfig,
  UniversalPlayground,
  useGlobalPreference,
} from '@testsky/visualizer';
import { App as AntdApp, ConfigProvider } from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { Logo } from './Logo';
import { SaveStep } from './SaveStep';
import { ScreenPanel } from './ScreenPanel';
import {
  type PlaygroundStatus,
  TREE_EVENT,
  TestskySDK,
  fetchStatus,
} from './sdk';
import '@testsky/look/look.less';
import '@testsky/look/frame.less';
import './App.less';

// Midscene's own playground app sets these; the conversation looks the same.
const CONFIG: UniversalPlaygroundConfig = {
  showContextPreview: false,
  layout: 'vertical',
  showVersionInfo: false,
  enableScrollToBottom: false,
  serverMode: true,
  showEnvConfigReminder: false,
  showClearButton: false,
  showSystemMessageHeader: false,
  promptInputChrome: { variant: 'minimal' },
  executionFlow: { collapsible: true },
};

const PLATFORM: Record<string, string> = { android: 'Android', ios: 'iOS' };

function useNarrowScreen() {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const check = () => setNarrow(window.innerWidth <= 1024);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);
  return narrow;
}

/**
 * The playground in Tesky's frame: the narrow glass sidebar with the mark,
 * the playground and its tree, and the device at its foot; beside it one
 * header line, then Midscene's conversation and the phone, side by side.
 */
export default function App() {
  const sdk = useMemo(() => new TestskySDK(), []);
  const narrow = useNarrowScreen();
  const [status, setStatus] = useState<PlaygroundStatus | null>(null);
  const [online, setOnline] = useState(true);
  const [tree, setTree] = useState<{ shown: boolean; count: number | null }>({
    shown: false,
    count: null,
  });
  const { darkModeEnabled: dark, setDarkModeEnabled: setDark } =
    useGlobalPreference();

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  }, [dark]);

  useEffect(() => {
    let stopped = false;
    const poll = async () => {
      const next = await fetchStatus();
      if (stopped) return;
      setOnline(next !== null);
      if (next) setStatus(next);
    };
    poll();
    const timer = setInterval(poll, 2000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);

  const session = status?.session;
  const config = useMemo<UniversalPlaygroundConfig>(
    () => ({
      ...CONFIG,
      deviceType: status?.platform ?? 'android',
      resultExtra: (result: unknown) => <SaveStep result={result} session={session} />,
    }),
    [status?.platform, session],
  );
  const onTreeState = useCallback(
    (state: { shown: boolean; count: number | null }) => setTree(state),
    [],
  );

  const device = status
    ? `${PLATFORM[status.platform] ?? status.platform} · ${status.device}`
    : 'connecting';
  const themeSwitch = (
    <button
      type="button"
      className="ts-round"
      aria-label={dark ? 'Day theme' : 'Night theme'}
      title={dark ? 'Day theme' : 'Night theme'}
      onClick={() => setDark(!dark)}
    >
      {dark ? <NightGlyph /> : <DayGlyph />}
    </button>
  );

  if (!online) {
    return (
      <ConfigProvider theme={teskyTheme(dark)}>
        <div className="server-offline-container">
          <div className="server-offline-message">
            <Logo />
            <div className="server-offline-content">
              <h1>The playground stopped</h1>
              <p className="connection-status">
                Start it again with <code>testsky playground</code>.
              </p>
            </div>
          </div>
        </div>
      </ConfigProvider>
    );
  }

  return (
    <ConfigProvider theme={teskyTheme(dark)}>
      <AntdApp component={false}>
        <div className="ts-frame">
          <aside className="ts-side" style={{ width: 230 }}>
            <div className="ts-side-in">
              <div className="ts-side-logo">
                <Logo />
              </div>
              <nav className="ts-nav" aria-label="Playground">
                <NavItem glyph="agent" label="Playground" on />
                <NavItem
                  glyph="tree"
                  label="Tree"
                  count={tree.count ?? undefined}
                  on={tree.shown}
                  toggle
                  disabled={status?.tree === false || status?.busy}
                  title="Outline what the accessibility tree says is on screen"
                  onClick={() => window.dispatchEvent(new CustomEvent(TREE_EVENT))}
                />
              </nav>
              <div className="ts-side-body ts-side-note">
                Each instruction runs as a one-step testsky test, with the
                planner, memory and checks a run uses.
                {status?.test ? (
                  <p className="ts-side-test" title={status.test}>
                    Steps are saved to {status.test.split(/[\\/]/).pop()}.
                  </p>
                ) : null}
              </div>
              <div className="ts-side-foot">
                <PlatformMark platform={status?.platform} size={14} />
                <span className="ts-side-foot-text" title={status?.engine}>
                  {device}
                </span>
                {themeSwitch}
              </div>
            </div>
          </aside>
          <main className="ts-main">
            <div className="ts-header">
              <h1 className="ts-title">Playground</h1>
              <span className={`ts-pill ${status?.busy ? 'ice' : ''}`}>
                {status?.busy ? <span className="ts-dot live" /> : null}
                {status?.busy ? 'running' : 'ready'}
              </span>
            </div>
            <div className="ts-work">
              <PanelGroup
                autoSaveId="testsky-playground-frame"
                direction={narrow ? 'vertical' : 'horizontal'}
              >
                <Panel defaultSize={38} minSize={25} className="ts-pane">
                  <div className="ts-pane-in">
                    <UniversalPlayground
                      playgroundSDK={sdk}
                      config={config}
                      branding={{
                        title: 'testsky Playground',
                        targetName: status?.platform === 'ios' ? 'iPhone' : 'phone',
                      }}
                      className="playground-container"
                    />
                  </div>
                </Panel>
                <PanelResizeHandle className="panel-resize-handle" />
                <Panel defaultSize={62} minSize={30} className="ts-pane">
                  <div className="ts-pane-in screen">
                    <ScreenPanel status={status} onTreeState={onTreeState} />
                  </div>
                </Panel>
              </PanelGroup>
            </div>
          </main>
        </div>
      </AntdApp>
    </ConfigProvider>
  );
}
