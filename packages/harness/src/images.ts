/**
 * The images a report carries: the frames a run kept, and every picture a
 * model was shown, each made once, by id.
 */

import { pictureId } from "@testsky/router";

/**
 * Frames and pictures, encoded for a report, base64 by id. A picture that is
 * a kept frame -- the screen an action was decided on, shown to the call that
 * decided it -- is that frame's encoding under both ids, so the report holds
 * it once.
 */
export async function reportImages(
  frames: ReadonlyMap<string, Buffer>,
  pictures: ReadonlyMap<string, Buffer>,
  encode: (image: Buffer) => Promise<Buffer>,
): Promise<Record<string, string>> {
  const made: Record<string, string> = Object.fromEntries(
    await Promise.all([...frames].map(async ([id, image]) => [id, (await encode(image)).toString("base64")] as const)),
  );
  const frameOf = new Map([...frames].map(([id, image]) => [pictureId(image), id] as const));
  const shown = await Promise.all(
    [...pictures].map(async ([id, bytes]) => {
      const frame = frameOf.get(id);
      return [id, frame ? made[frame]! : (await encode(bytes)).toString("base64")] as const;
    }),
  );
  return { ...made, ...Object.fromEntries(shown) };
}
