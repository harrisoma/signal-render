# signal-render worker — Node 20 + ffmpeg
FROM node:20-bookworm-slim

# ffmpeg + ffprobe (the #1 reason /health reports video_render:false)
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
