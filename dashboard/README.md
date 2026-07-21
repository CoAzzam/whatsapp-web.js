# WhatsApp Dashboard

A managed web dashboard on top of **whatsapp-web.js**:

- **Admin login** (password) protects the whole dashboard.
- Start a session and scan the QR code from your browser.
- **Generate / regenerate an API key** from the UI (persisted to disk).
- **Save a webhook URL** from the UI (persisted to disk).
- **Webhook secret**: every incoming message is POSTed to your webhook and
  signed with HMAC-SHA256 so your system can verify it's really from you.
- API-key protected endpoint to send messages, so you can build
  "it messages me and I reply" flows.

## Run locally

```bash
# from the repo root
npm install
cp dashboard/.env.example dashboard/.env   # set ADMIN_PASSWORD
npm run dashboard
```

Open http://localhost:3000, log in with `ADMIN_PASSWORD`, then:

1. Click **ابدأ الجلسة / أظهر QR** and scan it with
   WhatsApp → Linked devices → Link a device.
2. In **الإعدادات**: copy your **API Key**, paste and save your **Webhook URL**,
   and copy your **Webhook Secret**.

The API key, webhook URL, and webhook secret are generated automatically on
first run and stored in the config file (see `CONFIG_PATH`). Manage them from
the dashboard afterwards — no need to touch environment variables.

## Environment variables

| Variable         | Required | Description                                                              |
| ---------------- | -------- | ------------------------------------------------------------------------ |
| `ADMIN_PASSWORD` | **yes**  | Dashboard login password. Falls back to `admin` with a warning if unset. |
| `PORT`           | no       | Port to listen on (default `3000`; Railway sets it automatically).       |
| `SESSION_PATH`   | no       | Where WhatsApp auth files are stored. Use a persistent disk.             |
| `CONFIG_PATH`    | no       | Where the api key / webhook / secret are stored. Use a persistent disk.  |
| `API_KEY`        | no       | Seed for the API key on first run only (otherwise auto-generated).       |
| `WEBHOOK_URL`    | no       | Seed for the webhook URL on first run only.                              |

## API

### Send a message (for your external system)

Requires the header `x-api-key: <API_KEY>` (the key shown in the dashboard).

```bash
curl -X POST http://localhost:3000/api/send \
  -H "x-api-key: YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"number":"9665XXXXXXXX","message":"Hello"}'
```

`number` can be a raw phone number (digits only, no `+`) or a full WhatsApp id
like `9665XXXXXXXX@c.us`.

### Endpoints

| Method | Path                              | Auth       | Purpose                          |
| ------ | --------------------------------- | ---------- | -------------------------------- |
| POST   | `/api/login`                      | password   | Get an admin token.              |
| GET    | `/api/status`                     | admin      | Status + QR image.               |
| GET    | `/api/settings`                   | admin      | Read api key / webhook / secret. |
| POST   | `/api/settings/webhook`           | admin      | Save the webhook URL.            |
| POST   | `/api/settings/apikey/regenerate` | admin      | Regenerate the API key.          |
| POST   | `/api/settings/secret/regenerate` | admin      | Regenerate the webhook secret.   |
| POST   | `/api/session/start`              | admin      | Start / re-init the session.     |
| POST   | `/api/session/logout`             | admin      | Log out and clear the session.   |
| POST   | `/api/send`                       | api key    | Send a message.                  |

Admin endpoints use the header `x-admin-token: <token>` returned by `/api/login`.

## Webhook

When a webhook URL is set, each incoming message is POSTed as JSON:

```json
{
  "event": "message",
  "id": "false_9665...@c.us_ABC",
  "from": "9665XXXXXXXX@c.us",
  "to": "9665YYYYYYYY@c.us",
  "body": "hello",
  "type": "chat",
  "timestamp": 1700000000,
  "fromMe": false,
  "hasMedia": false
}
```

Headers sent with each webhook:

- `X-Webhook-Event: message`
- `X-Signature: sha256=<hex>` — HMAC-SHA256 of the raw request body using your
  **webhook secret**.

Verify it on your side (Node.js example):

```js
const crypto = require('crypto');

// rawBody must be the exact bytes received (use a raw body parser).
const expected =
  'sha256=' +
  crypto.createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex');

const ok = req.get('X-Signature') === expected;
if (!ok) return res.status(401).end();
```

Your system reads the payload and replies by calling `POST /api/send`.

## Deployment

> ⚠️ **This will NOT run on Vercel / Netlify / Cloudflare (serverless).**
> whatsapp-web.js launches a real Chromium browser and needs a
> **long-running process** plus a **persistent disk** for the session.

### Deploy on Railway (recommended)

A `Dockerfile` at the repo root already installs everything Chromium needs, so
Railway builds it with no extra setup.

1. **Create the project** – Railway → _New Project_ → _Deploy from GitHub repo_
   → pick this repo and the `claude/dashboard-readiness-yzpfn9` branch.
   Railway detects the `Dockerfile` automatically.
2. **Add a persistent volume** (so you don't re-scan the QR on every restart)
   – service → _Settings_ → _Volumes_ → add a volume mounted at **`/data`**.
   The Dockerfile already points `SESSION_PATH` and the config file at `/data`.
3. **Set environment variables** – service → _Variables_:
   - `ADMIN_PASSWORD` = your dashboard login password (required)
   - Don't set `PORT`; Railway provides it and the server reads it.
4. **Deploy**, then open the generated public URL, log in, click _ابدأ الجلسة_,
   scan the QR, and grab your API key + webhook secret from _الإعدادات_.

> The first boot builds the image (installs Chromium libs) and can take a few
> minutes — that's normal.

### Other hosts

- **Render** – New _Web Service_, Docker runtime (uses the same `Dockerfile`),
  add a Disk mounted at `/data`.
- **Fly.io** – `fly launch` (detects the Dockerfile), add a volume for `/data`.
- **A VPS** – `docker build -t wa-dash . && docker run -p 3000:3000 \
  -e ADMIN_PASSWORD=... -v $PWD/data:/data wa-dash`, or run
  `pm2 start dashboard/server.js` behind Nginx.

On all of these, set `ADMIN_PASSWORD` and keep both the session directory and
the config file on a persistent volume so you don't lose your login setup or
have to re-scan the QR after every restart.
