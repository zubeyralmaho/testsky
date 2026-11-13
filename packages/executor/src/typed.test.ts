import assert from "node:assert/strict";
import test from "node:test";

import { compareTyped } from "./typed.ts";

test("exactly, or as the app formats it, is the same", () => {
  assert.equal(compareTyped("hello", "hello"), "same");
  assert.equal(compareTyped("(555) 123-4567", "5551234567"), "same");
  assert.equal(compareTyped("4111 1111 1111 1111", "4111111111111111"), "same");
});

test("only the case changed is recased -- in Turkish too", () => {
  assert.equal(compareTyped("Hello", "hello"), "recased");
  assert.equal(compareTyped("İstanbul", "istanbul"), "recased");
  assert.equal(compareTyped("Istanbul", "ıstanbul"), "recased");
});

test("anything else is different: a character dropped, the old text still there", () => {
  assert.equal(compareTyped("helo", "hello"), "different");
  assert.equal(compareTyped("oldhello", "hello"), "different");
  assert.equal(compareTyped("", "hello"), "different");
});

test("added to what was there, the end is what counts", () => {
  assert.equal(compareTyped("+90 555", "555", true), "same");
  assert.equal(compareTyped("+90 556", "555", true), "different");
});
