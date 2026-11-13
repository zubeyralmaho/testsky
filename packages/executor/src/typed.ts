/**
 * Whether a field holds what was typed into it.
 *
 * Exactly, or as the app formats it -- a phone number's spaces and brackets,
 * a card number's groups -- is "same". Only the case changed, as a keyboard
 * capitalising the first letter does, is "recased": worth saying, not worth
 * typing again, because the keyboard would do it again. Anything else is
 * "different": a character dropped, a word corrected, the old text still in
 * front of the new.
 */
export function compareTyped(holds: string, typed: string, append = false): "same" | "recased" | "different" {
  const ends = (whole: string, part: string) => (append ? whole.endsWith(part) : whole === part);
  if (ends(holds, typed)) return "same";
  const plain = (text: string) => text.normalize("NFKC").replace(/[\s\-().+/]/gu, "");
  if (ends(plain(holds), plain(typed))) return "same";
  const folded = (text: string) => [plain(text).toLowerCase(), plain(text).toLocaleLowerCase("tr")];
  const [holdsEn, holdsTr] = folded(holds);
  const [typedEn, typedTr] = folded(typed);
  if (ends(holdsEn!, typedEn!) || ends(holdsTr!, typedTr!)) return "recased";
  return "different";
}
