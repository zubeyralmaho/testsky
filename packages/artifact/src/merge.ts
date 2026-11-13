/**
 * Two runs, one memory.
 *
 * Phones that share a screen layout share a lock, and phones run at the same
 * time: each run reads the memory when it starts and writes it when it ends.
 * Written whole, the second run's file erased what the first had learned -- a
 * step one phone had re-resolved went back to the old taps on the next run,
 * and a heal waiting for review was gone before anybody saw it.
 *
 * So a run writes only what it changed, on top of the file as it is now: a
 * three-way merge of what the run read (`base`), what it leaves (`ours`) and
 * what is on disk by the time it writes (`disk`) -- per step, per remembered
 * check and per heal. Where the merge cannot know, it leans the way that costs
 * a model call rather than the way that answers from a memory nobody earned.
 */

import type { HealRecord, LockFile, RememberedPrint, RememberedVerdict, StepResolution } from "./lock.ts";

/** Prints kept per step -- enough for the densities of one layout, not a history. */
export const PRINTS_KEPT = 4;

export function mergeLock(base: LockFile, ours: LockFile, disk: LockFile | null): LockFile {
  // Nobody wrote in between, or nothing readable is there: this run's memory is the memory.
  if (!disk || same(disk, base)) return ours;
  // A build adopted by this run is the build these phones run now.
  const appBuild = ours.appBuild !== base.appBuild ? ours.appBuild : disk.appBuild;
  const layout = ours.layout ?? disk.layout;
  const verdicts = mergeVerdicts(base.verdicts ?? {}, ours.verdicts ?? {}, disk.verdicts ?? {});
  // In the order a lock is written, so a merged file diffs like any other.
  return {
    version: 1,
    test: ours.test,
    platform: ours.platform,
    ...(appBuild ? { appBuild } : {}),
    ...(layout ? { layout } : {}),
    steps: mergeSteps(base.steps, ours.steps, disk.steps),
    ...(Object.keys(verdicts).length ? { verdicts } : {}),
    heals: mergeHeals(base.heals, ours.heals, disk.heals),
  };
}

function mergeSteps(
  base: Record<string, StepResolution>,
  ours: Record<string, StepResolution>,
  disk: Record<string, StepResolution>,
): Record<string, StepResolution> {
  const merged = { ...disk };
  for (const id of new Set([...Object.keys(base), ...Object.keys(ours)])) {
    const was = base[id];
    const mine = ours[id];
    const theirs = disk[id];
    // Not touched by this run: what is on disk stands, even its absence.
    if (same(mine, was)) continue;
    if (!mine) {
      // Forgotten here. The other run counting the same memory once more does
      // not bring it back; a memory it learned anew stays.
      if (!theirs || sameMemory(theirs, was)) delete merged[id];
      continue;
    }
    if (!theirs) {
      // Forgotten there while this run only counted it: forgotten it stays.
      // Learned here, it is kept.
      if (!sameMemory(mine, was)) merged[id] = mine;
      continue;
    }
    if (sameMemory(mine, theirs)) {
      merged[id] = { ...mine, stability: counted(was, mine, theirs) };
      continue;
    }
    // Two different memories. If this run only counted the old one, the other
    // run's is the newer; if both learned anew, this run's is the later word.
    if (!sameMemory(mine, was)) merged[id] = mine;
  }
  return merged;
}

/** One memory, counted by two runs: each run's own runs and passes, added. */
function counted(was: StepResolution | undefined, mine: StepResolution, theirs: StepResolution): StepResolution["stability"] {
  const runs = theirs.stability.runs + mine.stability.runs - (was?.stability.runs ?? 0);
  const passes = theirs.stability.passes + mine.stability.passes - (was?.stability.passes ?? 0);
  const carried =
    mine.stability.carriedForwardFrom !== was?.stability.carriedForwardFrom
      ? mine.stability.carriedForwardFrom
      : theirs.stability.carriedForwardFrom;
  return { runs: Math.max(0, runs), passes: Math.max(0, passes), ...(carried ? { carriedForwardFrom: carried } : {}) };
}

function mergeVerdicts(
  base: Record<string, RememberedVerdict>,
  ours: Record<string, RememberedVerdict>,
  disk: Record<string, RememberedVerdict>,
): Record<string, RememberedVerdict> {
  const merged = { ...disk };
  for (const step of new Set([...Object.keys(base), ...Object.keys(ours)])) {
    if (same(ours[step], base[step])) continue;
    const prints = mergePrints(base[step]?.prints ?? [], ours[step]?.prints ?? [], disk[step]?.prints ?? []);
    if (prints.length) merged[step] = { prints };
    else delete merged[step];
  }
  return merged;
}

/**
 * A step's remembered checks, from two runs. A print either run let go of --
 * a model's "no", or the oldest pushed out -- is gone. A model's "yes" from
 * this run is added to the other run's only when nothing can have been said
 * against it in between: a "no" said on another phone to a print this run
 * never held leaves no trace to merge, so two first passes made side by side
 * count as one, and a print the other run had to begin again from is not
 * topped up with this run's older count. Either way the next run asks a model
 * once more, which is what a check that may have been doubted should cost.
 */
function mergePrints(was: RememberedPrint[], mine: RememberedPrint[], theirs: RememberedPrint[]): RememberedPrint[] {
  const find = (list: RememberedPrint[], print: string) => list.find((entry) => entry.print === print);
  const said: RememberedPrint[] = [];
  for (const entry of mine) {
    const before = find(was, entry.print);
    if (same(entry, before)) continue;
    const other = find(theirs, entry.print);
    if (!before) {
      said.push(other ? { print: entry.print, passes: Math.max(entry.passes, other.passes), since: Math.max(entry.since, other.since) } : entry);
      continue;
    }
    if (!other) continue;
    // Fewer passes there than when this run read it: it was forgotten there
    // and passed again since. That count is the one to keep.
    if (other.passes < before.passes) continue;
    // `since` counts answers from memory since a model last looked. Looked at
    // here, only the other run's answers after that are left; answered from
    // memory here, those answers are added to the other run's.
    const since = entry.since >= before.since ? other.since + entry.since - before.since : Math.max(0, other.since - before.since);
    said.push({ print: entry.print, passes: Math.max(0, other.passes + entry.passes - before.passes), since });
  }
  const dropped = new Set(was.filter((entry) => !find(mine, entry.print)).map((entry) => entry.print));
  const fresh = new Set(said.map((entry) => entry.print));
  // What this run said is the newest; the rest keep the other run's order.
  return [...said, ...theirs.filter((entry) => !fresh.has(entry.print) && !dropped.has(entry.print))].slice(0, PRINTS_KEPT);
}

/** Heals are recorded, then decided: each run's records kept, each run's decisions applied. */
function mergeHeals(base: HealRecord[], ours: HealRecord[], disk: HealRecord[]): HealRecord[] {
  const key = (heal: HealRecord) => stable({ step: heal.step, at: heal.at, before: heal.before, after: heal.after });
  const was = new Map(base.map((heal) => [key(heal), heal]));
  const mine = new Set(ours.map(key));
  const merged = disk.filter((heal) => !(was.has(key(heal)) && !mine.has(key(heal))));
  for (const heal of ours) {
    const id = key(heal);
    const before = was.get(id);
    const index = merged.findIndex((entry) => key(entry) === id);
    if (!before) {
      if (index === -1) merged.push(heal);
      continue;
    }
    const word = heal.status !== before.status;
    const acted = heal.applied !== before.applied;
    if (index === -1) {
      // A person's word heard by this run is not lost because the other run
      // did not hear it. A heal only acted on here is one the other run has
      // spent, or a person has deleted: gone it stays.
      if (word) merged.push(heal);
      continue;
    }
    // Each carried alone: a word written into the file since this run read it
    // is newer than the one acted on here, and the next run acts on it in turn.
    if (!word && !acted) continue;
    const entry = { ...merged[index]! };
    if (word) entry.status = heal.status;
    if (acted && heal.applied) entry.applied = heal.applied;
    else if (acted) delete entry.applied;
    merged[index] = entry;
  }
  return merged;
}

/**
 * The same memory: the same words, replayed as the same actions. A replay
 * writes the step back with the screen it ran on, its own tier and its own
 * confidence, so those say nothing about whether the memory changed -- read
 * as a change, a phone that only replayed a step overwrote another phone's
 * heal of it, and brought back a step another run had forgotten.
 */
function sameMemory(a: StepResolution | undefined, b: StepResolution | undefined): boolean {
  if (!a || !b) return a === b;
  return same({ do: a.do, actions: a.actions }, { do: b.do, actions: b.actions });
}

function same(a: unknown, b: unknown): boolean {
  return stable(a) === stable(b);
}

/** JSON with keys in one order: two copies of one value read back from YAML compare equal. */
function stable(value: unknown): string {
  if (value === undefined) return "undefined";
  return JSON.stringify(value, (_key, entry: unknown) =>
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : entry,
  );
}
