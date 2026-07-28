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
    const p = spawn("ffmpeg", ["-version"]);
    p.on("error", () => resolve(false));
    p.on("exit", (code) => resolve(code === 0));
  });
}

function ffmpegVersion() {
  return new Promise((resolve) => {
    const p = spawn("ffmpeg", ["-version"]);
    let out = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.on("error", () => resolve("unknown"));
    p.on("exit", () => resolve((out.split("\n")[0] || "unknown").trim()));
  });
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", args);
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
    const p = spawn("ffprobe", [
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

app.post("/render-video", auth, (req, res) => {
  const payload = req.body;
  const err = validateVideoPayload(payload);
  if (err) return res.status(400).json({ error: err });

  jobs.set(payload.job_id, { status: "queued" });
  res.status(202).json({ ok: true, accepted: true, job_id: payload.job_id });

  processVideoJob(payload).catch((err) => {
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

    // 2. Concat script — ffmpeg concat demuxer quirk: repeat LAST file with no duration
    const listFile = join(dir, "concat.txt");
    const lines = [];
    for (const s of scenePaths) {
      const dur = Math.max(0.5, (s.end_ms - s.start_ms) / 1000);
      lines.push(`file '${s.file}'`);
      lines.push(`duration ${dur.toFixed(3)}`);
    }
    lines.push(`file '${scenePaths[scenePaths.length - 1].file}'`);
    await writeFile(listFile, lines.join("\n") + "\n");

    // 3. Render
    const size =
      p.format === "9x16" ? "1080x1920" :
      p.format === "16x9" ? "1920x1080" :
      "1080x1080";

    const outPath = join(dir, "out.mp4");
    await runFfmpeg([
      "-y",
      "-f", "concat", "-safe", "0",
      "-i", listFile,
      "-vf", `scale=${size}:force_original_aspect_ratio=cover,setsar=1,fps=30`,
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-preset", "veryfast",
      "-crf", "22",
      outPath,
    ]);

    // 4. Thumbnail from first scene
    const thumbPath = join(dir, "thumb.jpg");
    await runFfmpeg([
      "-y",
      "-i", scenePaths[0].file,
      "-vf", `scale=${size}:force_original_aspect_ratio=cover,setsar=1`,
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
