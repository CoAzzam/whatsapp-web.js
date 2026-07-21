# Dockerfile for the WhatsApp dashboard (Railway / Render / any container host).
#
# whatsapp-web.js runs a real Chromium via Puppeteer, which needs a set of
# system libraries that slim Node images don't ship with. We install them here
# and let Puppeteer use its own bundled, version-matched Chromium.

FROM node:22-slim

# System libraries required by Chromium/Puppeteer on Debian.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    wget \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first for better layer caching.
# The Puppeteer postinstall downloads its bundled Chromium here.
COPY package*.json ./
RUN npm ci

# App source.
COPY . .

# Store the WhatsApp session on a mounted volume in production
# (set SESSION_PATH=/data/.wwebjs_auth and mount a Railway volume at /data).
ENV NODE_ENV=production
ENV SESSION_PATH=/data/.wwebjs_auth

EXPOSE 3000

CMD ["npm", "run", "dashboard"]
