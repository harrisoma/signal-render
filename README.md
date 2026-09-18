# signal-render worker (contract v2)

Stateless FFmpeg + Chromium render worker for Signal Video Studio. Runs on Railway.
No Supabase client — the Edge Function mints signed GET/PUT URLs; this
worker only downloads scenes, renders, uploads, and POSTs a callback.

Render features:
- **Cinematic motion** — each scene is a Ken-Burns clip (slow zoom) joined with
  crossfade transitions. Falls back automatically to a timed slideshow if the
  motion filtergraph errors, so a render never fails outright.
- **Voiceover** — if the payload includes `voiceover_url` (an MP3 the
  coordinator synthesized via TTS), it is muxed as the audio track.
- **Captions** — if `captions_enabled` is true, per-scene `on_screen_text`
  is burned in as styled ASS subtitles (requires libass, included in the
  Dockerfile/nixpacks ffmpeg build).

## Endpoints

- `POST /render-video` — scenes + audio → MP4 (the montage path). Bearer `RENDER_TOKEN`.
- `POST /render` — bundled template (`templates/<name>`) + params → PNG. Bearer `RENDER_TOKEN`.
  Used by `signal-render-template` / `signal-render-carousel`.
- `POST /render-html` — raw HTML → PNG/JPEG via headless Chromium. `x-render-token: RENDER_HTML_TOKEN`
  (open when unset — set it).
- `GET /health`, `GET /templates`.

## Deploy

Railway builds the Dockerfile from `main`. Full env-var table, verification
steps and operational limits are in [DEPLOY.md](DEPLOY.md).

## Contract

Full request/response contract lives in the Onixus repo at
`docs/railway-signal-render-worker.md`.
