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
  const vf =
    `scale=${zi}:${hi}:force_original_aspect_ratio=increase,crop=${zi}:${hi},` +
    `zoompan=z='min(zoom+0.0012,1.18)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${w}x${h}:fps=30,` +
    `setsar=1,format=yuv420p`;
  await runFfmpeg([
    "-y", "-loop", "1", "-t", durSec.toFixed(3), "-i", img, "-vf", vf,
    "-r", "30", "-an", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "20", outPath,
  ]);
}

// Join Ken-Burns clips with crossfades; optionally burn captions + mux voiceover.
async function xfadeAssemble(clips, durs, outPath, w, h, voicePath, assPath, T) {
  const n = clips.length;
  const args = ["-y"];
  clips.forEach((c) => args.push("-i", c));
  if (voicePath) args.push("-i", voicePath);

  const fc = [];
  let last = "0:v";
  if (n > 1) {
    let acc = durs[0], prev = "0:v";
    for (let k = 1; k < n; k++) {
      const off = Math.max(0, acc - T);
      const out = `vx${k}`;
      fc.push(`[${prev}][${k}:v]xfade=transition=fade:duration=${T.toFixed(3)}:offset=${off.toFixed(3)}[${out}]`);
      acc = acc + durs[k] - T;
      prev = out;
    }
    last = prev;
  }
  let voutIsLabel = last !== "0:v";
  let vout = last;
  if (assPath) { fc.push(`[${last}]subtitles=${assPath}[vout]`); vout = "vout"; voutIsLabel = true; }

  if (fc.length) args.push("-filter_complex", fc.join(";"));
  args.push("-map", voutIsLabel ? `[${vout}]` : vout);
  if (voicePath) args.push("-map", `${n}:a`, "-c:a", "aac", "-b:a", "128k", "-shortest");
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
  if (p.scenes.some((s) => !s?.image_url)) return "one or more scenes missing image_url";
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

    // 1. Download scenes (sorted by idx)
    const sorted = [...p.scenes].sort((a, b) => a.idx - b.idx);
    const scenePaths = [];
    for (const s of sorted) {
      const r = await fetch(s.image_url);
      if (!r.ok) throw new Error(`scene ${s.idx} download ${r.status}`);
      const file = join(dir, `scene-${s.idx}.jpg`);
      await writeFile(file, Buffer.from(await r.arrayBuffer()));
      scenePaths.push({ ...s, file });
    }

    await reportStatus(jobId, projectId, { progress: 35, current_step: "encoding" });

    // Output dimensions from project format ("9:16" | "1:1" | "16:9",
    // tolerating "9x16"/"16x9"). cover-fit via increase + crop.
    const [width, height] = fmtDims(p.format);
    const durs = scenePaths.map((s) => Math.max(0.6, (s.end_ms - s.start_ms) / 1000));

    // --- shared: optional voiceover (coordinator TTS) + caption track ---
    let voicePath = null;
    if (p.voiceover_url) {
      try {
        const vr = await fetch(p.voiceover_url);
        if (vr.ok) { voicePath = join(dir, "voice.mp3"); await writeFile(voicePath, Buffer.from(await vr.arrayBuffer())); }
        else console.warn(`[job ${jobId}] voiceover download ${vr.status}; silent`);
      } catch (e) { console.warn(`[job ${jobId}] voiceover fetch failed (${String(e?.message || e)}); silent`); }
    }
    let assPath = null;
    if (p.captions_enabled && sorted.some((s) => s.on_screen_text && String(s.on_screen_text).trim())) {
      assPath = join(dir, "captions.ass");
      await writeFile(assPath, buildAss(sorted, width, height));
    }

    const outPath = join(dir, "out.mp4");
    const coverVf = `scale=${width}:${height}:force_original_aspect_ratio=increase:flags=bicubic,crop=${width}:${height},setsar=1`;

    // Fallback: the reliable timed slideshow (no motion), captions + voice muxed.
    async function renderSimple() {
      const listFile = join(dir, "concat.txt");
      const lines = [];
      for (const s of scenePaths) { lines.push(`file '${s.file}'`); lines.push(`duration ${(Math.max(0.6, (s.end_ms - s.start_ms) / 1000)).toFixed(3)}`); }
      lines.push(`file '${scenePaths[scenePaths.length - 1].file}'`);
      await writeFile(listFile, lines.join("\n") + "\n");
      let vf = `${coverVf},fps=30`;
      if (assPath) vf += `,subtitles=${assPath}`;
      const a = ["-y", "-f", "concat", "-safe", "0", "-i", listFile];
      if (voicePath) a.push("-i", voicePath);
      a.push("-vf", vf, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-crf", "22");
      if (voicePath) a.push("-map", "0:v:0", "-map", "1:a:0", "-c:a", "aac", "-b:a", "128k", "-shortest");
      a.push(outPath);
      await runFfmpeg(a);
    }

    // Cinematic: per-scene Ken-Burns clips joined with crossfades. Falls back to
    // the simple path on any ffmpeg error so a render never fails outright.
    let renderStyle = "cinematic";
    try {
      const clips = [];
      for (let i = 0; i < scenePaths.length; i++) {
        const cp = join(dir, `clip-${i}.mp4`);
        await kenBurnsClip(scenePaths[i].file, cp, durs[i], width, height);
        clips.push(cp);
      }
      const T = Math.min(0.6, Math.min(...durs) * 0.4); // transition < shortest clip
      await xfadeAssemble(clips, durs, outPath, width, height, voicePath, assPath, T);
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
      worker_meta: { ffmpeg_version: version },
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
