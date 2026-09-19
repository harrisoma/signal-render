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

test("every network call and ffmpeg pass is bounded", () => {
  // No bare fetch() left in the video path — each one goes through the timeout wrapper.
  const bareFetches = source.match(/(?<![A-Za-z])fetch\((?!url, \{ \.\.\.opts)/g) || [];
  assert.equal(bareFetches.length, 0, `unbounded fetch() calls: ${bareFetches.length}`);
  assert.match(source, /AbortSignal\.timeout\(ms\)/);
  assert.match(source, /ffmpeg killed after/);
  assert.match(source, /ffprobe timed out/);
});

test("chromium pages are rate-limited and the template endpoint is authenticated", () => {
  assert.match(source, /app\.post\("\/render", auth,/);
  assert.match(source, /app\.post\("\/render-html", htmlAuth,/);
  // Both Chromium routes take and release a page slot.
  assert.equal((source.match(/await pageSlots\.acquire\(\)/g) || []).length, 2);
  assert.equal((source.match(/pageSlots\.release\(\)/g) || []).length, 2);
  assert.match(source, /X-Img-Status/);
});

test("terminal jobs are pruned", () => {
  assert.match(source, /finished_at: Date\.now\(\)/);
  assert.match(source, /jobs\.delete\(id\)/);
});

test("screenshots are sent as raw bytes, not JSON", () => {
  // puppeteer >= 22 returns Uint8Array; res.send() must get a Buffer.
  assert.equal((source.match(/res\.send\(Buffer\.from\(buffer\)\)/g) || []).length, 2);
  assert.doesNotMatch(source, /res\.send\(buffer\)/);
});

test("html render token comparison ignores surrounding whitespace", () => {
  assert.match(source, /process\.env\.RENDER_HTML_TOKEN \|\| ""\)\.trim\(\)/);
  assert.match(source, /req\.headers\["x-render-token"\] \|\| ""\)\.trim\(\)/);
});
