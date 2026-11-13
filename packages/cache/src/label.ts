/** Words in common, as a fraction of the shorter side -- a corroboration, not
 *  a matcher. Kept here rather than imported from the router so the cache does
 *  not depend on the thing that spends money. */
export function labelOverlap(a: string, b: string): number {
  const words = (text: string) =>
    new Set(
      text
        .toLocaleLowerCase("tr")
        .split(/[^\p{L}\p{N}]+/u)
        .filter((word) => word.length > 2),
    );
  const left = words(a);
  const right = words(b);
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / Math.min(left.size, right.size);
}

const normalise = (text: string) => text.trim().replace(/\s+/g, " ").toLocaleLowerCase("tr");

/** Do two labels name the same control? Equality is asked first because the
 *  overlap skips the short words -- "OK", "No", "Go" -- and a label made only
 *  of those would otherwise share nothing with itself. */
export function sameLabel(a: string, b: string): boolean {
  const [one, other] = [normalise(a), normalise(b)];
  return one === other || labelOverlap(one, other) >= 0.5;
}
