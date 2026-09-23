const MOTION_ALIASES = new Map([
  ["push", "push_in"],
  ["push_in", "push_in"],
  ["push-in", "push_in"],
  ["zoom_in", "push_in"],
  ["zoom-in", "push_in"],
  ["dolly_in", "push_in"],
  ["dolly-in", "push_in"],
  ["pull", "pull_out"],
  ["pull_out", "pull_out"],
  ["pull-out", "pull_out"],
  ["zoom_out", "pull_out"],
  ["zoom-out", "pull_out"],
  ["dolly_out", "pull_out"],
  ["dolly-out", "pull_out"],
  ["pan_left", "pan_left"],
  ["pan-left", "pan_left"],
  ["left", "pan_left"],
  ["pan_right", "pan_right"],
  ["pan-right", "pan_right"],
  ["right", "pan_right"],
  ["drift_up", "drift_up"],
  ["drift-up", "drift_up"],
  ["up", "drift_up"],
  ["drift_down", "drift_down"],
  ["drift-down", "drift_down"],
  ["down", "drift_down"],
  ["diagonal", "diagonal_up"],
  ["diagonal_up", "diagonal_up"],
  ["diagonal-up", "diagonal_up"],
  ["diagonal_down", "diagonal_down"],
  ["diagonal-down", "diagonal_down"],
  ["hold", "hold"],
  ["static", "hold"],
  ["locked", "hold"],
  ["none", "hold"],
]);

const TRANSITION_ALIASES = new Map([
  ["fade", "fade"],
  ["crossfade", "fade"],
  ["cross_fade", "fade"],
  ["dissolve", "fade"],
  ["cut", "cut"],
  ["hard_cut", "cut"],
  ["hard-cut", "cut"],
  ["reveal_left", "wipeleft"],
  ["reveal-left", "wipeleft"],
  ["slide_left", "wipeleft"],
  ["slide-left", "wipeleft"],
  ["wipe_left", "wipeleft"],
  ["wipe-left", "wipeleft"],
  ["wipeleft", "wipeleft"],
  ["reveal_right", "wiperight"],
  ["reveal-right", "wiperight"],
  ["slide_right", "wiperight"],
  ["slide-right", "wiperight"],
  ["wipe_right", "wiperight"],
  ["wipe-right", "wiperight"],
  ["wiperight", "wiperight"],
  ["reveal_up", "wipeup"],
  ["reveal-up", "wipeup"],
  ["wipe_up", "wipeup"],
  ["wipe-up", "wipeup"],
  ["wipeup", "wipeup"],
  ["reveal_down", "wipedown"],
  ["reveal-down", "wipedown"],
  ["wipe_down", "wipedown"],
  ["wipe-down", "wipedown"],
  ["wipedown", "wipedown"],
]);

const FALLBACK_MOTIONS = ["push_in", "pan_right", "pull_out", "pan_left", "drift_up", "drift_down"];
const END_CARD_TEXT = /(?:logo|end\s*card|endcard|sign[-\s]*off|cta|website|brand)$/i;

function normalizedKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .slice(0, 80);
}

export function normalizeMotionIntent(value) {
  const key = normalizedKey(value);
  return MOTION_ALIASES.get(key) || null;
}

export function normalizeTransitionIntent(value) {
  const key = normalizedKey(value);
  return TRANSITION_ALIASES.get(key) || null;
}

function stableHash(value) {
  let h = 2166136261;
  for (const ch of String(value || "")) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

export function isLogoOrEndCard(scene) {
  if (!scene || typeof scene !== "object") return false;
  if (scene.endcard === true) return true;
  const media = normalizedKey(scene.media || scene.scene_type || scene.kind);
  if (media === "logo_endcard" || media === "endcard" || media === "logo") return true;
  return END_CARD_TEXT.test(`${scene.on_screen_text || ""} ${scene.visual_prompt || ""}`);
}

export function selectMotionTreatment(scene, index = 0, previousTreatment = null) {
  if (isLogoOrEndCard(scene)) {
    return { treatment: "hold", source: "endcard" };
  }

  const explicit = normalizeMotionIntent(
    scene?.motion ?? scene?.motion_intent ?? scene?.still_motion ?? scene?.camera_motion,
  );
  if (explicit) return { treatment: explicit, source: "explicit" };

  const seedText = `${scene?.idx ?? index}|${scene?.on_screen_text || ""}|${scene?.visual_prompt || ""}`;
  let treatment = FALLBACK_MOTIONS[(stableHash(seedText) + index) % FALLBACK_MOTIONS.length];
  if (treatment === previousTreatment) {
    treatment = FALLBACK_MOTIONS[(FALLBACK_MOTIONS.indexOf(treatment) + 1) % FALLBACK_MOTIONS.length];
  }
  return { treatment, source: "fallback" };
}

export function planMotionTreatments(scenes) {
  const out = [];
  let previous = null;
  for (let i = 0; i < scenes.length; i++) {
    const picked = selectMotionTreatment(scenes[i], i, previous);
    previous = picked.treatment;
    out.push({ idx: scenes[i]?.idx ?? i + 1, ...picked });
  }
  return out;
}

export function selectTransitionIntent(fromScene, toScene, index = 0) {
  const explicit = normalizeTransitionIntent(
    fromScene?.transition_out ?? fromScene?.transition ?? fromScene?.scene_transition,
  );
  if (explicit) return { transition: explicit, source: "explicit" };
  if (isLogoOrEndCard(toScene)) return { transition: "fade", source: "endcard" };
  if (index > 0 && index % 3 === 0) return { transition: "cut", source: "fallback" };
  return { transition: "fade", source: "fallback" };
}

export function planTransitions(scenes) {
  const out = [];
  for (let i = 0; i < scenes.length - 1; i++) {
    out.push({ idx: scenes[i]?.idx ?? i + 1, ...selectTransitionIntent(scenes[i], scenes[i + 1], i) });
  }
  return out;
}

function centerExpr(axis) {
  return axis === "x" ? "iw/2-(iw/zoom/2)" : "ih/2-(ih/zoom/2)";
}

export function buildStillMotionFilter(treatment, durSec, w, h) {
  const frames = Math.max(2, Math.round(Number(durSec) * 30));
  const den = Math.max(1, frames - 1);
  const zi = Math.round((w * 1.5) / 2) * 2;
  const hi = Math.round((h * 1.5) / 2) * 2;
  const safe = normalizeMotionIntent(treatment) || "push_in";

  let z = "min(1.10,1+0.10*on/" + den + ")";
  let x = centerExpr("x");
  let y = centerExpr("y");

  if (safe === "pull_out") z = "max(1.00,1.10-0.10*on/" + den + ")";
  if (safe === "hold") z = "1.02";
  if (safe === "pan_left" || safe === "pan_right" || safe === "drift_up" || safe === "drift_down" || safe.startsWith("diagonal")) {
    z = "1.10";
  }
  if (safe === "pan_left") x = "(iw-iw/zoom)*(0.70-0.40*on/" + den + ")";
  if (safe === "pan_right") x = "(iw-iw/zoom)*(0.30+0.40*on/" + den + ")";
  if (safe === "drift_up") y = "(ih-ih/zoom)*(0.70-0.40*on/" + den + ")";
  if (safe === "drift_down") y = "(ih-ih/zoom)*(0.30+0.40*on/" + den + ")";
  if (safe === "diagonal_up") {
    x = "(iw-iw/zoom)*(0.30+0.28*on/" + den + ")";
    y = "(ih-ih/zoom)*(0.70-0.28*on/" + den + ")";
  }
  if (safe === "diagonal_down") {
    x = "(iw-iw/zoom)*(0.70-0.28*on/" + den + ")";
    y = "(ih-ih/zoom)*(0.30+0.28*on/" + den + ")";
  }

  return {
    frames,
    filter:
      `scale=${zi}:${hi}:force_original_aspect_ratio=increase,crop=${zi}:${hi},` +
      `zoompan=z='${z}':x='${x}':y='${y}':d=${frames}:s=${w}x${h}:fps=30,` +
      "setsar=1,format=yuv420p",
  };
}

export function transitionDuration(transition, baseDuration) {
  const safe = normalizeTransitionIntent(transition) || "fade";
  if (safe === "cut") return 0;
  return Math.min(0.6, Math.max(0.18, Number(baseDuration) * 0.4));
}
