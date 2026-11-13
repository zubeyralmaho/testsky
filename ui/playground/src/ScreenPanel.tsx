import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { canShowLive, openLiveScreen } from './live';
import { INSTRUCTION_EVENT, type PlaygroundStatus, TREE_EVENT } from './sdk';
import './ScreenPanel.less';

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface TreeNode {
  role: string;
  label?: string;
  value?: string;
  identifier?: string;
  bounds: Rect;
  enabled: boolean;
  interactive: boolean;
  children: TreeNode[];
}

interface TreeView {
  size: { width: number; height: number };
  nodes: TreeNode[];
  readAt: number;
  source?: string;
}

/**
 * The nodes worth outlining: the ones a model could be told about -- named,
 * identified or pressable -- and not the layout scaffolding around them.
 * Parents come before children, so a child is drawn over its parent and is
 * the one a pointer finds.
 */
function worthShowing(root: TreeNode): TreeNode[] {
  const kept: TreeNode[] = [];
  const walk = (node: TreeNode) => {
    const named = Boolean(node.label || node.value || node.identifier);
    if ((named || node.interactive) && node.bounds.width > 2 && node.bounds.height > 2) kept.push(node);
    for (const child of node.children ?? []) walk(child);
  };
  walk(root);
  return kept;
}

const pct = (part: number, whole: number) => `${Math.min(100, Math.max(0, (part / whole) * 100))}%`;

/**
 * The phone as it is now, with its accessibility tree laid over it.
 *
 * An Android phone streams its screen as it moves (live.ts), drawn over the
 * last screenshot until its first picture comes: a screen that is not
 * changing sends nothing. Anything else is polled, a frame a second, and
 * while an instruction runs the server answers with the run's own frames,
 * as it does when the stream ends. The tree is read on demand,
 * because reading it costs the phone a second or two: every node a model
 * could be told about is outlined, and hovering one shows what the tree calls
 * it. Midscene's playground has no such view; for testsky it is half the story.
 */
export function ScreenPanel({
  status,
  onTreeState,
}: {
  status: PlaygroundStatus | null;
  /** Told what the tree shows, for the sidebar's Tree entry. */
  onTreeState?: (state: { shown: boolean; count: number | null }) => void;
}) {
  const [src, setSrc] = useState<string>();
  const [size, setSize] = useState<{ width: number; height: number }>();
  const [problem, setProblem] = useState<string>();
  const [tree, setTree] = useState<TreeView | null>(null);
  const [showTree, setShowTree] = useState(false);
  const [reading, setReading] = useState(false);
  const [hovered, setHovered] = useState<TreeNode | null>(null);
  const [live, setLive] = useState(false);
  /** The poll's view of `live`: it looks before every frame, and skips the frame while the stream draws. */
  const liveNow = useRef(false);
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let stopped = false;
    let shown: string | undefined;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (liveNow.current) {
        if (!stopped) timer = setTimeout(tick, 1000);
        return;
      }
      try {
        const response = await fetch('/api/screenshot', { cache: 'no-store' });
        if (response.ok) {
          const url = URL.createObjectURL(await response.blob());
          const width = Number(response.headers.get('x-screen-width'));
          const height = Number(response.headers.get('x-screen-height'));
          if (stopped) {
            URL.revokeObjectURL(url);
            return;
          }
          setSrc(url);
          if (width > 0 && height > 0) setSize({ width, height });
          setProblem(undefined);
          if (shown) URL.revokeObjectURL(shown);
          shown = url;
        } else if (response.status !== 503) {
          const body = (await response.json().catch(() => ({}))) as { error?: string };
          setProblem(body.error ?? `the screen could not be read (${response.status})`);
        }
      } catch {
        setProblem('the playground server is not answering');
      }
      if (!stopped) timer = setTimeout(tick, 1000);
    };
    timer = setTimeout(tick, 0);
    return () => {
      stopped = true;
      clearTimeout(timer);
      if (shown) URL.revokeObjectURL(shown);
    };
  }, []);

  const readTree = useCallback(async () => {
    setReading(true);
    try {
      const response = await fetch('/api/tree', { cache: 'no-store' });
      const body = (await response.json()) as { error?: string; size: TreeView['size']; root: TreeNode; source?: string };
      if (!response.ok) throw new Error(body.error ?? `the tree could not be read (${response.status})`);
      setTree({ size: body.size, nodes: worthShowing(body.root), readAt: Date.now(), source: body.source });
      setShowTree(true);
      setProblem(undefined);
    } catch (error) {
      setProblem((error as Error).message);
    } finally {
      setReading(false);
    }
  }, []);

  // An instruction changes the screen under the outlines: they go while it
  // runs, and if they were up they come back read from the new screen.
  useEffect(() => {
    let wanted = false;
    const onInstruction = (event: Event) => {
      const phase = (event as CustomEvent<{ phase: 'start' | 'end' }>).detail.phase;
      if (phase === 'start') {
        setShowTree((shown) => {
          wanted = shown;
          return false;
        });
        setHovered(null);
      } else if (wanted) {
        wanted = false;
        readTree();
      }
    };
    window.addEventListener(INSTRUCTION_EVENT, onInstruction);
    return () => window.removeEventListener(INSTRUCTION_EVENT, onInstruction);
  }, [readTree]);

  // The sidebar's Tree entry: the first press reads it, later ones show or hide it.
  useEffect(() => {
    const onTree = () => {
      if (!tree) readTree();
      else setShowTree((shown) => !shown);
    };
    window.addEventListener(TREE_EVENT, onTree);
    return () => window.removeEventListener(TREE_EVENT, onTree);
  }, [tree, readTree]);

  useEffect(() => {
    onTreeState?.({ shown: Boolean(tree && showTree), count: tree ? tree.nodes.length : null });
  }, [tree, showTree, onTreeState]);

  // Opened again when the phone turns: the encoder is asked for the screen's shape.
  const liveKey =
    status?.live && canShowLive() && status.screen ? `${status.screen.width}x${status.screen.height}` : null;
  useEffect(() => {
    if (!liveKey || !canvas.current) return;
    const screen = openLiveScreen(canvas.current, {
      onPicture: () => {
        if (liveNow.current) return;
        liveNow.current = true;
        setLive(true);
      },
      onEnd: (reason) => {
        console.warn(`testsky playground: ${reason}; the screen is polled instead`);
        liveNow.current = false;
        setLive(false);
      },
    });
    return () => {
      screen.close();
      liveNow.current = false;
      setLive(false);
    };
  }, [liveKey]);

  const frameSize = size ?? status?.screen ?? status?.size ?? undefined;
  const nodes = useMemo(() => (showTree && tree ? tree.nodes : []), [showTree, tree]);

  return (
    <div className="screen-panel">
      <div className="screen-stage">
        {frameSize ? (
          <div className="screen-frame" style={{ aspectRatio: `${frameSize.width} / ${frameSize.height}` }}>
            {src ? <img src={src} alt="the phone's screen" draggable={false} /> : null}
            <canvas ref={canvas} className={live ? 'live' : 'live dark'} aria-label="the phone's screen, live" />
            {!src && !live ? <div className="screen-waiting in-frame">{problem ?? 'waiting for the first frame...'}</div> : null}
            {tree
              ? nodes.map((node, index) => (
                  <div
                    // biome-ignore lint/suspicious/noArrayIndexKey: a snapshot's nodes have no stable id
                    key={index}
                    className={['tree-node', node.interactive ? 'interactive' : '', hovered === node ? 'hovered' : ''].join(' ')}
                    style={{
                      left: pct(node.bounds.x, tree.size.width),
                      top: pct(node.bounds.y, tree.size.height),
                      width: pct(node.bounds.width, tree.size.width),
                      height: pct(node.bounds.height, tree.size.height),
                    }}
                    onMouseEnter={() => setHovered(node)}
                    onMouseLeave={() => setHovered((current) => (current === node ? null : current))}
                  />
                ))
              : null}
          </div>
        ) : (
          <div className="screen-waiting">{problem ?? 'waiting for the first frame...'}</div>
        )}
      </div>

      <div className="screen-footer">
        {hovered ? (
          <div className="tree-node-info">
            <strong>{hovered.role}</strong>
            {hovered.label ? <span>"{hovered.label}"</span> : null}
            {hovered.value ? <span>value "{hovered.value}"</span> : null}
            {hovered.identifier ? <code>{hovered.identifier}</code> : null}
            <span className="tree-node-meta">
              {hovered.interactive ? 'pressable' : 'not pressable'}
              {hovered.enabled ? '' : ' · disabled'} · {Math.round(hovered.bounds.x)},{Math.round(hovered.bounds.y)}{' '}
              {Math.round(hovered.bounds.width)}x{Math.round(hovered.bounds.height)}
            </span>
          </div>
        ) : problem && src ? (
          <div className="screen-problem">{problem}</div>
        ) : reading ? (
          <div className="screen-hint">reading the tree...</div>
        ) : (
          <div className="screen-hint">
            {tree && showTree
              ? `${tree.nodes.length} nodes, read ${new Date(tree.readAt).toLocaleTimeString()} · hover an outline to see what the tree calls it`
              : `${live ? 'Live. ' : ''}Tree, in the sidebar, outlines what the phone tells a model about this screen.`}
          </div>
        )}
      </div>
    </div>
  );
}
