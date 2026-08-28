import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("./server.js", import.meta.url), "utf8");

test("portrait captions use smart wrapping", () => {
  assert.match(source, /WrapStyle: 0/);
  assert.doesNotMatch(source, /WrapStyle: 2/);
});

test("brand and audio defects fail closed", () => {
  assert.match(source, /missing required brand logo_url/);
  assert.match(source, /required brand logo fetch failed/);
  assert.match(source, /await probeHasAudio\(outPath\)/);
  assert.match(source, /final MP4 is missing the required audio stream/);
});

test("short narration is fitted or rejected", () => {
  assert.match(source, /fitVoiceoverToTimeline/);
  assert.match(source, /coverage < 0\.55/);
  assert.match(source, /atempo=/);
});
