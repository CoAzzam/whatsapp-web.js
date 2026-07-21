# WhatsApp Dashboard

A minimal web dashboard on top of **whatsapp-web.js**:

- Start a session and scan the QR code from your browser.
- API-key protected endpoint to send messages.
- Optional webhook that forwards every incoming message to your own system,
  so you can build "it messages me and I reply" flows.

## Run locally

```bash
# from the repo root
npm install
cp dashboard/.env.example dashboard/.env   # then edit the values
npm run dashboard
```

Open http://localhost:3000, paste your `API_KEY`, click **ابدأ الجلسة / أظهر QR**,
and scan the QR with WhatsApp → Linked devices → Link a device.

## Environment variables

| Variable      | Required | Description                                                        |
| ------------- | -------- | ------------------------------------------------------------------ |
| `PORT`        | no       | Port to listen on (default `3000`).                                |
| `API_KEY`     | yes      | Secret for sending messages / controlling the session.             |
| `WEBHOOK_URL` | no       | Incoming messages are POSTed here as JSON.                         |
| `SESSION_PATH`| no       | Where auth files are stored. Use a persistent disk in production.  |

## API

All control endpoints require the header `x-api-key: <API_KEY>`.

### Send a message

```bash
curl -X POST http://localhost:3000/api/send \
  -H "x-api-key: YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"number":"9665XXXXXXXX","message":"Hello"}'
```

`number` can be a raw phone number (digits only, no `+`) or a full WhatsApp id
like `9665XXXXXXXX@c.us`.

### Other endpoints

| Method | Path                   | Auth    | Purpose                          |
| ------ | ---------------------- | ------- | -------------------------------- |
| GET    | `/api/status`          | public  | Current status + QR image.       |
| POST   | `/api/session/start`   | api key | Start / re-init the session.     |
| POST   | `/api/session/logout`  | api key | Log out and clear the session.   |
| POST   | `/api/send`            | api key | Send a message.                  |

### Webhook payload

When `WEBHOOK_URL` is set, each incoming message is POSTed as:

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

Your system reads this and replies by calling `POST /api/send`.

## Deployment

> ⚠️ **This will NOT run on Vercel / Netlify / Cloudflare (serverless).**
> whatsapp-web.js launches a real Chromium browser and needs a
> **long-running process** plus a **persistent disk** for the session.

### Deploy on Railway (recommended)

A `Dockerfile` at the repo root already installs everything Chromium needs, so
Railway builds it with no extra setup.

1. **Create the project** – Railway → *New Project* → *Deploy from GitHub repo*
   → pick this repo and the `claude/dashboard-readiness-yzpfn9` branch.
   Railway detects the `Dockerfile` automatically.
2. **Add a persistent volume** (so you don't re-scan the QR on every restart)
   – service → *Variables/Settings* → *Volumes* → add a volume mounted at
   **`/data`**. The Dockerfile already sets `SESSION_PATH=/data/.wwebjs_auth`.
3. **Set environment variables** – service → *Variables*:
   - `API_KEY` = a long random secret (required)
   - `WEBHOOK_URL` = your endpoint (optional)
   - Don't set `PORT`; Railway provides it and the server reads it.
4. **Deploy**, then open the generated public URL, paste your `API_KEY`,
   click *ابدأ الجلسة*, and scan the QR.

> The first boot builds the image (installs Chromium libs) and can take a few
> minutes — that's normal.

### Other hosts

- **Render** – New *Web Service*, Docker runtime (uses the same `Dockerfile`),
  add a Disk mounted at `/data`.
- **Fly.io** – `fly launch` (detects the Dockerfile), add a volume for `/data`.
- **A VPS** – `docker build -t wa-dash . && docker run -p 3000:3000 \
  -e API_KEY=... -v $PWD/data:/data wa-dash`, or run
  `pm2 start dashboard/server.js` behind Nginx.

On all of these, set `API_KEY` (and optionally `WEBHOOK_URL`) as environment
variables, and keep the session directory on a persistent volume so you don't
have to re-scan the QR after every restart.
