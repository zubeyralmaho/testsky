import assert from "node:assert/strict";
import test from "node:test";

import { fetchPopupRules } from "./popups.ts";

const answering = (status: number, body: unknown) => async () =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("the organisation's rules arrive, and only what this runner can use is kept", async () => {
  const fetched = await fetchPopupRules(answering(200, { rules: { notifications: "allow", rating: "allow", location: "off" } }));
  assert.deepEqual(fetched, { rules: { notifications: "allow", location: "off" } });
});

test("a control plane that does not have them yet, or cannot be reached, costs the run nothing", async () => {
  assert.deepEqual(await fetchPopupRules(answering(404, "not found")), { rules: {}, error: "the control plane answered 404" });
  const down = await fetchPopupRules(async () => {
    throw Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } });
  });
  assert.deepEqual(down, { rules: {}, error: "ECONNREFUSED" });
});
