// Signal Render Service
// One job: take a template name + brand/content data, return a PNG.
// POST /render  { template: "master", width: 1080, height: 1080, params: { ...brand+content... } }
//   -> image/png
//
// GET /health -> { ok: true }   (Railway healthcheck)
//
// Auth: set RENDER_TOKEN in the environment. Callers must send  Authorization: Bearer <token>.
// Rendering: Playwright Chromium, reused across requests (fast). Templates live in ./templates/<name>/index.html

import express from "express";
import { chromium } from "playwright";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = path.join(__dirname, "templates");
const PORT = process.env.PORT || 8080;
const RENDER_TOKEN = process.env.RENDER_TOKEN || "";

const app = express();
app.use(express.json({ limit: "1mb" }));

// ---- one shared browser, launched lazily, reused across requests ----
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

// ---- health check (Railway pings this) ----
app.get("/health", (_req, res) => res.json({ ok: true }));

// ---- list available templates ----
app.get("/templates", (_req, res) => {
  try {
    const names = fs
      .readdirSync(TEMPLATES_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    res.json({ templates: names });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ---- the render endpoint ----
app.post("/render", async (req, res) => {
  // auth
  if (RENDER_TOKEN) {
    const auth = req.headers.authorization || "";
    if (auth !== `Bearer ${RENDER_TOKEN}`) {
      return res.status(401).json({ error: "unauthorized" });
    }
  }

  const {
    template = "master",
    width = 1080,
    height = 1080,
    format = "png",
    params = {},
  } = req.body || {};

  // resolve + guard the template path (no traversal)
  const safeName = String(template).replace(/[^a-zA-Z0-9_-]/g, "");
  const templateFile = path.join(TEMPLATES_DIR, safeName, "index.html");
  if (!fs.existsSync(templateFile)) {
    return res.status(404).json({ error: `template not found: ${safeName}` });
  }

  // build the file URL with params as query string
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) qs.set(k, String(v));
  }
  const fileUrl = pathToFileURL(templateFile).href + "?" + qs.toString();

  let page;
  try {
    const browser = await getBrowser();
    page = await browser.newPage({
      viewport: { width: Number(width), height: Number(height) },
      deviceScaleFactor: 2, // crisp output
    });
    await page.goto(fileUrl, { waitUntil: "domcontentloaded", timeout: 15000 });

    // The template signals ready ONLY after fonts + all images have loaded or failed.
    // Wait up to 12s for that (remote signed-URL logos can be slow). If it never
    // signals, that itself is a failure we surface rather than shipping a half-render.
    try {
      await page.waitForFunction(() => document.body.dataset.ready === "1", { timeout: 12000 });
    } catch {
      return res.status(504).json({
        error: "render timed out waiting for assets (logo/font may be unreachable)",
      });
    }

    // Read the per-image status the template published.
    const imgStatus = await page.evaluate(() => {
      try { return JSON.parse(document.body.dataset.imgStatus || "{}"); }
      catch { return {}; }
    });

    // FAIL LOUD: if a logo was supposed to load but didn't, do not ship a blank-logo post.
    const failed = Object.entries(imgStatus).filter(([, v]) => v === "fail").map(([k]) => k);
    const strict = req.body.strictLogos !== false; // default on; caller can opt out
    if (strict && failed.length) {
      return res.status(422).json({
        error: "image(s) failed to load",
        failed,
        imgStatus,
        hint: "check the signed URL(s); post was NOT rendered to avoid a broken image",
      });
    }

    await page.waitForTimeout(150); // tiny settle for paint

    const el = (await page.$(".canvas")) || page;
    const buf = await el.screenshot({
      type: format === "jpeg" ? "jpeg" : "png",
      ...(format === "jpeg" ? { quality: 92 } : {}),
    });

    res.set("Content-Type", format === "jpeg" ? "image/jpeg" : "image/png");
    res.set("Cache-Control", "no-store");
    res.set("X-Img-Status", JSON.stringify(imgStatus)); // visibility even on success
    res.send(buf);
  } catch (e) {
    console.error("[render] error:", e);
    res.status(500).json({ error: String(e && e.message ? e.message : e) });
  } finally {
    if (page) await page.close().catch(() => {});
  }
});

app.listen(PORT, () => {
  console.log(`Signal Render Service listening on :${PORT}`);
});
