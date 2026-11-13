import assert from "node:assert/strict";
import test from "node:test";

import { TestFileError, deriveStepId, parseDirective, parseTestFile, parseWithin } from "./parse.ts";
import { DEFAULT_POPUP_RULES, knownPopupRules, popupRules } from "./types.ts";

const MINIMAL = `
id: checkout
targets:
  - { platform: android, app: com.acme.shop }
steps:
  - do: tap the cart icon
    expect: the cart shows at least one line item
`;

test("a minimal file parses, with defaults filled in", () => {
  const file = parseTestFile(MINIMAL);
  assert.equal(file.id, "checkout");
  assert.equal(file.title, "checkout");
  assert.deepEqual(file.targets, [{ platform: "android", app: "com.acme.shop" }]);
  assert.deepEqual(file.policy, {
    runs: 3,
    passThreshold: 3,
    budget: { maxSteps: 40, maxUsd: 0.1, maxSeconds: 300 },
  });
  assert.equal(file.steps.length, 1);
  assert.equal(file.steps[0]!.do, "tap the cart icon");
});

test("step ids come from the step's own words, so inserting one does not renumber the rest", () => {
  const file = parseTestFile(`
id: t
targets: [{ platform: ios, app: co.acme.app }]
steps:
  - do: tap the cart icon
  - do: tap the cart icon
  - id: explicit
    do: pay
`);
  assert.deepEqual(file.steps.map((s) => s.id), ["tap-the-cart-icon", "tap-the-cart-icon-2", "explicit"]);
  assert.deepEqual(file.steps.map((s) => s.idGenerated), [true, true, false]);
});

test("deriveStepId keeps it short, slugged and unique", () => {
  const taken = new Set<string>();
  assert.equal(deriveStepId("Tap the “Proceed to checkout” button now, please", taken), "tap-the-proceed-to-checkout");
  taken.add("tap-the-proceed-to-checkout");
  assert.equal(deriveStepId("Tap the “Proceed to checkout” button now, please", taken), "tap-the-proceed-to-checkout-2");
  assert.equal(deriveStepId("!!!", new Set()), "step");
});

test("setup lines parse into the few things they are allowed to be", () => {
  assert.deepEqual(parseDirective("launch app", "x"), { kind: "launch" });
  assert.deepEqual(parseDirective("launch the app com.acme.shop", "x"), { kind: "launch", app: "com.acme.shop" });
  assert.deepEqual(parseDirective("terminate app", "x"), { kind: "terminate" });
  assert.deepEqual(parseDirective("use fixture: seeded_cart", "x"), { kind: "fixture", name: "seeded_cart" });
  // Anything else is just an instruction for the agent.
  assert.deepEqual(parseDirective("dismiss the cookie banner", "x"), {
    kind: "do",
    text: "dismiss the cookie banner",
  });
});

test("a step with neither do nor expect is rejected, by index", () => {
  assert.throws(
    () =>
      parseTestFile(`
id: t
targets: [{ platform: android, app: a }]
steps:
  - do: tap
  - channel: tree
`),
    (error: unknown) => {
      assert.ok(error instanceof TestFileError);
      assert.match(error.message, /steps\[1\]/);
      assert.match(error.message, /`do` \(an action\) or `expect` \(a check\)/);
      return true;
    },
  );
});

test("pass_threshold cannot exceed runs, and channel is checked", () => {
  assert.throws(
    () => parseTestFile(`${MINIMAL}\npolicy: { runs: 2, pass_threshold: 3 }`),
    /pass_threshold` cannot exceed/,
  );
  assert.throws(
    () =>
      parseTestFile(`
id: t
targets: [{ platform: android, app: a }]
steps:
  - do: tap
    channel: xml
`),
    /`channel` must be vision or tree/,
  );
});

test("extract and channel survive the round trip", () => {
  const file = parseTestFile(`
id: t
targets: [{ platform: ios, app: a }]
steps:
  - id: pin
    do: enter the payment PIN
    channel: tree
  - id: confirm
    expect: an order number is visible
    extract:
      order_number: the order number on the confirmation
`);
  assert.equal(file.steps[0]!.channel, "tree");
  assert.deepEqual(file.steps[1]!.extract, { order_number: "the order number on the confirmation" });
});

test("broken YAML says so instead of throwing a parser stack", () => {
  assert.throws(() => parseTestFile("id: [unclosed", "checkout.testsky.yaml"), /checkout\.testsky\.yaml: not valid YAML/);
});

test("pop-up rules are read in the words people use, and only where they mean something", () => {
  const file = parseTestFile(`${MINIMAL}
policy:
  popups:
    notifications: allow
    cookies: Reject
    rating: off
`);
  assert.deepEqual(file.policy.popups, { notifications: "allow", cookies: "deny", rating: "off" });

  assert.throws(
    () => parseTestFile(`${MINIMAL}\npolicy:\n  popups:\n    rating: allow\n`),
    (error: unknown) =>
      error instanceof TestFileError && /policy\.popups\.rating` must be dismiss or off -- a sheet is closed/.test(error.message),
  );
  assert.throws(
    () => parseTestFile(`${MINIMAL}\npolicy:\n  popups:\n    newsletter: dismiss\n`),
    (error: unknown) => error instanceof TestFileError && /not a kind of pop-up -- use one of notifications/.test(error.message),
  );
});

test("a policy without pop-up rules says nothing about them, so the shared rules apply", () => {
  assert.equal(parseTestFile(MINIMAL).policy.popups, undefined);
  assert.deepEqual(popupRules(), DEFAULT_POPUP_RULES);
  assert.equal(popupRules({ notifications: "allow" }, { notifications: "off" }).notifications, "off", "the test's own rule wins");
});

test("shared rules from the wire keep what is valid and drop the rest", () => {
  assert.deepEqual(
    knownPopupRules({ notifications: "allow", rating: "allow", newsletter: "dismiss", promo: "off", other: 3 }),
    { notifications: "allow", promo: "off" },
    "a rating is closed, never allowed; a kind this runner does not know is not refused, just not used",
  );
  assert.deepEqual(knownPopupRules(null), {});
  assert.deepEqual(knownPopupRules(["deny"]), {});
});

test("a wait is written the way a person says it", () => {
  assert.equal(parseWithin("45s", "x"), 45_000);
  assert.equal(parseWithin("2m", "x"), 120_000);
  assert.equal(parseWithin("1m30s", "x"), 90_000);
  assert.equal(parseWithin("1 min 5 sec", "x"), 65_000);
  assert.equal(parseWithin(30, "x"), 30_000);
  assert.equal(parseWithin("7.5", "x"), 7_500);
  for (const wrong of ["", "soon", "0s", "-5", "5h", true, "0.0004", 0.5]) assert.throws(() => parseWithin(wrong, "x"), TestFileError, String(wrong));
});

test("within belongs to an expectation, and fits in the test's own time", () => {
  const withWait = (step: string, seconds = 300) => `
id: wifi
targets: [{ platform: android, app: com.android.settings }]
policy: { budget: { max_seconds: ${seconds} } }
steps:
${step}
`;
  const file = parseTestFile(withWait(`  - { do: join "Lab", expect: '"Lab" is shown as connected', within: 45s }`));
  assert.equal(file.steps[0]!.within, 45_000);
  assert.equal(parseTestFile(MINIMAL).steps[0]!.within, undefined, "and is absent unless written");
  assert.throws(() => parseTestFile(withWait(`  - { do: join "Lab", within: 45s }`)), /this step has no `expect`/);
  assert.throws(() => parseTestFile(withWait(`  - { expect: connected, within: 10m }`, 300)), /leaves the test's max_seconds \(300\) no time/);
  assert.throws(() => parseTestFile(withWait(`  - { expect: connected, within: 5m }`, 300)), /no time for anything else/, "the whole of it leaves none either");
});

test("a step cannot be secret: a report shows everything a run does", () => {
  assert.throws(
    () =>
      parseTestFile(`
id: t
targets: [{ platform: ios, app: a }]
steps:
  - do: enter the payment PIN
    secret: true
`),
    /steps\[0\].*cannot be `secret`/s,
  );
});

test("a step can let time pass, alone or before its check, and not around an action", () => {
  const head = "id: soak\ntargets: [{ platform: android, app: com.acme }]\nsteps:\n";
  const parsed = parseTestFile(`${head}  - id: watch\n    wait: 30s\n  - wait: 1m\n    expect: it still plays\n`);
  assert.equal(parsed.steps[0]!.wait, 30_000);
  assert.equal(parsed.steps[0]!.expect, undefined);
  assert.equal(parsed.steps[1]!.wait, 60_000);
  assert.throws(() => parseTestFile(`${head}  - do: swipe up\n    wait: 30s\n`), /an action goes in a step of its own/);
  assert.throws(() => parseTestFile(`${head}  - wait: soon\n`), /`wait` is a wait of a second or more/);
});

test("a step can answer a call, alone or before its check, and says how long the call may take to come", () => {
  const head = "id: guest\ntargets: [{ platform: ios, app: com.facebook.Messenger }]\npolicy: { budget: { max_seconds: 600 } }\nsteps:\n";
  const parsed = parseTestFile(`${head}  - answer: call\n    ring: 240s\n  - id: in-call\n    answer: call\n    ring: 2m\n    expect: the call is connected\n    within: 30s\n`);
  assert.equal(parsed.steps[0]!.answer, "call");
  assert.equal(parsed.steps[0]!.ring, 240_000);
  assert.equal(parsed.steps[0]!.id, "answer-call");
  assert.equal(parsed.steps[1]!.expect, "the call is connected");
  assert.equal(parsed.steps[1]!.within, 30_000);
  assert.throws(() => parseTestFile(`${head}  - answer: call\n`), /needs `ring`/);
  assert.throws(() => parseTestFile(`${head}  - answer: message\n    ring: 30s\n`), /write `answer: call`/);
  assert.throws(() => parseTestFile(`${head}  - do: open the chat\n    answer: call\n    ring: 30s\n`), /an action goes in a step of its own/);
  assert.throws(() => parseTestFile(`${head}  - wait: 5s\n    answer: call\n    ring: 30s\n`), /use one of them/);
  assert.throws(() => parseTestFile(`${head}  - expect: chats show\n    ring: 30s\n`), /goes with `answer: call`/);
  assert.throws(() => parseTestFile(`${head}  - answer: call\n    ring: 10m\n`), /`ring` waits 600 s/);
});
