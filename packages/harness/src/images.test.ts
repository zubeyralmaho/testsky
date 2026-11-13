import assert from "node:assert/strict";
import test from "node:test";

import { pictureId } from "@testsky/router";

import { reportImages } from "./images.ts";

test("a picture a model was shown that is a kept frame is carried once, as that frame", async () => {
  const frame = Buffer.from("the screen an action was decided on");
  const ringed = Buffer.from("that screen with a ring drawn on it");
  let encodings = 0;
  const encode = async (image: Buffer) => {
    encodings += 1;
    return Buffer.from(`encoded ${image.toString()}`);
  };
  const images = await reportImages(
    new Map([["pay.action-1", frame]]),
    new Map([
      [pictureId(frame), Buffer.from("small copy of the screen")],
      [pictureId(ringed), Buffer.from("small copy of the ringed screen")],
    ]),
    encode,
  );
  assert.equal(images[pictureId(frame)], images["pay.action-1"], "the same encoding, under both ids");
  assert.equal(images[pictureId(ringed)], Buffer.from("encoded small copy of the ringed screen").toString("base64"));
  assert.equal(encodings, 2, "each image made once");
});
