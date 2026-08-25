// signal-render — stateless video worker.
// Uploads via signed-URL PUTs; reports status back through the authenticated
// signal-video-complete edge function. Never talks to Supabase directly and
// never holds the service role key.
//
// Env:
//   RENDER_TOKEN   (required) — shared secret, used as bearer for status callbacks
//                               and to authenticate inbound /render-video requests.
//   SUPABASE_URL   (required) — used to build the status callback endpoint.
//   PORT           (default 8080)

import express from "express";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ffmpeg/ffprobe resolution: prefer the bundled static binaries so the worker
// renders under any Railway builder (Nixpacks/Railpack images ship no ffmpeg);
// fall back to PATH for the Dockerfile build.
let FFMPEG = "ffmpeg";
let FFPROBE = "ffprobe";
try {
  const { default: p } = await import("ffmpeg-static");
  if (p) FFMPEG = p;
} catch {}
try {
  const { default: p } = await import("ffprobe-static");
  if (p?.path) FFPROBE = p.path;
} catch {}

const app = express();
app.use(express.json({ limit: "5mb" }));

const RENDER_TOKEN = process.env.RENDER_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const PORT = Number(process.env.PORT || 8080);
const STATUS_ENDPOINT = SUPABASE_URL
  ? `${SUPABASE_URL.replace(/\/$/, "")}/functions/v1/signal-video-complete`
  : null;

/** @type {Map<string, { status: "queued"|"rendering"|"done"|"failed" }>} */
const jobs = new Map();

function hasFfmpeg() {
  return new Promise((resolve) => {
    const p = spawn(FFMPEG, ["-version"]);
    p.on("error", () => resolve(false));
    p.on("exit", (code) => resolve(code === 0));
  });
}

function ffmpegVersion() {
  return new Promise((resolve) => {
    const p = spawn(FFMPEG, ["-version"]);
    let out = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.on("error", () => resolve("unknown"));
    p.on("exit", () => resolve((out.split("\n")[0] || "unknown").trim()));
  });
}

// ---- Captions (ASS subtitle) helpers ----
function msToAss(ms) {
  const cs = Math.max(0, Math.round(Number(ms) / 10)); // centiseconds
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(c).padStart(2, "0")}`;
}
function assEscape(t) {
  return String(t).replace(/\r?\n/g, " ").replace(/\{/g, "(").replace(/\}/g, ")").trim();
}
// Build a styled ASS caption track from per-scene on_screen_text + timings.
function buildAss(scenes, width, height) {
  const fs = Math.max(28, Math.round(height * 0.05));
  const marginV = Math.round(height * 0.1);
  const header =
    `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,Arial,${fs},&H00FFFFFF,&H00000000,&H96000000,1,0,0,0,100,100,0,0,1,4,1,2,80,80,${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`;
  const dialogue = (scenes || [])
    .filter((s) => s && s.on_screen_text && String(s.on_screen_text).trim())
    .map((s) => `Dialogue: 0,${msToAss(s.start_ms)},${msToAss(s.end_ms)},Cap,,0,0,0,,${assEscape(s.on_screen_text)}`);
  return `${header}\n${dialogue.join("\n")}\n`;
}

function fmtDims(fmt) {
  const f = String(fmt || "").replace("x", ":");
  return f === "9:16" ? [1080, 1920] : f === "16:9" ? [1920, 1080] : [1080, 1080];
}

// One Ken-Burns clip from a still: slow centered zoom, output at target size/fps.
// 1.5x supersample (max zoom is 1.18, so headroom to spare) + ultrafast preset:
// the intermediate clips are re-encoded in the assemble pass, so cheap here is
// free quality-wise and keeps render times sane on a single shared vCPU.
async function kenBurnsClip(img, outPath, durSec, w, h) {
  const frames = Math.max(2, Math.round(durSec * 30));
  const zi = Math.round((w * 1.5) / 2) * 2, hi = Math.round((h * 1.5) / 2) * 2;
  // The still goes in as a SINGLE frame; zoompan's d= then emits exactly
  // `frames` output frames from it. (Looping the input first multiplies the
  // output by d per duplicated input frame — hours of video per clip.)
  const vf =
    `scale=${zi}:${hi}:force_original_aspect_ratio=increase,crop=${zi}:${hi},` +
    `zoompan=z='min(zoom+0.0012,1.18)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${w}x${h}:fps=30,` +
    `setsar=1,format=yuv420p`;
  await runFfmpeg([
    "-y", "-i", img, "-vf", vf, "-frames:v", String(frames),
    "-an", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "20", outPath,
  ]);
}

// ShotCraft's premium still treatment: one deliberate, deterministic camera
// move per shot. It remains inside the existing Railway renderer so storage,
// callbacks, approval, and publishing are unchanged.
async function shotcraftClip(img, outPath, durSec, w, h, motion = "push_in") {
  const frames = Math.max(2, Math.round(durSec * 30));
  const zi = Math.round((w * 1.5) / 2) * 2, hi = Math.round((h * 1.5) / 2) * 2;
  const moves = {
    push_in: "z='min(zoom+0.0015,1.22)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'",
    pull_back: "z='if(eq(on,1),1.22,max(zoom-0.0015,1.0))':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'",
    pan_left: "z='1.12':x='min(iw-iw/zoom,on*1.5)':y='ih/2-(ih/zoom/2)'",
    pan_right: "z='1.12':x='max(0,iw-iw/zoom-on*1.5)':y='ih/2-(ih/zoom/2)'",
    drift_up: "z='1.12':x='iw/2-(iw/zoom/2)':y='max(0,ih-ih/zoom-on*1.2)'",
    drift_down: "z='1.12':x='iw/2-(iw/zoom/2)':y='min(ih-ih/zoom,on*1.2)'",
  };
  const move = moves[motion] || moves.push_in;
  const vf = `scale=${zi}:${hi}:force_original_aspect_ratio=increase,crop=${zi}:${hi},zoompan=${move}:d=${frames}:s=${w}x${h}:fps=30,setsar=1,format=yuv420p`;
  await runFfmpeg(["-y", "-i", img, "-vf", vf, "-frames:v", String(frames), "-an", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "19", outPath]);
}

// One clip from real stock footage: cover-crop to target, 30fps, freeze-pad the
// last frame if the source runs short, hard-cap at the scene duration.
async function stockClip(src, outPath, durSec, w, h) {
  const vf =
    `scale=${w}:${h}:force_original_aspect_ratio=increase:flags=bicubic,crop=${w}:${h},` +
    `fps=30,tpad=stop_mode=clone:stop_duration=${durSec.toFixed(3)},setsar=1,format=yuv420p`;
  await runFfmpeg([
    "-y", "-i", src, "-vf", vf, "-t", durSec.toFixed(3),
    "-an", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "20", outPath,
  ]);
}

// Audio graph shared by both render paths. Voiceover is mixed at full level with
// music ducked underneath (music alone plays near-full); music always fades out
// over the last 1.5s. Returns the label to map, or null for voice-only/none.
function buildAudioGraph(fc, { voiceIdx, musicIdx, total }) {
  const fadeSt = Math.max(0, total - 1.5).toFixed(3);
  if (voiceIdx != null && musicIdx != null) {
    fc.push(`[${voiceIdx}:a]apad[va]`);
    fc.push(`[${musicIdx}:a]volume=0.22,afade=t=out:st=${fadeSt}:d=1.5[ma]`);
    fc.push(`[va][ma]amix=inputs=2:duration=longest:normalize=0[aout]`);
    return "aout";
  }
  if (musicIdx != null) {
    fc.push(`[${musicIdx}:a]volume=0.85,afade=t=out:st=${fadeSt}:d=1.5[aout]`);
    return "aout";
  }
  return null;
}

// Join scene clips with crossfades; optionally brand-logo watermark, burned
// captions, and voiceover/music mux.
async function xfadeAssemble(clips, durs, outPath, w, h, voicePath, musicPath, assPath, logoPath, T, transitions = []) {
  const n = clips.length;
  const args = ["-y"];
  clips.forEach((c) => args.push("-i", c));
  const voiceIdx = voicePath ? n : null;
  if (voicePath) args.push("-i", voicePath);
  const musicIdx = musicPath ? n + (voicePath ? 1 : 0) : null;
  if (musicPath) args.push("-i", musicPath);
  const logoIdx = logoPath ? n + (voicePath ? 1 : 0) + (musicPath ? 1 : 0) : null;
  if (logoPath) args.push("-i", logoPath);

  const fc = [];
  let last = "0:v";
  if (n > 1) {
    let acc = durs[0], prev = "0:v";
    for (let k = 1; k < n; k++) {
      const off = Math.max(0, acc - T);
      const out = `vx${k}`;
      const transition = ["fade", "smoothleft", "smoothright", "circleopen", "fadeblack"].includes(transitions[k - 1]) ? transitions[k - 1] : "fade";
      fc.push(`[${prev}][${k}:v]xfade=transition=${transition}:duration=${T.toFixed(3)}:offset=${off.toFixed(3)}[${out}]`);
      acc = acc + durs[k] - T;
      prev = out;
    }
    last = prev;
  }
  if (logoIdx != null) {
    const lw = Math.round(w * 0.14), m = Math.round(w * 0.04);
    fc.push(`[${logoIdx}:v]scale=${lw}:-1[lg]`);
    fc.push(`[${last}][lg]overlay=x=W-w-${m}:y=${m}:format=auto[vlogo]`);
    last = "vlogo";
  }
  let voutIsLabel = last !== "0:v";
  let vout = last;
  if (assPath) { fc.push(`[${last}]subtitles=${assPath}[vout]`); vout = "vout"; voutIsLabel = true; }

  // Explicit -t instead of -shortest: a voiceover shorter than the video must
  // not truncate it (music/silence covers the tail); longer audio gets cut here.
  const total = durs.reduce((a, b) => a + b, 0) - T * (n - 1);
  const aout = buildAudioGraph(fc, { voiceIdx, musicIdx, total });

  if (fc.length) args.push("-filter_complex", fc.join(";"));
  args.push("-map", voutIsLabel ? `[${vout}]` : vout);
  if (aout) args.push("-map", `[${aout}]`, "-c:a", "aac", "-b:a", "128k");
  else if (voiceIdx != null) args.push("-map", `${voiceIdx}:a`, "-c:a", "aac", "-b:a", "128k");
  args.push("-t", total.toFixed(3));
  args.push("-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-crf", "22", outPath);
  await runFfmpeg(args);
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, args);
    let stderr = "";
    p.stderr.on("data", (d) => (stderr += d.toString()));
    p.on("error", reject);
    p.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-400)}`));
    });
  });
}

function probeDuration(file) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFPROBE, [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=nk=1:nw=1",
      file,
    ]);
    let out = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.on("error", reject);
    p.on("exit", (code) => {
      if (code !== 0) return reject(new Error("ffprobe failed"));
      const n = Number(out.trim());
      if (!Number.isFinite(n)) return reject(new Error("ffprobe non-numeric"));
      resolve(n);
    });
  });
}

function auth(req, res, next) {
  const h = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!RENDER_TOKEN || h !== RENDER_TOKEN) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

function countByStatus(status) {
  let n = 0;
  for (const j of jobs.values()) if (j.status === status) n++;
  return n;
}

async function reportStatus(jobId, projectId, patch) {
  if (!STATUS_ENDPOINT) {
    console.warn(`[job ${jobId}] SUPABASE_URL not set; skipping status report`);
    return;
  }
  try {
    const r = await fetch(STATUS_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RENDER_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ job_id: jobId, project_id: projectId, patch }),
    });
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      console.error(`[job ${jobId}] status ${r.status}: ${text.slice(0, 200)}`);
    }
  } catch (err) {
    console.error(`[job ${jobId}] status callback failed:`, err);
  }
}

function validateVideoPayload(p) {
  if (!p?.job_id || !p?.project_id) return "missing job_id or project_id";
  if (!p?.upload_tokens?.video?.signed_url || !p?.upload_tokens?.video?.token) {
    return "missing upload_tokens.video (signed_url + token)";
  }
  if (!p?.upload_tokens?.thumbnail?.signed_url || !p?.upload_tokens?.thumbnail?.token) {
    return "missing upload_tokens.thumbnail (signed_url + token)";
  }
  if (!Array.isArray(p.scenes) || p.scenes.length !== p.expected_scene_count) {
    return "scene count mismatch";
  }
  if (p.scenes.some((s) => !s?.image_url && !s?.video_url)) return "one or more scenes missing image_url/video_url";
  return null;
}

app.get("/health", async (_req, res) => {
  const ffmpegOk = await hasFfmpeg();
  res.json({
    ok: true,
    static_render: true,
    video_render: Boolean(ffmpegOk && RENDER_TOKEN),
    status_endpoint_configured: Boolean(STATUS_ENDPOINT),
    active_video_jobs: countByStatus("rendering"),
    queued_video_jobs: countByStatus("queued"),
  });
});

// Renders run strictly one at a time — concurrent ffmpeg pipelines on a small
// shared vCPU just starve each other. Duplicate submissions of an in-flight
// job (UI retries) are acknowledged without enqueueing a second render.
let renderChain = Promise.resolve();

app.post("/render-video", auth, (req, res) => {
  const payload = req.body;
  const err = validateVideoPayload(payload);
  if (err) return res.status(400).json({ error: err });

  const existing = jobs.get(payload.job_id);
  if (existing && (existing.status === "queued" || existing.status === "rendering")) {
    return res.status(202).json({ ok: true, accepted: true, job_id: payload.job_id, deduped: true });
  }

  jobs.set(payload.job_id, { status: "queued" });
  res.status(202).json({ ok: true, accepted: true, job_id: payload.job_id });

  renderChain = renderChain
    .catch(() => {})
    .then(() => processVideoJob(payload))
    .catch((err) => {
      console.error(`[job ${payload.job_id}] fatal`, err);
    });
});

async function processVideoJob(p) {
  const { job_id: jobId, project_id: projectId } = p;
  jobs.set(jobId, { status: "rendering" });
  const started = Date.now();
  const dir = await mkdtemp(join(tmpdir(), `sig-${jobId}-`));

  try {
    await reportStatus(jobId, projectId, { status: "rendering", progress: 5, current_step: "downloading_scenes" });

    // 1. Download scenes (sorted by idx). Every scene has a still (used for the
    // thumbnail and as Ken-Burns source/fallback); stock scenes also carry a
    // video_url whose download failure quietly demotes them back to stills.
    const sorted = [...p.scenes].sort((a, b) => a.idx - b.idx);
    const scenePaths = [];
    for (const s of sorted) {
      const r = await fetch(s.image_url);
      if (!r.ok) throw new Error(`scene ${s.idx} download ${r.status}`);
      const file = join(dir, `scene-${s.idx}.jpg`);
      await writeFile(file, Buffer.from(await r.arrayBuffer()));
      let videoFile = null;
      if (s.video_url) {
        try {
          const vr = await fetch(s.video_url);
          if (vr.ok) { videoFile = join(dir, `scene-${s.idx}.mp4`); await writeFile(videoFile, Buffer.from(await vr.arrayBuffer())); }
          else console.warn(`[job ${jobId}] scene ${s.idx} stock video ${vr.status}; using still`);
        } catch (e) { console.warn(`[job ${jobId}] scene ${s.idx} stock fetch failed (${String(e?.message || e)}); using still`); }
      }
      scenePaths.push({ ...s, file, videoFile });
    }

    await reportStatus(jobId, projectId, { progress: 35, current_step: "encoding" });

    // Output dimensions from project format ("9:16" | "1:1" | "16:9",
    // tolerating "9x16"/"16x9"). cover-fit via increase + crop.
    const [width, height] = fmtDims(p.format);
    const durs = scenePaths.map((s) => Math.max(0.6, (s.end_ms - s.start_ms) / 1000));

    // --- shared: voiceover (coordinator TTS) + caption track ---
    // When audio is enabled, fail closed: publishing a silent substitute is worse
    // than surfacing a retryable render error.
    let voicePath = null;
    if (p.voiceover_enabled && !p.voiceover_url) {
      throw new Error("voiceover enabled but voiceover_url is missing");
    }
    if (p.voiceover_url) {
      try {
        const vr = await fetch(p.voiceover_url);
        if (vr.ok) { voicePath = join(dir, "voice.mp3"); await writeFile(voicePath, Buffer.from(await vr.arrayBuffer())); }
        else throw new Error(`voiceover download ${vr.status}`);
      } catch (e) {
        if (p.voiceover_enabled) throw new Error(`required voiceover fetch failed: ${String(e?.message || e)}`);
        console.warn(`[job ${jobId}] optional voiceover fetch failed (${String(e?.message || e)})`);
      }
    }
    let assPath = null;
    if (p.captions_enabled && sorted.some((s) => s.on_screen_text && String(s.on_screen_text).trim())) {
      assPath = join(dir, "captions.ass");
      await writeFile(assPath, buildAss(sorted, width, height));
    }
    let musicPath = null;
    if (p.music_enabled !== false && !p.music_url) {
      throw new Error("music enabled but music_url is missing");
    }
    if (p.music_enabled !== false && p.music_url) {
      try {
        const mr = await fetch(p.music_url);
        if (mr.ok) { musicPath = join(dir, "music.mp3"); await writeFile(musicPath, Buffer.from(await mr.arrayBuffer())); }
        else throw new Error(`music download ${mr.status}`);
      } catch (e) {
        throw new Error(`required music fetch failed: ${String(e?.message || e)}`);
      }
    }
    // Brand logo watermark (best-effort; PNG alpha honored by overlay).
    let logoPath = null;
    if (p.brand?.logo_url) {
      try {
        const lr = await fetch(p.brand.logo_url);
        if (lr.ok) {
          const ct = String(lr.headers.get("content-type") || "");
          logoPath = join(dir, ct.includes("png") ? "logo.png" : "logo.img");
          await writeFile(logoPath, Buffer.from(await lr.arrayBuffer()));
        } else console.warn(`[job ${jobId}] logo download ${lr.status}; no watermark`);
      } catch (e) { console.warn(`[job ${jobId}] logo fetch failed (${String(e?.message || e)}); no watermark`); }
    }

    const outPath = join(dir, "out.mp4");
    const coverVf = `scale=${width}:${height}:force_original_aspect_ratio=increase:flags=bicubic,crop=${width}:${height},setsar=1`;

    // Fallback: the reliable timed slideshow (no motion), captions + audio muxed.
    async function renderSimple() {
      const listFile = join(dir, "concat.txt");
      const lines = [];
      for (const s of scenePaths) { lines.push(`file '${s.file}'`); lines.push(`duration ${(Math.max(0.6, (s.end_ms - s.start_ms) / 1000)).toFixed(3)}`); }
      lines.push(`file '${scenePaths[scenePaths.length - 1].file}'`);
      await writeFile(listFile, lines.join("\n") + "\n");
      const a = ["-y", "-f", "concat", "-safe", "0", "-i", listFile];
      const voiceIdx = voicePath ? 1 : null;
      if (voicePath) a.push("-i", voicePath);
      const musicIdx = musicPath ? 1 + (voicePath ? 1 : 0) : null;
      if (musicPath) a.push("-i", musicPath);
      const logoIdx = logoPath ? 1 + (voicePath ? 1 : 0) + (musicPath ? 1 : 0) : null;
      if (logoPath) a.push("-i", logoPath);
      const total = durs.reduce((x, y) => x + y, 0);
      const fc = [`[0:v]${coverVf},fps=30[vbase]`];
      let lastV = "vbase";
      if (logoIdx != null) {
        const lw = Math.round(width * 0.14), m = Math.round(width * 0.04);
        fc.push(`[${logoIdx}:v]scale=${lw}:-1[lg]`, `[${lastV}][lg]overlay=x=W-w-${m}:y=${m}:format=auto[vlogo]`);
        lastV = "vlogo";
      }
      if (assPath) { fc.push(`[${lastV}]subtitles=${assPath}[vout]`); lastV = "vout"; }
      else { fc.push(`[${lastV}]null[vout]`); lastV = "vout"; }
      const aout = buildAudioGraph(fc, { voiceIdx, musicIdx, total });
      a.push("-filter_complex", fc.join(";"), "-map", "[vout]");
      if (aout) a.push("-map", `[${aout}]`, "-c:a", "aac", "-b:a", "128k");
      else if (voiceIdx != null) a.push("-map", `${voiceIdx}:a`, "-c:a", "aac", "-b:a", "128k");
      a.push("-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-crf", "22");
      a.push("-t", total.toFixed(3));
      a.push(outPath);
      await runFfmpeg(a);
    }

    // Cinematic: per-scene Ken-Burns clips joined with crossfades. Falls back to
    // the simple path on any ffmpeg error so a render never fails outright.
    const requestedShotcraft = p.render_style === "shotcraft";
    let renderStyle = requestedShotcraft ? "shotcraft" : "cinematic";
    try {
      // Each crossfade overlaps adjacent clips by T, shortening the timeline by
      // T*(n-1). Pad every clip except the last by T so the assembled video runs
      // exactly the scene-sum duration — and each transition then starts exactly
      // at the original scene boundary, keeping the ASS captions in sync.
      const T = Math.min(0.6, Math.min(...durs) * 0.4); // transition < shortest clip
      const clipDurs = durs.map((d, i) => (i < durs.length - 1 ? d + T : d));
      const clips = [];
      for (let i = 0; i < scenePaths.length; i++) {
        const cp = join(dir, `clip-${i}.mp4`);
        if (scenePaths[i].videoFile) {
          try {
            await stockClip(scenePaths[i].videoFile, cp, clipDurs[i], width, height);
          } catch (e) {
            console.warn(`[job ${jobId}] scene ${scenePaths[i].idx} stock clip failed (${String(e?.message || e).slice(0, 120)}); Ken Burns fallback`);
            if (requestedShotcraft) await shotcraftClip(scenePaths[i].file, cp, clipDurs[i], width, height, scenes[i]?.shotcraft_motion);
            else await kenBurnsClip(scenePaths[i].file, cp, clipDurs[i], width, height);
          }
        } else {
          if (requestedShotcraft) await shotcraftClip(scenePaths[i].file, cp, clipDurs[i], width, height, scenes[i]?.shotcraft_motion);
          else await kenBurnsClip(scenePaths[i].file, cp, clipDurs[i], width, height);
        }
        clips.push(cp);
      }
      const transitions = requestedShotcraft ? scenes.map((s) => s.shotcraft_transition) : [];
      await xfadeAssemble(clips, clipDurs, outPath, width, height, voicePath, musicPath, assPath, logoPath, T, transitions);
    } catch (err) {
      console.warn(`[job ${jobId}] cinematic render failed (${String(err?.message || err).slice(0, 200)}); falling back to slideshow`);
      renderStyle = "slideshow_fallback";
      await renderSimple();
    }
    console.log(`[job ${jobId}] render style: ${renderStyle}`);

    // 4. Thumbnail from first scene
    const thumbPath = join(dir, "thumb.jpg");
    await runFfmpeg([
      "-y",
      "-i", scenePaths[0].file,
      "-vf", coverVf,
      "-q:v", "3",
      thumbPath,
    ]);

    await reportStatus(jobId, projectId, { progress: 80, current_step: "uploading" });

    // 5. Upload via signed PUTs
    const [videoBytes, thumbBytes] = await Promise.all([
      readFile(outPath),
      readFile(thumbPath),
    ]);
    await putSigned(
      p.upload_tokens.video.signed_url,
      videoBytes,
      p.upload_tokens.video.content_type || "video/mp4",
    );
    await putSigned(
      p.upload_tokens.thumbnail.signed_url,
      thumbBytes,
      p.upload_tokens.thumbnail.content_type || "image/jpeg",
    );

    // 6. Probe + terminal callback
    const [stV, stT, durationSec, version] = await Promise.all([
      stat(outPath),
      stat(thumbPath),
      probeDuration(outPath),
      ffmpegVersion(),
    ]);

    await reportStatus(jobId, projectId, {
      status: "rendered",
      render_ms: Date.now() - started,
      render_source: "railway",
      duration_sec: durationSec,
      file_size_bytes: stV.size,
      output: {
        path: p.upload_tokens.video.path || p.output_path,
        size_bytes: stV.size,
        duration_sec: durationSec,
        content_type: "video/mp4",
      },
      thumbnail: {
        path: p.upload_tokens.thumbnail.path || p.thumbnail_path,
        size_bytes: stT.size,
        content_type: "image/jpeg",
      },
      has_audio: Boolean(voicePath || musicPath),
      worker_meta: {
        ffmpeg_version: version,
        has_audio: Boolean(voicePath || musicPath),
        voiceover_included: Boolean(voicePath),
        music_included: Boolean(musicPath),
        render_style: renderStyle,
        shotcraft_version: requestedShotcraft ? "video-shotcraft-v1" : null,
      },
    });

    jobs.set(jobId, { status: "done" });
  } catch (err) {
    const message = String(err?.message || err).slice(0, 500);
    console.error(`[job ${jobId}] failed:`, message);
    await reportStatus(jobId, projectId, {
      status: "failed",
      error_reason: message,
      error: { code: "worker_error", message },
    });
    jobs.set(jobId, { status: "failed" });
  } finally {
    rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function putSigned(url, bytes, contentType) {
  const r = await fetch(url, {
    method: "PUT",
    headers: { "x-upsert": "true", "Content-Type": contentType },
    body: bytes,
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`upload ${r.status}: ${body.slice(0, 200)}`);
  }
}

app.listen(PORT, () => {
  console.log(`signal-render worker listening on :${PORT} (status endpoint: ${STATUS_ENDPOINT || "unset"})`);
});
