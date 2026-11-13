/**
 * Which control a tap at a point presses, said so that XCUITest can find it
 * again at the moment of the press.
 *
 * Only a control the tree the decision was made on names unmistakably: one
 * that nothing else on the screen is and says, or one that its row's own text
 * tells apart -- every network on the Wi-Fi page has a "More Info" button, and
 * only the network's name beside it says whose. Anything else is pressed where
 * it was seen, as before.
 */

import type { Point, TreeNode, TreeSnapshot } from "@testsky/engine-core";
import { controlInRow, controlPredicate, type WdaLocator } from "@testsky/devicectl-ios";
import { coversMostOf, pathAt } from "@testsky/perception";

/** What is pressed as a whole, a row or a button, rather than one of its parts. */
const PRESSABLE = /^(?:Button|Cell|Link)$/;

const same = (a: TreeNode, b: TreeNode): boolean =>
  a.role === b.role && (a.label ?? "") === (b.label ?? "") && (a.identifier ?? "") === (b.identifier ?? "");

function flatten(root: TreeNode, out: TreeNode[] = []): TreeNode[] {
  out.push(root);
  for (const child of root.children) flatten(child, out);
  return out;
}

export function controlLocator(tree: TreeSnapshot, point: Point): WdaLocator | undefined {
  const path = pathAt(tree.root, point.x, point.y);
  const node = path?.[path.length - 1];
  // A control the tree says is not drawn is not what the decision saw there:
  // XCUITest would press it where it is, under whatever is.
  if (!path || !node || node.visible === false || (!node.label && !node.identifier) || coversMostOf(node.bounds, tree.root.bounds)) return undefined;
  const everything = flatten(tree.root);
  const says = (text: string) => everything.filter((each) => each.role === "StaticText" && each.label === text).length;
  // A row's label is its parts joined -- "Office, Güvenli Ağ, Sinyal
  // Gücü: 3/3 çubuk" -- and its last parts change while it is pressed: the
  // signal went to 2/3 and the row was no longer there to press. Its name, a
  // text inside it no other text says, is the same row and does not change.
  if (PRESSABLE.test(node.role) && node.label?.includes(", ")) {
    const name = flatten(node).find((each) => each !== node && each.role === "StaticText" && each.label && each.visible !== false && says(each.label) === 1);
    const value = name ? controlPredicate(name) : undefined;
    if (value) return { using: "predicate string", value };
  }
  if (everything.filter((each) => same(each, node)).length === 1) {
    const value = controlPredicate(node);
    return value ? { using: "predicate string", value } : undefined;
  }
  // The nearest row around it, and a text in that row no other text says.
  const cell = path.slice(0, -1).reverse().find((each) => each.role === "Cell");
  if (!cell) return undefined;
  const inRow = flatten(cell);
  if (inRow.filter((each) => same(each, node)).length !== 1) return undefined;
  const row = inRow.find((each) => each.role === "StaticText" && each.label && says(each.label) === 1);
  return row?.label ? controlInRow(node, row.label) : undefined;
}
