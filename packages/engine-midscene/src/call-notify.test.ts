import assert from "node:assert/strict";
import test from "node:test";

import { callNotificationKeys } from "./android.ts";

const DUMP = [
  "Current Notification Manager state:",
  "  Notification List:",
  "    NotificationRecord(0x060b3f23: pkg=com.miui.videoplayer user=UserHandle{0} id=116 tag=null importance=4 key=0|com.miui.videoplayer|116|null|10150: Notification(channel=play category=transport flags=0x2))",
  "      uid=10150 userId=0",
  "    NotificationRecord(0x0a1b2c3d: pkg=com.facebook.orca user=UserHandle{0} id=20001 tag=rtc importance=5 key=0|com.facebook.orca|20001|rtc|10234: Notification(channel=calls_v3 category=call actions=2 flags=0x82))",
  "      uid=10234 userId=0",
  "      fullscreenIntent=PendingIntent{...}",
  "  Notification attention state:",
  "  mArchive=Archive (2 notifications)",
  "    NotificationRecord(0x0fffffff: pkg=com.facebook.orca user=UserHandle{0} id=19999 tag=rtc importance=5 key=0|com.facebook.orca|19999|rtc|10234: Notification(channel=calls_v3 category=call))",
].join("\n");

test("the call notifications posted now are read by their keys, and the archive of past ones is not", () => {
  assert.deepEqual(callNotificationKeys(DUMP), ["0|com.facebook.orca|20001|rtc|10234"]);
  assert.deepEqual(callNotificationKeys("  Notification List:\n  Notification attention state:\n"), []);
});
