import test from "node:test";
import assert from "node:assert/strict";

const sceneDurations = [4, 8, 6, 6, 4, 2];
const transitionDuration = 0.6;

function paddedClipDurations() {
  return sceneDurations.map((duration, index) => (
    index < sceneDurations.length - 1 ? duration + transitionDuration : duration
  ));
}

function assembledDuration(transitionPlan) {
  const durs = paddedClipDurations();
  let total = durs[0];
  for (let i = 1; i < durs.length; i++) {
    const transition = transitionPlan[i - 1]?.transition;
    const duration = Number(transitionPlan[i - 1]?.duration_sec) || 0;
    total += transition === "cut" || duration <= 0 ? durs[i] : durs[i] - duration;
  }
  return total;
}

test("Premium production bug: numeric transition argument creates a 33s concat", () => {
  assert.equal(assembledDuration(transitionDuration), 33);
});

test("Premium transition plan overlaps all five boundaries and produces 30s", () => {
  const plan = sceneDurations.slice(1).map(() => ({
    transition: "fade",
    duration_sec: transitionDuration,
  }));
  assert.equal(assembledDuration(plan), 30);
});
