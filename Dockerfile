# Playwright's official image ships Chromium + all system deps + common fonts.
# This avoids the #1 headache of running headless Chromium on Railway.
FROM mcr.microsoft.com/playwright:v1.61.1-jammy
WORKDIR /app

# install deps first (better layer caching)
COPY package.json ./
RUN npm install --omit=dev

# app + templates
COPY server.js ./
COPY templates ./templates

ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
