# NexChat (Functional Upgrade)

This upgrade turns NexChat into a working real-time app with backend, auth, moderation, stories, admin actions, AI hooks, and music mode.

## Features implemented

- Real-time chat via Socket.IO with typing, online/offline, and message status (sent/delivered/seen).
- User signup/login with JWT authentication.
- Persistent storage via SQLite (`better-sqlite3`).
- Bad-word filtering + admin-managed banned words list.
- AI moderation gate (toxicity scoring) and AI assistant modes (reply/summarize/rephrase).
- Report system, user strike counting, auto-block for repeated abuse.
- Story mode with 24h expiration + viewer tracking.
- Music mode (`Now Playing`) with shareable external Spotify/YouTube links.
- Legal/Privacy page and support contact email.

## Quick start

```bash
npm install
cp .env.example .env
npm run dev
```

Open `http://localhost:3000`.

## Create admin user

1. Sign up normally.
2. Open SQLite DB and set admin flag:

```bash
sqlite3 nexchat.db "UPDATE users SET is_admin=1 WHERE email='your@email.com';"
```

## Termux guide (Android)

```bash
pkg update && pkg upgrade -y
pkg install nodejs git -y
git clone <your-repo-url>
cd Nextchat
npm install
cp .env.example .env
npm run dev
```

Keep app alive with `tmux` or `nohup`:

```bash
pkg install tmux -y
tmux
npm run dev
```

## Hosting options

### Option A: Render/Railway/Fly.io
- Push this repo to GitHub.
- Create a new web service.
- Start command: `npm start`.
- Set env vars from `.env.example`.
- Persist database using attached disk/volume.

### Option B: Firebase Hosting + Cloud Run (hybrid)
- Keep frontend static files in Firebase Hosting.
- Deploy Node backend to Cloud Run.
- Point frontend API calls to Cloud Run base URL.

## Security notes

- Use strong `JWT_SECRET` in production.
- Run behind HTTPS reverse proxy.
- Rotate AI/API credentials.
- Expand to full E2E encryption for direct chats in production.
