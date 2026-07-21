'use strict';

/**
 * Simple WhatsApp dashboard server.
 *
 * Features:
 *   - Web dashboard to start a session and scan the QR code.
 *   - API-key protected endpoint to send messages: POST /api/send
 *   - Optional webhook: every incoming message is forwarded (POST) to WEBHOOK_URL
 *     so an external system can process it and reply back through /api/send.
 *
 * IMPORTANT: This needs a long-running server with a persistent filesystem
 * (Railway / Render / Fly.io / a VPS). It will NOT work on serverless hosts
 * like Vercel, because whatsapp-web.js runs a real Chromium browser.
 */

const path = require('path');
const http = require('http');
const express = require('express');
const QRCode = require('qrcode');
const fetch = require('node-fetch');
const { Client, LocalAuth } = require('..');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || 'change-me-please';
const WEBHOOK_URL = process.env.WEBHOOK_URL || '';
const SESSION_PATH =
    process.env.SESSION_PATH || path.join(__dirname, '.wwebjs_auth');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// WhatsApp client state
// ---------------------------------------------------------------------------
const state = {
    status: 'idle', // idle | initializing | qr | authenticated | ready | disconnected
    qr: null, // last QR string
    qrDataUrl: null, // QR rendered as an image data URL (for the browser)
    info: null, // logged-in account info once ready
    lastError: null,
};

/** @type {import('..').Client | null} */
let client = null;

function log(...args) {
    console.log('[dashboard]', ...args);
}

async function forwardToWebhook(event, payload) {
    if (!WEBHOOK_URL) return;
    try {
        await fetch(WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ event, ...payload }),
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
        state.qr = qr;
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
        state.qr = null;
        state.qrDataUrl = null;
        log('authenticated');
    });

    client.on('ready', () => {
        state.status = 'ready';
        state.qr = null;
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
// API key middleware (protects sending / control endpoints)
// ---------------------------------------------------------------------------
function requireApiKey(req, res, next) {
    const key = req.get('x-api-key') || req.query.api_key;
    if (key !== API_KEY) {
        return res.status(401).json({ error: 'invalid or missing api key' });
    }
    next();
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// Public status for the dashboard UI (no secrets returned).
app.get('/api/status', (req, res) => {
    res.json({
        status: state.status,
        qr: state.qrDataUrl,
        info: state.info,
        webhookConfigured: Boolean(WEBHOOK_URL),
        lastError: state.lastError,
    });
});

// Start / (re)initialize the session.
app.post('/api/session/start', requireApiKey, (req, res) => {
    startClient();
    res.json({ status: state.status });
});

// Log out and destroy the session (clears saved auth).
app.post('/api/session/logout', requireApiKey, async (req, res) => {
    try {
        if (client) {
            await client.logout().catch(() => {});
            await client.destroy().catch(() => {});
        }
    } finally {
        client = null;
        state.status = 'idle';
        state.qr = null;
        state.qrDataUrl = null;
        state.info = null;
    }
    res.json({ status: state.status });
});

// Send a message.
//   body: { number: "9665XXXXXXXX", message: "hello" }
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

    const chatId = String(number).includes('@')
        ? String(number)
        : `${String(number).replace(/\D/g, '')}@c.us`;

    try {
        const sent = await client.sendMessage(chatId, message);
        res.json({ ok: true, id: sent.id?._serialized, to: chatId });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const server = http.createServer(app);
server.listen(PORT, () => {
    log(`dashboard running on http://localhost:${PORT}`);
    log(
        `API key: ${API_KEY === 'change-me-please' ? '(default — CHANGE IT!)' : '(custom set)'}`,
    );
    log(`webhook: ${WEBHOOK_URL || '(not configured)'}`);
});
