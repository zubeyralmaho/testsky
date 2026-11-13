import assert from "node:assert/strict";
import test from "node:test";

import { exportMarkdown, importTestCases, parseCsv, serializeDraft } from "./import.ts";
import { parseTestFile } from "./parse.ts";

/** Shaped like a real Xray export: one row per step, the case repeated. */
const XRAY = `Key,Summary,Step Index,Action,Data,Expected Result
PAY-12,Guest checkout,1,"Open the app",,"The home screen is shown"
PAY-12,Guest checkout,2,"Search for a product","running shoes","Results list shows matching products"
PAY-12,Guest checkout,3,"Login",,"works"
PAY-9,Change password,1,"Open Settings > Security",,"The security screen is shown"
`;

test("an export becomes one draft per case, in the order the steps were written", () => {
  const drafts = importTestCases(parseCsv(XRAY), { platform: "android", app: "com.acme.shop" });
  assert.equal(drafts.length, 2);

  const checkout = drafts.find((draft) => draft.file.id === "pay-12")!;
  assert.equal(checkout.file.title, "Guest checkout");
  assert.equal(checkout.file.steps.length, 3);
  // Data belongs to the instruction, not to an invented field.
  assert.equal(checkout.file.steps[1]!.do, "Search for a product (running shoes)");
  assert.equal(checkout.file.steps[1]!.expect, "Results list shows matching products");
});

test("what a person has to fix is named, not guessed at", () => {
  const drafts = importTestCases(parseCsv(XRAY), { platform: "android", app: "com.acme.shop" });
  const checkout = drafts.find((draft) => draft.file.id === "pay-12")!;

  // "Login" is two words to a person who knows the app and nothing to an agent.
  assert.ok(checkout.warnings.some((warning) => /two words \("Login"\)/.test(warning)));
  // "works" cannot fail, which is the false-pass trap this product exists to avoid.
  assert.ok(checkout.warnings.some((warning) => /cannot fail/.test(warning)));
});

test("the draft says what it is at the top, and parses as a real test", () => {
  const drafts = importTestCases(parseCsv(XRAY), { platform: "ios", app: "co.acme.shop" });
  const yaml = serializeDraft(drafts[0]!, "PAY.csv");

  assert.match(yaml, /NOT a migration: read it before you run it/);
  assert.match(yaml, /Before this is worth running:/);

  const parsed = parseTestFile(yaml, "draft.testsky.yaml");
  assert.equal(parsed.id, "pay-12");
  assert.equal(parsed.targets[0]!.platform, "ios");
  assert.equal(parsed.steps.length, 3);
});

test("CSV quoting survives commas, quotes and newlines, because Jira exports have all three", () => {
  const rows = parseCsv(`Key,Action\nA-1,"Tap ""Buy now"", then wait"\nA-2,"Line one\nLine two"\n`);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.action, 'Tap "Buy now", then wait');
  assert.equal(rows[1]!.action, "Line one\nLine two");
});

test("export goes back the way it came, as a table somebody can paste into Jira", () => {
  const file = parseTestFile(`
id: checkout
targets: [{ platform: android, app: com.acme }]
steps:
  - do: tap the cart
    expect: the cart opens
`);
  const markdown = exportMarkdown(file);
  assert.match(markdown, /\| 1 \| tap the cart \| the cart opens \|/);
  assert.match(markdown, /the file, not this table, is what runs/);
});
