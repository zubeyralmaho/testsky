import assert from "node:assert/strict";
import test from "node:test";

import { parseTestFile, TestFileError } from "./parse.ts";
import { appendSteps } from "./write.ts";

const SETTINGS = { id: "settings", title: "settings", target: { platform: "android" as const, app: "com.android.settings" } };

test("a file not there yet is begun: the app launched first and closed after, the steps in between", () => {
  const { source, ids } = appendSteps(undefined, [{ do: "tap Network & internet" }, { expect: "the Internet screen is shown" }], SETTINGS);
  assert.deepEqual(ids, ["tap-network-internet", "the-internet-screen-is-shown"]);
  assert.equal(
    source,
    [
      "# Begun in the testsky playground: each step is an instruction as it was given there.",
      "# The run launches the app first, so the first step starts from the app's first screen.",
      "",
      "id: settings",
      "title: settings",
      "targets:",
      "  - { platform: android, app: com.android.settings }",
      "setup:",
      "  - launch app",
      "steps:",
      "  - id: tap-network-internet",
      "    do: tap Network & internet",
      "  - id: the-internet-screen-is-shown",
      "    expect: the Internet screen is shown",
      "teardown:",
      "  - terminate app",
      "",
    ].join("\n"),
  );
  const file = parseTestFile(source);
  assert.deepEqual(file.setup, [{ kind: "launch" }]);
  assert.deepEqual(file.steps.map((step) => step.id), ids);
});

const WRITTEN = `# Settings, by hand.
id: settings
title: Settings
targets:
  - { platform: ios, app: com.apple.Preferences } # the simulator's
steps:
  - do: tap General
    expect: the General screen is shown

  # The one people forget.
  - id: about
    do: tap About
`;

test("a file a person wrote keeps every comment and word, and new ids never take one already given", () => {
  const { source, ids } = appendSteps(WRITTEN, [{ do: "tap General" }, { do: "tap About", expect: "the About screen is shown" }], SETTINGS);
  assert.deepEqual(ids, ["tap-general-2", "tap-about"], "tap-general is the first step's derived id; about is written");
  assert.equal(
    source,
    WRITTEN.replace(
      "app: com.apple.Preferences } # the simulator's\n",
      "app: com.apple.Preferences } # the simulator's\n  - { platform: android, app: com.android.settings }\n",
    ) +
      ["", "  - id: tap-general-2", "    do: tap General", "", "  - id: tap-about", "    do: tap About", "    expect: the About screen is shown", ""].join("\n"),
    "every comment and word kept, the platform it was saved on added as a target, spaced as the file spaces its steps",
  );
  const file = parseTestFile(source);
  assert.deepEqual(file.steps.map((step) => step.id), ["tap-general", "about", "tap-general-2", "tap-about"]);
  assert.deepEqual(file.targets.map((target) => target.platform), ["ios", "android"]);
});

test("a step that only reads is no step of its own, and nothing is written for it", () => {
  assert.throws(() => appendSteps(undefined, [{ extract: { total: "the total" } }], SETTINGS), TestFileError);
  assert.throws(() => appendSteps(undefined, [], SETTINGS), /no step to add/);
});

test("a file that does not read as a test is left alone", () => {
  assert.throws(() => appendSteps("id: [unclosed", [{ do: "tap OK" }], SETTINGS), TestFileError);
  assert.throws(() => appendSteps("id: x\ntargets: []\nsteps: []\n", [{ do: "tap OK" }], SETTINGS), TestFileError);
});
