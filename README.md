# NexChat (Functional Upgrade)

This upgrade turns NexChat into a working real-time app with backend, auth, moderation, stories, admin actions, AI hooks, and music mode.

## Features implemented

- Real-time chat via Socket.IO with typing, online/offline, and message status (sent/delivered/seen).
- User signup/login with JWT authentication.
- Persistent storage via portable JSON file storage (Node.js filesystem), compatible with serverless builds where native addons fail.
- Bad-word filtering + admin-managed banned words list.
- AI moderation gate (toxicity scoring) and AI assistant modes (reply/summarize/rephrase).
- Report system, user strike counting, auto-block for repeated abuse.
- Story mode with 24h expiration + viewer tracking.
- Music mode (`Now Playing`) with shareable external Spotify/YouTube links.
- Legal/Privacy page and support contact email.

## Runtime requirement (important)

Use **Node.js 20.x** for local/dev/prod builds (including Vercel). This avoids compatibility issues seen on Node 24 in some environments.

```bash
nvm use 20
# or
volta install node@20
```

## Quick start

```bash
npm install
cp .env.example .env
npm run dev
```

Open `http://localhost:3000`.

## Create admin user

1. Sign up normally.
2. Promote your account to admin in the JSON data file:

```bash
node -e "const fs=require('fs');const p='nexchat.data.json';const d=JSON.parse(fs.readFileSync(p));const u=d.users.find(x=>x.email==='your@email.com');if(u){u.isAdmin=true;fs.writeFileSync(p,JSON.stringify(d,null,2));console.log('updated');}else{console.log('user not found');}"
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

> For Vercel, this repo pins Node 20 via `package.json` engines + `.nvmrc` / `.node-version` + `vercel.json`.

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
