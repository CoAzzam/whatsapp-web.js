'use strict';

/**
 * Managed WhatsApp dashboard server.
 *
 * Features:
 *   - Admin login (password from ADMIN_PASSWORD) protects the whole dashboard.
 *   - Generate / regenerate an API key from the UI (persisted to disk).
 *   - Save the webhook URL from the UI (persisted to disk).
 *   - Auto-generated webhook secret; every webhook POST is signed with
 *     HMAC-SHA256 in the `X-Signature` header so your system can verify it.
 *   - Start a session and scan the QR code from the browser.
 *   - API-key protected endpoint to send messages: POST /api/send
 *
 * IMPORTANT: This needs a long-running server with a persistent filesystem
 * (Railway / Render / Fly.io / a VPS). It will NOT work on serverless hosts
 * like Vercel, because whatsapp-web.js runs a real Chromium browser.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const QRCode = require('qrcode');
const fetch = require('node-fetch');
const { Client, LocalAuth } = require('..');

const PORT = process.env.PORT || 3000;
const SESSION_PATH =
    process.env.SESSION_PATH || path.join(__dirname, '.wwebjs_auth');
const CONFIG_PATH =
    process.env.CONFIG_PATH ||
    path.join(path.dirname(SESSION_PATH), 'dashboard-config.json');

// Admin password protects the dashboard. If unset we fall back to "admin"
// and warn loudly — always set ADMIN_PASSWORD in production.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';

function log(...args) {
    console.log('[dashboard]', ...args);
}

function genToken(bytes = 24) {
    return crypto.randomBytes(bytes).toString('hex');
}

function safeEqual(a, b) {
    const ab = Buffer.from(String(a));
    const bb = Buffer.from(String(b));
    if (ab.length !== bb.length) return false;
    return crypto.timingSafeEqual(ab, bb);
}

// Reject a promise if it doesn't settle in `ms`, so a hanging WhatsApp call
// never leaves the HTTP request open forever.
function withTimeout(promise, ms, label = 'operation timed out') {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------------------
// Persisted config (api key, webhook url, webhook secret)
// ---------------------------------------------------------------------------
function loadConfig() {
    try {
        return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch {
        return {};
    }
}

function saveConfig() {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

const config = loadConfig();
let seeded = false;
if (!config.apiKey) {
    config.apiKey = process.env.API_KEY || genToken(24);
    seeded = true;
}
if (typeof config.webhookUrl !== 'string') {
    config.webhookUrl = process.env.WEBHOOK_URL || '';
    seeded = true;
}
if (!config.webhookSecret) {
    config.webhookSecret = genToken(24);
    seeded = true;
}
if (seeded) saveConfig();

// ---------------------------------------------------------------------------
// WhatsApp client state
// ---------------------------------------------------------------------------
const state = {
    status: 'idle', // idle | initializing | qr | authenticated | ready | disconnected
    qrDataUrl: null, // QR rendered as an image data URL (for the browser)
    info: null, // logged-in account info once ready
    lastError: null,
};

/** @type {import('..').Client | null} */
let client = null;

async function forwardToWebhook(event, payload) {
    if (!config.webhookUrl) return;
    const body = JSON.stringify({ event, ...payload });
    const signature = crypto
        .createHmac('sha256', config.webhookSecret)
        .update(body)
        .digest('hex');
    try {
        await fetch(config.webhookUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Webhook-Event': event,
                'X-Signature': `sha256=${signature}`,
            },
            body,
        });
    } catch (err) {
        log('webhook error:', err.message);
    }
}

function startClient() {
    if (client) return client;

    state.status = 'initializing';
    state.lastError = null;

    client = new Client({
        authStrategy: new LocalAuth({ dataPath: SESSION_PATH }),
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
            ],
        },
    });

    client.on('qr', async (qr) => {
        state.status = 'qr';
        try {
            state.qrDataUrl = await QRCode.toDataURL(qr, {
                margin: 1,
                width: 320,
            });
        } catch (err) {
            log('qr render error:', err.message);
        }
        log('QR received — scan it from the dashboard.');
    });

    client.on('authenticated', () => {
        state.status = 'authenticated';
        state.qrDataUrl = null;
        log('authenticated');
    });

    client.on('ready', () => {
        state.status = 'ready';
        state.qrDataUrl = null;
        state.info = client.info
            ? {
                  wid: client.info.wid?._serialized,
                  pushname: client.info.pushname,
                  platform: client.info.platform,
              }
            : null;
        log('client is ready:', state.info?.pushname);
    });

    client.on('auth_failure', (msg) => {
        state.status = 'disconnected';
        state.lastError = `auth_failure: ${msg}`;
        log('auth failure:', msg);
    });

    client.on('disconnected', (reason) => {
        state.status = 'disconnected';
        state.info = null;
        state.lastError = `disconnected: ${reason}`;
        log('disconnected:', reason);
    });

    client.on('message', async (message) => {
        // Forward every incoming message to the webhook so an external
        // system can decide how to reply (through POST /api/send).
        await forwardToWebhook('message', {
            id: message.id?._serialized,
            from: message.from,
            to: message.to,
            body: message.body,
            type: message.type,
            timestamp: message.timestamp,
            fromMe: message.fromMe,
            hasMedia: message.hasMedia,
        });
    });

    client.initialize().catch((err) => {
        state.status = 'disconnected';
        state.lastError = err.message;
        log('initialize error:', err.message);
    });

    return client;
}

// ---------------------------------------------------------------------------
// App + auth
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Admin sessions live in memory; they clear on restart (re-login required).
const adminTokens = new Set();

function requireAdmin(req, res, next) {
    const token = req.get('x-admin-token');
    if (!token || !adminTokens.has(token)) {
        return res.status(401).json({ error: 'unauthorized' });
    }
    next();
}

function requireApiKey(req, res, next) {
    const key = req.get('x-api-key') || req.query.api_key;
    if (!key || !safeEqual(key, config.apiKey)) {
        return res.status(401).json({ error: 'invalid or missing api key' });
    }
    next();
}

// ---------------------------------------------------------------------------
// Auth routes
// ---------------------------------------------------------------------------
app.post('/api/login', (req, res) => {
    const { password } = req.body || {};
    if (!password || !safeEqual(password, ADMIN_PASSWORD)) {
        return res.status(401).json({ error: 'wrong password' });
    }
    const token = genToken(24);
    adminTokens.add(token);
    res.json({ token });
});

app.post('/api/logout-admin', requireAdmin, (req, res) => {
    adminTokens.delete(req.get('x-admin-token'));
    res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Dashboard routes (admin only)
// ---------------------------------------------------------------------------
app.get('/api/status', requireAdmin, (req, res) => {
    res.json({
        status: state.status,
        qr: state.qrDataUrl,
        info: state.info,
        webhookConfigured: Boolean(config.webhookUrl),
        lastError: state.lastError,
    });
});

// Settings: api key, webhook url, webhook secret. Admin can read the secrets.
app.get('/api/settings', requireAdmin, (req, res) => {
    res.json({
        apiKey: config.apiKey,
        webhookUrl: config.webhookUrl,
        webhookSecret: config.webhookSecret,
        publicUrl: `${req.protocol}://${req.get('host')}`,
    });
});

app.post('/api/settings/webhook', requireAdmin, (req, res) => {
    const { webhookUrl } = req.body || {};
    config.webhookUrl = typeof webhookUrl === 'string' ? webhookUrl.trim() : '';
    saveConfig();
    res.json({ webhookUrl: config.webhookUrl });
});

app.post('/api/settings/apikey/regenerate', requireAdmin, (req, res) => {
    config.apiKey = genToken(24);
    saveConfig();
    res.json({ apiKey: config.apiKey });
});

app.post('/api/settings/secret/regenerate', requireAdmin, (req, res) => {
    config.webhookSecret = genToken(24);
    saveConfig();
    res.json({ webhookSecret: config.webhookSecret });
});

app.post('/api/session/start', requireAdmin, (req, res) => {
    startClient();
    res.json({ status: state.status });
});

app.post('/api/session/logout', requireAdmin, async (req, res) => {
    try {
        if (client) {
            await client.logout().catch(() => {});
            await client.destroy().catch(() => {});
        }
    } finally {
        client = null;
        state.status = 'idle';
        state.qrDataUrl = null;
        state.info = null;
    }
    res.json({ status: state.status });
});

// ---------------------------------------------------------------------------
// Send route (API key — for your external system)
// ---------------------------------------------------------------------------
// body: { number: "9665XXXXXXXX", message: "hello" }
// number can be a raw phone number (digits, no +) or a full WhatsApp id.
app.post('/api/send', requireApiKey, async (req, res) => {
    if (!client || state.status !== 'ready') {
        return res
            .status(409)
            .json({ error: 'client not ready', status: state.status });
    }

    const { number, message } = req.body || {};
    if (!number || !message) {
        return res
            .status(400)
            .json({ error: 'number and message are required' });
    }

    try {
        // Resolve the correct WhatsApp chat id. Using getNumberId validates
        // that the number is actually registered and avoids sendMessage
        // hanging forever on an unresolved/badly-formatted id.
        let chatId;
        if (String(number).includes('@')) {
            chatId = String(number);
        } else {
            const digits = String(number).replace(/\D/g, '');
            const numberId = await withTimeout(
                client.getNumberId(digits),
                20000,
                'number lookup timed out',
            );
            if (!numberId) {
                return res.status(422).json({
                    error: 'number is not registered on WhatsApp',
                    number: digits,
                });
            }
            chatId = numberId._serialized;
        }

        const sent = await withTimeout(
            client.sendMessage(chatId, message),
            25000,
            'send timed out',
        );
        res.json({ ok: true, id: sent.id?._serialized, to: chatId });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const server = http.createServer(app);
server.listen(PORT, () => {
    log(`dashboard running on http://localhost:${PORT}`);
    if (ADMIN_PASSWORD === 'admin') {
        log(
            'WARNING: ADMIN_PASSWORD not set — using default "admin". CHANGE IT!',
        );
    }
    log(`config file: ${CONFIG_PATH}`);
});
