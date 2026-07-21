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

Use a host that provides those, for example:

- **Railway** – add the repo, set the start command to `npm run dashboard`,
  add a persistent volume mounted where `SESSION_PATH` points.
- **Render** – Web Service, start command `npm run dashboard`, add a Disk.
- **Fly.io** – add a volume and mount it for the session data.
- **A VPS** – run with `pm2 start dashboard/server.js` behind Nginx.

On all of these, set `API_KEY` (and optionally `WEBHOOK_URL`) as environment
variables, and make sure the session directory is on a persistent volume so you
don't have to re-scan the QR after every restart.
