# Signal Render Service — Deploy & Use

A tiny service that turns your HTML templates into branded PNGs. Signal sends it a
template name + a client's brand/content data, and gets back a finished 1080×1080 post.

No Canva. No Enterprise. No per-image AI cost. Runs on your Railway, renders for free.

---

## What's in this folder

```
signal-render/
├── server.js              the service (one /render endpoint)
├── package.json           dependencies (express + playwright)
├── Dockerfile             uses Playwright's official image (Chromium preinstalled)
└── templates/
    ├── master/index.html  the master card (category / headline / body / stat)
    └── ticker/index.html  the ticker card (two-line headline + body)
```

Both templates are **brand-agnostic** — every color, logo, and text field comes in
through the request. One template serves every client. Add a client = send different data.

---

## Part 1 — Deploy on Railway (~10 minutes, one time)

You said you'd do this hands-on. Here's every step.

### 1. Put this folder in a GitHub repo
- Create a new GitHub repo (e.g. `signal-render`).
- Upload the entire `signal-render/` folder contents to it (server.js, package.json,
  Dockerfile, and the templates/ folder). The Dockerfile must be at the repo root.

### 2. Create the Railway service
- In Railway: **New Project → Deploy from GitHub repo → pick your `signal-render` repo.**
- Railway detects the `Dockerfile` and builds automatically. (First build ~3–5 min —
  it's downloading the Playwright/Chromium image.)

### 3. Set the environment variable
- In the Railway service → **Variables** → add:
  - `RENDER_TOKEN` = a long random secret string (make one up — this is the password
    Signal uses to call the service). Example: `sig_rnd_9f2k...` (use a real random value.)
- You do **not** need `CHROMIUM_PATH` on Railway — the Docker image already has Chromium
  in the right place. (That variable only exists for local testing.)

### 4. Expose it
- Railway service → **Settings → Networking → Generate Domain.**
- You'll get a URL like `https://signal-render-production.up.railway.app`.
- Test it: open `https://<your-domain>/health` in a browser → should show `{"ok":true}`.

Done. The service is live.

---

## Part 2 — How to call it (what Signal will do)

Signal makes one HTTP POST per post it wants rendered.

```
POST https://<your-domain>/render
Headers:
  Authorization: Bearer <RENDER_TOKEN>
  Content-Type: application/json
Body:
{
  "template": "master",          // or "ticker"
  "params": {
    "bg": "050505",
    "accentFrom": "9945FF",
    "accentTo": "14F195",
    "glow": "8B5CF6",
    "logo": "https://<signed-logo-url>",   // top-left logo (see note below)
    "brand": "ONIXUS",                      // fallback text if no logo url
    "pill": "1",                            // "1" = white pill behind logo (Zee), omit otherwise
    "productLogo": "https://<signed-url>",  // optional top-right product mark (master only)
    "eyebrow": "Market News",
    "headline": "One Engine Running {{Four Platforms}}",  // {{...}} = accent-colored
    "body": "Signal generates and brands automatically, per client.",
    "statNum": "+38%",                      // optional; omit to hide
    "statLbl": "7-day social growth",       // optional
    "url": "www.onixus.xyz",
    "powered": "Powered by *Onyx*"          // *...* = colored
  }
}
```
Response: the raw PNG bytes (`Content-Type: image/png`). Signal uploads that to the
`signal-content-images` bucket exactly like it does today.

### Template-specific fields
- **master**: `eyebrow`, `headline`, `body`, `statNum`, `statLbl`, `productLogo`
- **ticker**: `line1` (white), `line2` (accent color), `body`

### Shared fields (both)
`bg`, `accentFrom`, `accentTo`, `accent`, `glow`, `logo`, `brand`, `pill`, `url`

---

## Part 3 — The logo question (important)

Templates load logos by URL. Your logos live in the private `brand-assets` bucket, so
Signal must pass a **signed URL** (valid short-term) as the `logo` param. Signal already
knows how to sign URLs — it does this today in the branding engine. So the wiring is:

For each client, Signal already has (in `signal_brand_profiles`):
- `brand_colors` → `accentFrom` / `accentTo`
- `brand_logo_path` → sign it → `logo`
- `logo_backdrop` → if `white_pill`, send `pill: "1"`
- contact line → `url` / footer

That's the same data we cleaned up and verified today. The render service just consumes it.

---

## Part 4 — Wiring Signal to call it (next build step)

This is the Lovable edge-function work to do next (not done yet):
1. Add `RENDER_SERVICE_URL` and `RENDER_TOKEN` as Supabase secrets.
2. New edge function `signal-render-template` that:
   - takes a client_id + content (headline/body/etc.) + template name,
   - loads the client's `signal_brand_profiles` row,
   - signs the logo URL(s),
   - POSTs to the render service,
   - uploads the returned PNG to `signal-content-images`,
   - returns the path (same shape the current pipeline expects).
3. Point the "text-forward post" path at this instead of the photo-stamp engine.

The photo-stamp engine stays for actual photo posts; this handles the designed cards.

---

## Local testing (optional)

```
cd signal-render
npm install
npx playwright install chromium
RENDER_TOKEN=test node server.js
# then in another terminal:
curl -X POST http://localhost:8080/render \
  -H "Authorization: Bearer test" -H "Content-Type: application/json" \
  -d '{"template":"master","params":{"brand":"ONIXUS","headline":"Hello {{World}}","body":"Test.","url":"onixus.xyz"}}' \
  --output test.png
```

---

## Cost

- Railway: a small always-available service. Typically a few dollars/month depending on
  usage — far below any per-image AI cost, and it renders unlimited images.
- No per-render fees. No design-tool subscription. The templates are yours.

## Growing into video (later)

This same service extends to video: render template frames, then stitch with FFmpeg
(add an `/render-video` endpoint). The slideshow video type reuses these exact templates.
That's the natural next layer once the image path is live.
