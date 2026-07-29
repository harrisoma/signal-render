# signal-render worker (contract v2)

Stateless FFmpeg render worker for Signal Video Studio. Runs on Railway.
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

## Deploy

1. Copy these files to the root of `harrisoma/signal-render` on `main`
   (Railway deploys from `main`).
2. Set Railway env:
   - `RENDER_TOKEN` = same value as Supabase secret `RENDER_TOKEN`
   - `SUPABASE_URL` = your Supabase project URL (**required** — the worker POSTs
     its completion callback to `${SUPABASE_URL}/functions/v1/signal-video-complete`.
     Without it the worker renders and uploads but never reports completion, so
     jobs stay stuck in `rendering`.)
   - `PORT` = `8080`
3. **Remove** `SUPABASE_SERVICE_ROLE_KEY` from Railway env — the worker never
   talks to Supabase directly and must not hold the service role key.
4. Redeploy. Any builder works: the worker prefers the bundled
   `ffmpeg-static`/`ffprobe-static` binaries and falls back to PATH
   (Dockerfile and nixpacks both install ffmpeg too).

## Verify

```
curl https://<railway-app>/health
```

Expect:

```json
{
  "ok": true,
  "static_render": true,
  "video_render": true,
  "status_endpoint_configured": true,
  "active_video_jobs": 0,
  "queued_video_jobs": 0
}
```

If `video_render` is `false`, either `RENDER_TOKEN` is missing or `ffmpeg`
is not on PATH — check the Dockerfile / nixpacks build logs. If
`status_endpoint_configured` is `false`, `SUPABASE_URL` is missing — the
render will run but the job will never be marked complete.

## Contract

Full request/response contract lives in the Onixus repo at
`docs/railway-signal-render-worker.md`.
