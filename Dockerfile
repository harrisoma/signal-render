# signal-render worker — Node 20 + ffmpeg + headless Chromium
FROM node:20-bookworm-slim

# ffmpeg + ffprobe (the #1 reason /health reports video_render:false)
# chromium (+ fonts) for /render and /render-html — renders HTML/CSS templates
# to PNG for social stills. Installed via apt instead of puppeteer's bundled
# download so the build pulls the exact library set Debian already knows how
# to satisfy, rather than puppeteer's own postinstall fetch.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg chromium ca-certificates fonts-liberation \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Lockfile-pinned install so the image matches what CI tested.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY templates ./templates

ENV NODE_ENV=production
ENV PORT=8080
ENV CHROMIUM_PATH=/usr/bin/chromium
EXPOSE 8080

CMD ["node", "server.js"]
