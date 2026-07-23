// Signal Render Service
// - POST /render: HTML template -> branded PNG/JPEG
// - POST /render-video: Onixus scene job -> MP4 + thumbnail in Supabase Storage

import express from "express";
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import ffmpegPath from "ffmpeg-static";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import { promises as fsp } from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = path.join(__dirname, "templates");
const PORT = Number(process.env.PORT || 8080);
const RENDER_TOKEN = process.env.RENDER_TOKEN || "";
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const MAX_VIDEO_CONCURRENCY = Math.max(1, Number(process.env.MAX_VIDEO_CONCURRENCY || 1));

const supabase = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  : null;

const app = express();
app.use(express.json({ limit: "5mb" }));

function isAuthorized(req) {
  if (!RENDER_TOKEN) return false;
  return (req.headers.authorization || "") === `Bearer ${RENDER_TOKEN}`;
}

function requireAuth(req, res, next) {
  if (!isAuthorized(req)) return res.status(401).json({ error: "unauthorized" });
  next();
}

let browserPromise = null;
async function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
      ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    });
  }
  return browserPromise;
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    static_render: true,
    video_render: Boolean(ffmpegPath && supabase && RENDER_TOKEN),
    active_video_jobs: activeVideoJobs,
    queued_video_jobs: videoQueue.length,
  });
});

app.get("/templates", (_req, res) => {
  try {
    const names = fs
      .readdirSync(TEMPLATES_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    res.json({ templates: names });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

app.post("/render", requireAuth, async (req, res) => {
  const {
    template = "master",
    width = 1080,
    height = 1080,
    format = "png",
    params = {},
  } = req.body || {};

  const safeName = String(template).replace(/[^a-zA-Z0-9_-]/g, "");
  const templateFile = path.join(TEMPLATES_DIR, safeName, "index.html");
  if (!fs.existsSync(templateFile)) {
    return res.status(404).json({ error: `template not found: ${safeName}` });
  }

  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) qs.set(key, String(value));
  }
  const fileUrl = `${pathToFileURL(templateFile).href}?${qs.toString()}`;

  let page;
  try {
    const browser = await getBrowser();
    page = await browser.newPage({
      viewport: { width: Number(width), height: Number(height) },
      deviceScaleFactor: 2,
    });
    await page.goto(fileUrl, { waitUntil: "domcontentloaded", timeout: 15000 });

    try {
      await page.waitForFunction(() => document.body.dataset.ready === "1", { timeout: 12000 });
    } catch {
      return res.status(504).json({
        error: "render timed out waiting for assets (logo/font may be unreachable)",
      });
    }

    const imgStatus = await page.evaluate(() => {
      try { return JSON.parse(document.body.dataset.imgStatus || "{}"); }
      catch { return {}; }
    });

    const failed = Object.entries(imgStatus)
      .filter(([, value]) => value === "fail")
      .map(([key]) => key);
    const strict = req.body.strictLogos !== false;
    if (strict && failed.length) {
      return res.status(422).json({
        error: "image(s) failed to load",
        failed,
        imgStatus,
        hint: "check the signed URL(s); post was NOT rendered to avoid a broken image",
      });
    }

    await page.waitForTimeout(150);
    const el = (await page.$(".canvas")) || page;
    const buffer = await el.screenshot({
      type: format === "jpeg" ? "jpeg" : "png",
      ...(format === "jpeg" ? { quality: 92 } : {}),
    });

    res.set("Content-Type", format === "jpeg" ? "image/jpeg" : "image/png");
    res.set("Cache-Control", "no-store");
    res.set("X-Img-Status", JSON.stringify(imgStatus));
    res.send(buffer);
  } catch (error) {
    console.error("[render] error:", error);
    res.status(500).json({ error: error?.message || String(error) });
  } finally {
    if (page) await page.close().catch(() => {});
  }
});

const videoQueue = [];
let activeVideoJobs = 0;

app.post("/render-video", requireAuth, async (req, res) => {
  if (!supabase) {
    return res.status(503).json({
      error: "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured",
    });
  }
  if (!ffmpegPath) {
    return res.status(503).json({ error: "ffmpeg unavailable" });
  }

  const validationError = validateVideoPayload(req.body);
  if (validationError) return res.status(400).json({ error: validationError });

  const payload = structuredClone(req.body);
  videoQueue.push(payload);
  void drainVideoQueue();

  return res.status(202).json({
    ok: true,
    accepted: true,
    job_id: payload.job_id,
    queue_position: videoQueue.length,
  });
});

function validateVideoPayload(payload) {
  if (!payload || typeof payload !== "object") return "invalid payload";
  if (!payload.job_id || !payload.project_id || !payload.client_id) {
    return "job_id, project_id, and client_id are required";
  }
  if (!Array.isArray(payload.scenes) || payload.scenes.length === 0) {
    return "at least one scene is required";
  }
  if (payload.scenes.some((scene) => !scene.image_url)) {
    return "every scene requires image_url";
  }
  if (!payload.output_path || !payload.thumbnail_path || !payload.storage_bucket) {
    return "output_path, thumbnail_path, and storage_bucket are required";
  }
  return null;
}

async function drainVideoQueue() {
  while (activeVideoJobs < MAX_VIDEO_CONCURRENCY && videoQueue.length > 0) {
    const payload = videoQueue.shift();
    activeVideoJobs += 1;
    processVideoJob(payload)
      .catch((error) => console.error(`[render-video:${payload.job_id}]`, error))
      .finally(() => {
        activeVideoJobs -= 1;
        void drainVideoQueue();
      });
  }
}

async function processVideoJob(payload) {
  const { job_id: jobId, project_id: projectId } = payload;
  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), `signal-${safeId(jobId)}-`));

  try {
    await updateJob(jobId, {
      status: "rendering",
      progress: 5,
      current_step: "downloading_assets",
      error_reason: null,
    });

    const orderedScenes = [...payload.scenes].sort((a, b) => Number(a.idx) - Number(b.idx));
    const localScenes = [];
    for (let index = 0; index < orderedScenes.length; index += 1) {
      const scene = orderedScenes[index];
      const extension = imageExtension(scene.image_url);
      const destination = path.join(workDir, `scene-${String(index).padStart(3, "0")}.${extension}`);
      await downloadFile(scene.image_url, destination);
      localScenes.push({
        path: destination,
        duration: Math.max(0.5, (Number(scene.end_ms) - Number(scene.start_ms)) / 1000 || 3),
      });
      await updateJob(jobId, {
        progress: Math.min(35, 5 + Math.round(((index + 1) / orderedScenes.length) * 30)),
      });
    }

    const concatPath = path.join(workDir, "scenes.txt");
    const concatLines = [];
    for (const scene of localScenes) {
      concatLines.push(`file '${escapeConcatPath(scene.path)}'`);
      concatLines.push(`duration ${scene.duration.toFixed(3)}`);
    }
    concatLines.push(`file '${escapeConcatPath(localScenes.at(-1).path)}'`);
    await fsp.writeFile(concatPath, `${concatLines.join("\n")}\n`, "utf8");

    const { width, height } = dimensionsForFormat(payload.format);
    const outputPath = path.join(workDir, "output.mp4");
    const thumbnailPath = path.join(workDir, "thumbnail.jpg");
    const videoFilter = [
      `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`,
      "setsar=1",
      "format=yuv420p",
    ].join(",");

    await updateJob(jobId, {
      progress: 40,
      current_step: "encoding_video",
    });

    await runFfmpeg([
      "-y",
      "-f", "concat",
      "-safe", "0",
      "-i", concatPath,
      "-vf", videoFilter,
      "-r", "30",
      "-c:v", "libx264",
      "-preset", process.env.FFMPEG_PRESET || "veryfast",
      "-crf", process.env.FFMPEG_CRF || "21",
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      outputPath,
    ]);

    await updateJob(jobId, {
      progress: 78,
      current_step: "creating_thumbnail",
    });

    await runFfmpeg([
      "-y",
      "-ss", "0.2",
      "-i", outputPath,
      "-frames:v", "1",
      "-q:v", "2",
      thumbnailPath,
    ]);

    await updateJob(jobId, {
      progress: 85,
      current_step: "uploading_outputs",
    });

    const [videoBuffer, thumbnailBuffer] = await Promise.all([
      fsp.readFile(outputPath),
      fsp.readFile(thumbnailPath),
    ]);

    const bucket = supabase.storage.from(payload.storage_bucket);
    const { error: videoUploadError } = await bucket.upload(payload.output_path, videoBuffer, {
      contentType: "video/mp4",
      upsert: true,
      cacheControl: "3600",
    });
    if (videoUploadError) throw new Error(`video upload failed: ${videoUploadError.message}`);

    const { error: thumbnailUploadError } = await bucket.upload(payload.thumbnail_path, thumbnailBuffer, {
      contentType: "image/jpeg",
      upsert: true,
      cacheControl: "3600",
    });
    if (thumbnailUploadError) throw new Error(`thumbnail upload failed: ${thumbnailUploadError.message}`);

    const [{ data: videoSigned }, { data: thumbnailSigned }] = await Promise.all([
      bucket.createSignedUrl(payload.output_path, 60 * 60 * 24 * 30),
      bucket.createSignedUrl(payload.thumbnail_path, 60 * 60 * 24 * 30),
    ]);

    const stats = await fsp.stat(outputPath);
    const durationSec = localScenes.reduce((sum, scene) => sum + scene.duration, 0);

    await updateJob(jobId, {
      status: "rendered",
      progress: 100,
      current_step: "complete",
      output_path: payload.output_path,
      output_url: videoSigned?.signedUrl || null,
      thumbnail_url: thumbnailSigned?.signedUrl || null,
      duration_sec: Math.round(durationSec * 1000) / 1000,
      file_size_bytes: stats.size,
      error_reason: null,
      worker_meta: {
        completed_at: new Date().toISOString(),
        renderer: "railway-ffmpeg",
        scene_count: localScenes.length,
        dimensions: `${width}x${height}`,
      },
    });

    const { error: projectUpdateError } = await supabase
      .from("signal_video_projects")
      .update({ status: "rendered", error_reason: null })
      .eq("id", projectId);
    if (projectUpdateError) throw new Error(`project update failed: ${projectUpdateError.message}`);
  } catch (error) {
    const reason = error?.message || String(error);
    await updateJob(jobId, {
      status: "failed",
      current_step: "worker_failed",
      error_reason: reason.slice(0, 1000),
    }).catch(() => {});
    await supabase
      .from("signal_video_projects")
      .update({ status: "failed", error_reason: reason.slice(0, 1000) })
      .eq("id", projectId)
      .catch(() => {});
    throw error;
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function updateJob(jobId, patch) {
  const { error } = await supabase
    .from("signal_video_render_jobs")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", jobId);
  if (error) throw new Error(`job update failed: ${error.message}`);
}

async function downloadFile(url, destination) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`asset download failed (${response.status})`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length === 0) throw new Error("asset download returned an empty file");
  await fsp.writeFile(destination, buffer);
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 12000) stderr = stderr.slice(-12000);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-2000)}`));
    });
  });
}

function dimensionsForFormat(format) {
  if (format === "16:9") return { width: 1920, height: 1080 };
  if (format === "1:1") return { width: 1080, height: 1080 };
  return { width: 1080, height: 1920 };
}

function imageExtension(url) {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    if (pathname.endsWith(".png")) return "png";
    if (pathname.endsWith(".webp")) return "webp";
  } catch {}
  return "jpg";
}

function escapeConcatPath(value) {
  return value.replaceAll("'", "'\\''");
}

function safeId(value) {
  return String(value || crypto.randomUUID()).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
}

const server = app.listen(PORT, () => {
  console.log(`Signal Render Service listening on :${PORT}`);
});

async function shutdown(signal) {
  console.log(`${signal} received; shutting down`);
  server.close();
  if (browserPromise) {
    const browser = await browserPromise.catch(() => null);
    await browser?.close().catch(() => {});
  }
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
