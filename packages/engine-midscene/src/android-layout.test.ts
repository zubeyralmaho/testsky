import assert from "node:assert/strict";
import test from "node:test";

import { layoutToTree } from "./android-layout.ts";

const XML = `<?xml version="1.0" encoding="UTF-8"?><hierarchy rotation="0">
  <node index="0" text="" class="android.widget.FrameLayout" content-desc="" clickable="false" bounds="[0,0][1080,2400]" resource-id="">
    <node index="0" text="A &amp; B &#10;C" class="android.widget.TextView" content-desc="" clickable="false" bounds="[30,60][330,120]" resource-id="com.acme:id/title"/>
    <node index="1" text="" class="android.widget.SeekBar" content-desc="49 minutes 52 seconds of 5 hours" clickable="true" bounds="[0,300][1080,360]" resource-id="">
    </node>
  </node>
</hierarchy>`;

test("yadb's XML becomes the tree midscene's would: its class, its attributes, its bounds in points", () => {
  const root = layoutToTree(XML, 3)!;
  assert.equal(root.type, "android.widget.FrameLayout");
  assert.deepEqual(root.bounds, { left: 0, top: 0, width: 360, height: 800 });
  assert.equal(root.children.length, 2);
  const [title, bar] = root.children;
  assert.equal(title!.attrs.text, "A & B \nC");
  assert.equal(title!.attrs["resource-id"], "com.acme:id/title");
  assert.deepEqual(title!.bounds, { left: 10, top: 20, width: 100, height: 20 });
  assert.equal(bar!.attrs["content-desc"], "49 minutes 52 seconds of 5 hours");
  assert.equal(bar!.attrs.clickable, "true");
});

test("more than one window is one tree, and a dump that failed is none", () => {
  const two = layoutToTree(`<hierarchy><node class="a" bounds="[0,0][100,100]"/><node class="b" bounds="[0,100][100,300]"/></hierarchy>`, 1)!;
  assert.deepEqual(two.children.map((node) => node.type), ["a", "b"]);
  assert.deepEqual(two.bounds, { left: 0, top: 0, width: 100, height: 300 });
  assert.equal(layoutToTree("", 3), undefined);
  assert.equal(layoutToTree("cat: /data/local/tmp/yadb_layout_dump.xml: No such file or directory", 3), undefined);
});
