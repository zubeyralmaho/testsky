import assert from "node:assert/strict";
import test from "node:test";

import { focusIn, launchCommand, launchedBehind, launchedInFront, resumedPackage } from "./android.ts";

test("an app's launcher activity is named to the phone's shell as it is, dollar sign and all", () => {
  assert.equal(
    launchCommand("com.google.android.youtube/.app.honeycomb.Shell$HomeActivity"),
    "am start -S --activity-clear-task -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -n 'com.google.android.youtube/.app.honeycomb.Shell$HomeActivity'",
  );
});

test("an app that asks for a permission as it opens has opened, and another app in front has not", () => {
  assert.equal(launchedInFront("com.android.deskclock", "com.android.deskclock"), true);
  assert.equal(launchedInFront("com.google.android.permissioncontroller", "com.android.deskclock"), true);
  assert.equal(launchedInFront("com.android.permissioncontroller", "com.android.deskclock"), true);
  assert.equal(launchedInFront("com.miui.home", "com.android.deskclock"), false);
  assert.equal(launchedInFront(undefined, "com.android.deskclock"), false);
});

test("the app resumed under a system overlay is read from dumpsys, whichever line says it", () => {
  // A Huawei phone, Calculator under the "Software update" sheet (window type 2003).
  const huawei = "    mResumedActivity: ActivityRecord{acc243c u0 com.huawei.calculator/.Calculator t357}\n";
  assert.equal(resumedPackage(huawei), "com.huawei.calculator");
  assert.equal(resumedPackage("  topResumedActivity=ActivityRecord{1f2e3d4 u0 com.android.deskclock/com.android.deskclock.DeskClock t12}"), "com.android.deskclock");
  assert.equal(resumedPackage(""), undefined);
});

test("an app that started behind a full-screen system activity has opened; one that fell to the launcher or never started has not", () => {
  assert.equal(launchedBehind("com.huawei.android.hwouc", "com.huawei.android.launcher", "4242\n"), true);
  assert.equal(launchedBehind("com.huawei.android.launcher", "com.huawei.android.launcher", "4242"), false);
  assert.equal(launchedBehind("com.huawei.android.hwouc", "com.huawei.android.launcher", ""), false);
  assert.equal(launchedBehind(undefined, "com.huawei.android.launcher", "4242"), false);
});

test("what is in front is the window with the focus, or the app with it where no window has", () => {
  // As a Nothing phone reports IxChariot, for as long as its first activity is up.
  assert.deepEqual(
    focusIn("  mCurrentFocus=null\n  mFocusedApp=ActivityRecord{efcce2e u0 com.ixia.ixchariot/.EULAActivity t538}\n    mShowingDream=false mDreamingLockscreen=false\n"),
    { appId: "com.ixia.ixchariot", screenId: "com.ixia.ixchariot.EULAActivity" },
  );
  assert.deepEqual(
    focusIn("  mCurrentFocus=Window{1 u0 com.android.settings/com.android.settings.Settings}\n  mFocusedApp=ActivityRecord{2 u0 com.other/.Under t1}\n"),
    { appId: "com.android.settings", screenId: "com.android.settings.Settings" },
  );
  assert.deepEqual(focusIn("  mCurrentFocus=null\n  mFocusedApp=null\n"), {});
});
