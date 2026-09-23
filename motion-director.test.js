import test from "node:test";
import assert from "node:assert/strict";
import {
  buildStillMotionFilter,
  normalizeMotionIntent,
  normalizeTransitionIntent,
  planMotionTreatments,
  planTransitions,
  selectMotionTreatment,
  transitionDuration,
} from "./motion-director.js";

test("existing payload without motion metadata receives a deterministic fallback", () => {
  const scenes = [
    { idx: 1, on_screen_text: "Chaos", visual_prompt: "busy inbox" },
    { idx: 2, on_screen_text: "Calm", visual_prompt: "organized queue" },
    { idx: 3, on_screen_text: "Proof", visual_prompt: "result card" },
  ];
  const first = planMotionTreatments(scenes);
  const second = planMotionTreatments(scenes);
  assert.deepEqual(first, second);
  assert.ok(new Set(first.map((s) => s.treatment)).size > 1);
});

test("explicit push-in, pull-out, pan and hold intents map safely", () => {
  assert.equal(normalizeMotionIntent("push in"), "push_in");
  assert.equal(normalizeMotionIntent("pull-out"), "pull_out");
  assert.equal(normalizeMotionIntent("pan_left"), "pan_left");
  assert.equal(normalizeMotionIntent("static"), "hold");
  assert.equal(selectMotionTreatment({ motion: "zoom in" }).treatment, "push_in");
});

test("unknown motion falls back and logo/end card remains nearly static", () => {
  assert.equal(normalizeMotionIntent("zoompan=z='2'"), null);
  assert.equal(selectMotionTreatment({ idx: 6, endcard: true, motion: "pan_right" }).treatment, "hold");
  assert.equal(selectMotionTreatment({ visual_prompt: "brand logo end card" }).treatment, "hold");
});

test("motion filters are cover-safe for 9:16, 1:1 and 16:9", () => {
  for (const [w, h] of [[1080, 1920], [1080, 1080], [1920, 1080]]) {
    const { frames, filter } = buildStillMotionFilter("pan_right", 5, w, h);
    assert.equal(frames, 150);
    assert.match(filter, new RegExp(`s=${w}x${h}:fps=30`));
    assert.match(filter, /force_original_aspect_ratio=increase/);
    assert.match(filter, /crop=\d+:\d+/);
    assert.doesNotMatch(filter, /zoompan=z='2'/);
  }
});

test("transition intent maps to supported restrained transitions", () => {
  assert.equal(normalizeTransitionIntent("cross fade"), "fade");
  assert.equal(normalizeTransitionIntent("slide-right"), "wiperight");
  assert.equal(normalizeTransitionIntent("hard_cut"), "cut");
  assert.equal(normalizeTransitionIntent("xfade=transition=pixelize"), null);
  assert.equal(transitionDuration("cut", 2), 0);
  assert.ok(transitionDuration("fade", 2) <= 0.6);
});

test("transition plan honors explicit values and falls back safely", () => {
  const plan = planTransitions([
    { idx: 1, transition_out: "reveal_left" },
    { idx: 2, transition_out: "pixelize" },
    { idx: 3, endcard: true },
  ]);
  assert.equal(plan[0].transition, "wipeleft");
  assert.equal(plan[1].transition, "fade");
});
