import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import ffmpeg from "ffmpeg-static";
import { buildStillMotionFilter } from "./motion-director.js";

const W = 180;
const H = 320;

function runFfmpeg(args) {
  const res = spawnSync(ffmpeg, args, { encoding: "utf8", maxBuffer: 1024 * 1024 * 8 });
  assert.equal(res.status, 0, res.stderr.slice(-1200));
}

function makePpm(path, i) {
  const colors = [[217, 72, 72], [47, 126, 216], [52, 168, 83], [246, 177, 61], [141, 92, 246], [17, 24, 39]];
  const bg = colors[i - 1];
  const data = Buffer.alloc(W * H * 3);
  const cx = 24 + i * 16;
  const cy = 34 + i * 22;
  const rx = W - 70 - i * 7;
  const ry = H - 95 + i * 5;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const off = (y * W + x) * 3;
      const checker = ((Math.floor(x / 16) + Math.floor(y / 16)) % 2) * 18;
      let r = Math.min(255, bg[0] + checker), g = Math.min(255, bg[1] + checker), b = Math.min(255, bg[2] + checker);
      if ((x - cx) * (x - cx) + (y - cy) * (y - cy) < 26 * 26) [r, g, b] = [255, 255, 255];
      if (x >= rx && x < rx + 46 && y >= ry && y < ry + 62) [r, g, b] = [15, 15, 15];
      if (x > 18 && x < 18 + i * 16 && y > H / 2 - 8 && y < H / 2 + 8) [r, g, b] = [255, 255, 255];
      data[off] = r; data[off + 1] = g; data[off + 2] = b;
    }
  }
  writeFileSync(path, Buffer.concat([Buffer.from(`P6\n${W} ${H}\n255\n`), data]));
}

function buildNormalizedChain(clipCount, durs, transitionPlan) {
  const fc = [];
  const norm = (label, out) => `${label}settb=AVTB,setpts=PTS-STARTPTS,fps=30,format=yuv420p[${out}]`;
  const inputLabels = Array.from({ length: clipCount }, (_, i) => `v${i}n`);
  inputLabels.forEach((label, i) => fc.push(norm(`[${i}:v]`, label)));
  let acc = durs[0];
  let prev = inputLabels[0];
  for (let k = 1; k < clipCount; k++) {
    const raw = `vr${k}`;
    const out = `vx${k}`;
    const transition = transitionPlan[k - 1].transition;
    const T = transitionPlan[k - 1].duration_sec;
    if (transition === "cut" || T <= 0) {
      fc.push(`[${prev}][${inputLabels[k]}]concat=n=2:v=1:a=0[${raw}]`);
      acc += durs[k];
    } else {
      fc.push(`[${prev}][${inputLabels[k]}]xfade=transition=${transition}:duration=${T.toFixed(3)}:offset=${Math.max(0, acc - T).toFixed(3)}[${raw}]`);
      acc += durs[k] - T;
    }
    fc.push(norm(`[${raw}]`, out));
    prev = out;
  }
  return { filter: fc.join(";"), last: prev, total: acc };
}

function frame(file, time) {
  const res = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-ss", String(time), "-i", file, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { encoding: "buffer", maxBuffer: W * H * 3 + 1024 * 1024 });
  assert.equal(res.status, 0, res.stderr.toString());
  return res.stdout;
}

function meanAbs(a, b) {
  let sad = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) sad += Math.abs(a[i] - b[i]);
  return sad / n;
}

test("mixed cut and xfade cinematic assembly preserves visible still motion", () => {
  const dir = mkdtempSync(join(tmpdir(), "sig-motion-"));
  try {
    const treatments = ["push_in", "pan_left", "drift_down", "pan_right", "diagonal_up", "hold"];
    const durs = [1.2, 1.2, 1.2, 1.2, 1.2, 1.0];
    const transitionPlan = [
      { transition: "wiperight", duration_sec: 0.3 },
      { transition: "cut", duration_sec: 0 },
      { transition: "wipeup", duration_sec: 0.3 },
      { transition: "wipeleft", duration_sec: 0.3 },
      { transition: "fade", duration_sec: 0.3 },
    ];
    const clipDurs = durs.map((d, i) => d + (transitionPlan[i]?.duration_sec || 0));
    const clips = [];
    for (let i = 0; i < 6; i++) {
      const img = join(dir, `scene-${i + 1}.ppm`);
      const clip = join(dir, `clip-${i + 1}.mp4`);
      makePpm(img, i + 1);
      const motion = buildStillMotionFilter(treatments[i], clipDurs[i], W, H);
      runFfmpeg(["-y", "-i", img, "-vf", motion.filter, "-frames:v", String(motion.frames), "-an", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "20", clip]);
      clips.push(clip);
    }
    const graph = buildNormalizedChain(clips.length, clipDurs, transitionPlan);
    const out = join(dir, "out.mp4");
    const args = ["-y"];
    clips.forEach((clip) => args.push("-i", clip));
    args.push("-filter_complex", graph.filter, "-map", `[${graph.last}]`, "-t", graph.total.toFixed(3), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-crf", "22", out);
    runFfmpeg(args);

    const samples = [[0.15, 0.95], [1.65, 2.25], [2.9, 3.6], [4.15, 4.75], [5.35, 5.75]];
    for (const [early, late] of samples) {
      assert.ok(meanAbs(frame(out, early), frame(out, late)) > 1, `expected visible motion between ${early}s and ${late}s`);
    }
    assert.ok(meanAbs(frame(out, 6.55), frame(out, 6.9)) < 1, "endcard should remain effectively still");

    const sceneRaws = Array.from({ length: 6 }, (_, i) => readFileSync(join(dir, `scene-${i + 1}.ppm`)).length);
    assert.equal(sceneRaws.length, 6);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});