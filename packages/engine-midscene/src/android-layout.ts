/**
 * The screen's tree by yadb, which midscene already keeps on the phone to type with. `uiautomator
 * dump` starts a JVM and waits for the screen to go idle: 2.3 s at rest, and a playing video never
 * does, so three attempts time out and 15 s are gone. `yadb -layout` took 0.5 s on the same screen
 * and waits for nothing.
 */

const DUMP = "/data/local/tmp/yadb_layout_dump.xml";

/** Removed first: a dump that fails must not read back as the last screen's. */
export const LAYOUT_COMMAND = `rm -f ${DUMP}; app_process -Djava.class.path=/data/local/tmp/yadb /data/local/tmp com.ysbing.yadb.Main -layout >/dev/null 2>&1; cat ${DUMP}`;

/** Midscene's node, as android.ts reads it: bounds in logical points. */
export interface LayoutNode {
  type?: string;
  attrs: Record<string, string>;
  bounds: { left: number; top: number; width: number; height: number };
  children: LayoutNode[];
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

const decoded = (text: string): string =>
  text.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, (whole, name: string) => {
    if (ENTITIES[name]) return ENTITIES[name]!;
    const code = name[1]?.toLowerCase() === "x" ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
    return Number.isNaN(code) ? whole : String.fromCodePoint(code);
  });

/** The XML as a tree, or undefined when it holds no node: the dump failed. */
export function layoutToTree(xml: string, ratio: number): LayoutNode | undefined {
  const scale = ratio > 0 ? ratio : 1;
  const tops: LayoutNode[] = [];
  const open: LayoutNode[] = [];
  for (const [tag, body, closes] of xml.matchAll(/<node\b([^>]*?)(\/?)>|<\/node>/g)) {
    if (tag === "</node>") {
      open.pop();
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const [, name, value] of body!.matchAll(/([\w-]+)="([^"]*)"/g)) attrs[name!] = decoded(value!);
    const [left, top, right, bottom] = (/\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(attrs.bounds ?? "") ?? []).slice(1).map(Number);
    const node: LayoutNode = {
      ...(attrs.class ? { type: attrs.class } : {}),
      attrs,
      bounds: { left: (left ?? 0) / scale, top: (top ?? 0) / scale, width: ((right ?? 0) - (left ?? 0)) / scale, height: ((bottom ?? 0) - (top ?? 0)) / scale },
      children: [],
    };
    (open.at(-1)?.children ?? tops).push(node);
    if (!closes) open.push(node);
  }
  if (tops.length <= 1) return tops[0];
  const right = Math.max(...tops.map(({ bounds }) => bounds.left + bounds.width));
  const bottom = Math.max(...tops.map(({ bounds }) => bounds.top + bounds.height));
  return { type: "hierarchy", attrs: {}, bounds: { left: 0, top: 0, width: right, height: bottom }, children: tops };
}
