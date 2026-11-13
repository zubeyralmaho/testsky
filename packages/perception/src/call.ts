/**
 * The control that answers an incoming call, read off the tree.
 *
 * A ring lasts about thirty seconds, and a heads-up banner on Android folds
 * away in five: a model asked every few seconds whether a call is ringing,
 * and asked again where to press, misses it -- "You missed a video call" in
 * the chat list afterwards, with the call plainly delivered. The tree answers
 * in well under a second and needs no model, so it is asked first and often.
 *
 * Only a control that says it answers a call: a button word on its own ("Accept",
 * "Answer", "Kabul Et"), or with "call" after it, or an identifier that says
 * accept or answer. A line of a chat that happens to read "did you answer?" is
 * not a control, and nothing that declines, ignores or ends is ever one.
 */

import type { Rect, TreeNode, TreeSnapshot } from "@testsky/engine-core";

import { coversMostOf, pressableAt } from "./anchor.ts";

const SAYS_ANSWER = [
  /^(accept|answer)( (the )?(video |voice |audio )?call)?$/i,
  /^join( (the )?(video |voice |audio )?call)?$/i,
  /^(kabul et|cevapla|yanıtla|yanitla)$/i,
  /^(görüntülü |sesli )?aramayı (kabul et|cevapla|yanıtla)$/i,
];
const ID_SAYS_ANSWER = /(accept|answer)/i;
/** An identifier's words run together with "_" or capitals, so no word boundaries: "decline_and_answer_later" declines. */
const ID_SAYS_NO = /(decline|reject|ignore|dismiss|hang_?up|end_?call|later|reddet)/i;
const SAYS_NO = /\b(decline|reject|ignore|dismiss|hang ?up|end|not now|later)\b|reddet|yoksay|sonlandır|bitir|kapat/i;

export interface CallControl {
  /** What it says, or its identifier when it says nothing. */
  label: string;
  /** Where to press it: the control itself, or the button around a word that is not one. */
  bounds: Rect;
  /** The node that said it answers. */
  node: TreeNode;
}

function shown(node: TreeNode, ancestors: TreeNode[]): boolean {
  return node.visible !== false && ancestors.every((each) => each.visible !== false);
}

export function callAnswerControl(tree: TreeSnapshot): CallControl | undefined {
  const found: { control: CallControl; interactive: boolean }[] = [];
  const visit = (node: TreeNode, ancestors: TreeNode[]): void => {
    const label = (node.label ?? "").replace(/\s+/g, " ").trim();
    const identifier = node.identifier ?? "";
    const answers = SAYS_ANSWER.some((pattern) => pattern.test(label)) || (ID_SAYS_ANSWER.test(identifier) && !ID_SAYS_NO.test(identifier));
    const area = node.bounds.width * node.bounds.height;
    if (answers && !SAYS_NO.test(label) && area > 0 && shown(node, ancestors) && !coversMostOf(node.bounds, tree.root.bounds)) {
      const centre = { x: node.bounds.x + node.bounds.width / 2, y: node.bounds.y + node.bounds.height / 2 };
      const around = node.interactive ? node.bounds : (pressableAt(tree, centre) ?? node.bounds);
      found.push({ control: { label: label || identifier, bounds: around, node }, interactive: node.interactive });
    }
    for (const child of node.children) visit(child, [...ancestors, node]);
  };
  visit(tree.root, []);
  // A button before a word, and of buttons the first the screen lists.
  return (found.find((each) => each.interactive) ?? found[0])?.control;
}
