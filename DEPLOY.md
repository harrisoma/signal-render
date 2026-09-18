# signal-render — Deploy & Operate

Stateless render worker for Signal. One Railway service, three jobs:

| Endpoint | Auth | Purpose | Caller |
|---|---|---|---|
| `POST /render-video` | `Authorization: Bearer RENDER_TOKEN` | Scene stills/stock + voiceover + music → MP4 + thumbnail, uploaded via signed PUTs, completion POSTed to `signal-video-complete` | `signal-video-render` edge function |
| `POST /render` | `Authorization: Bearer RENDER_TOKEN` | Bundled HTML template (`templates/<name>/index.html`) + params → branded PNG/JPEG | `signal-render-template`, `signal-render-carousel` |
| `POST /render-html` | `x-render-token: RENDER_HTML_TOKEN` (open if unset) | Arbitrary HTML/CSS → PNG/JPEG (replaces the PageShot API for TWIN stills) | TWIN still-image workflow |
| `GET /health` | none | Readiness flags | `signal-render-diag`, Railway |
| `GET /templates` | bearer | Lists bundled template names | ops |

## Where it runs

- **Railway** project `patient-magic` → service `signal-render`, region `sfo`, 1 replica.
- Builds from the **Dockerfile** on every push to `main` of `harrisoma/signal-render`.
- Public domain: `https://signal-render-production-bfde.up.railway.app`.

## Environment variables (Railway → service → Variables)

| Name | Required | Notes |
|---|---|---|
| `RENDER_TOKEN` | **yes** | Shared secret. Must equal the Supabase secret `RENDER_TOKEN`. Authenticates `/render-video`, `/render`, `/templates`, and is the bearer the worker sends to `signal-video-complete`. |
| `SUPABASE_URL` | **yes** | Project URL. Without it renders finish but never report completion, so jobs sit in `rendering` forever. |
| `RENDER_HTML_TOKEN` | recommended | Secret for `/render-html`. **When unset the endpoint is open to the internet** and will render any HTML / fetch any URL it's given. Set it, and send it as `x-render-token` from the caller. |
| `MAX_HTML_CONCURRENCY` | no (default 2) | Simultaneous Chromium pages across `/render` + `/render-html`. Keep small on a 1‑vCPU box. |
| `CHROMIUM_PATH` | no | Set by the Dockerfile. Only needed if the binary is somewhere unusual. |
| `PORT` | no (8080) | |

Do **not** set `SUPABASE_SERVICE_ROLE_KEY` — the worker never talks to Supabase directly.
`FFMPEG_CRF`, `FFMPEG_PRESET`, `MAX_VIDEO_CONCURRENCY` are **not read** by the worker; remove them if present.

Supabase secrets the callers need: `RENDER_SERVICE_URL` (the Railway domain), `RENDER_TOKEN` (same value as above).

## Verify after a deploy

```
curl https://signal-render-production-bfde.up.railway.app/health
```

Expect every flag true:

```json
{
  "ok": true,
  "static_render": true,
  "templates": ["master", "ticker", "zee-carousel", "zee-elegant", "zee-service"],
  "video_render": true,
  "html_render": true,
  "html_render_auth_required": true,
  "status_endpoint_configured": true,
  "active_video_jobs": 0,
  "queued_video_jobs": 0
}
```

| Flag false | Cause |
|---|---|
| `video_render` | `RENDER_TOKEN` missing, or ffmpeg not installed (check build logs) |
| `static_render` | Chromium missing, `RENDER_TOKEN` missing, or `templates/` not copied into the image |
| `html_render` | Chromium binary not found — check `CHROMIUM_PATH` / build logs |
| `html_render_auth_required` | `RENDER_HTML_TOKEN` unset — endpoint is open |
| `status_endpoint_configured` | `SUPABASE_URL` missing |

Smoke-test a template render:

```
curl -X POST https://signal-render-production-bfde.up.railway.app/render \
  -H "Authorization: Bearer $RENDER_TOKEN" -H "Content-Type: application/json" \
  -d '{"template":"master","params":{"brand":"ONIXUS","headline":"Hello {{World}}","body":"Test.","url":"onixus.xyz"}}' \
  --output test.png
```

## Operational limits baked into the worker

- Video renders run **one at a time** (a second submission of an in-flight `job_id` is acknowledged, not re-queued).
- Every download has a **60s** timeout, uploads **180s**, each ffmpeg pass **10 min**, status callbacks **15s**. A stuck asset fails that one job instead of blocking the queue.
- Cinematic (Ken‑Burns + crossfade) render falls back to a plain slideshow if the ffmpeg graph errors; the job never fails for that reason alone.
- Fail‑closed quality gates: missing brand logo, missing required audio, narration covering < 55% of the timeline → the job is reported `failed` rather than publishing a defective MP4.

## Local run

```
npm ci
RENDER_TOKEN=test SUPABASE_URL=https://example.supabase.co CHROMIUM_PATH="$(which chromium || which chromium-browser)" node server.js
curl localhost:8080/health
```

`npm test` runs the quality-gate checks; CI runs the same on every PR.
