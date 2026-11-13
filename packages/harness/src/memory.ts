/**
 * The memory a test replays on one device: the lock for its screen layout.
 *
 * Kept per layout because a resolution is a place on a screen, and two
 * phones of one platform are two screens when their sizes differ. Devices
 * that share a layout share the lock.
 */

import { createHash } from "node:crypto";
import { readFile, realpath, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { emptyLock, layoutOf, lockPathFor, mergeLock, parseLockFile, serializeLockFile, type LockFile } from "@testsky/artifact";
import { testskyHome, withFileLock, type Platform } from "@testsky/engine-core";

export interface OpenedLock {
  /** Where it is written back, when the run keeps what it learned. */
  path: string;
  lock: LockFile;
  /** The lock as it was read, so that only what the run changed is written back. */
  base: LockFile;
}

/**
 * The lock for a test on a screen of this size: its own file, or the
 * platform's older one taken over, or a new one -- and none at all when the
 * size is not known, because the old one would be replayed on whatever size
 * of phone this is, which is the very bug layouts are for.
 */
export async function openLock(
  testPath: string,
  test: string,
  platform: Platform,
  size: { width: number; height: number } | undefined,
  options: { adopt?: boolean } = {},
): Promise<OpenedLock | undefined> {
  if (!size) return undefined;
  const path = lockPathFor(testPath, platform, size);
  const layout = layoutOf(size);
  const own = parseLockFile(await readFile(path, "utf8").catch(() => ""));
  if (own) return opened(path, own);

  // Memory from before it was kept per layout: the first device to run takes
  // it over, which on a runner with one phone is the phone that wrote it.
  // Moved, not copied, so a second layout starts clean instead of replaying
  // the first one's taps and calling every miss a change.
  const older = lockPathFor(testPath, platform);
  const seed = parseLockFile(await readFile(older, "utf8").catch(() => ""));
  if (seed) {
    // A pull request's run reads the memory and changes nothing on disk, not
    // even a file's name: which phone takes it over is the mainline's to say.
    if (options.adopt === false) return opened(path, { ...seed, layout });
    if (await rename(older, path).then(() => true, () => false)) return opened(path, { ...seed, layout });
  }
  // Another runner may have taken the old one over between the reads above,
  // and then it is at this path now: read it, rather than write an empty
  // memory over it at the end of the run.
  const theirs = parseLockFile(await readFile(path, "utf8").catch(() => ""));
  if (theirs) return opened(path, theirs);
  return opened(path, { ...emptyLock(test, platform), layout });
}

/**
 * Writes a run's memory back: only what the run changed, on top of the file
 * as it is now. Phones that share a layout share this file and run at the
 * same time, and a run that wrote its whole lock erased what another phone
 * had learned since it started. One writer at a time, and the file is
 * replaced whole or not at all -- a run killed while writing leaves the last
 * good memory, not half of one.
 */
export async function saveLock(lock: OpenedLock): Promise<LockFile> {
  // The file itself, however it is reached: a lock kept behind a link is
  // written where the link points and stays a link, and two spellings of one
  // file -- through a link, /tmp or /private/tmp, a letter's case on a Mac --
  // take one write lease between them, not one each.
  const target = await realpath(lock.path).catch(async () =>
    join(await realpath(dirname(lock.path)).catch(() => dirname(resolve(lock.path))), basename(lock.path)),
  );
  const key = createHash("sha1").update(target.toLowerCase()).digest("hex").slice(0, 16);
  return withFileLock(
    join(testskyHome(), "locks", `${key}.lock`),
    async () => {
      const merged = mergeLock(lock.base, lock.lock, readable(await readFile(target, "utf8").catch(() => "")));
      // Hidden: a run killed in this moment leaves no stray file a person
      // would take for a lock.
      const temporary = join(dirname(target), `.${basename(target)}.${process.pid}.tmp`);
      await writeFile(temporary, serializeLockFile(merged));
      await rename(temporary, target);
      // Written: what is on disk now is what the next save is measured against.
      lock.lock = merged;
      lock.base = structuredClone(merged);
      return merged;
    },
    { what: `writing ${basename(lock.path)}` },
  );
}

function opened(path: string, lock: LockFile): OpenedLock {
  return { path, lock, base: structuredClone(lock) };
}

/**
 * What is on disk when a run writes. A file that stopped reading as YAML
 * since the run opened it is written over, as every run's lock was before
 * runs merged; one that was unreadable when the run began stopped the run
 * there, for a person to fix.
 */
function readable(source: string): LockFile | null {
  try {
    return parseLockFile(source);
  } catch {
    return null;
  }
}
