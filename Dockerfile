# Dockerfile for the WhatsApp dashboard (Railway / Render / any container host).
#
# whatsapp-web.js runs a real Chromium via Puppeteer. Instead of hand-listing
# Chromium's shared libraries (easy to miss one, which makes it fail silently),
# we install Debian's `chromium` package — apt pulls in every dependency it
# needs — and point Puppeteer at it via PUPPETEER_EXECUTABLE_PATH.

FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    ca-certificates \
    fonts-liberation \
    fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

# Use the system Chromium and skip Puppeteer's own ~150MB download.
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

# Install dependencies first for better layer caching.
COPY package*.json ./
RUN npm ci

# App source.
COPY . .

# Store the WhatsApp session on a mounted volume in production
# (mount a Railway volume at /data).
ENV NODE_ENV=production
ENV SESSION_PATH=/data/.wwebjs_auth

EXPOSE 3000

CMD ["npm", "run", "dashboard"]
