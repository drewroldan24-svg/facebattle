# ⚡ FaceBattle

Real-time facial attractiveness 1v1 battles. No sign-up required. Just enter a name and fight.

## Features
- 🎥 Live WebRTC peer-to-peer video (1v1)
- 🤖 AI face detection every 5 seconds (face-api.js)
- 💬 Live in-battle chat
- 🏆 Global leaderboard (wins / losses / best score)
- ⚡ 60fps camera target, no login required

---

## Deploy in 5 minutes — Railway (Recommended)

Railway gives you a persistent Node.js server with WebSocket support and a free `*.railway.app` domain.

### Step 1 — Push to GitHub

```bash
git init
git add .
git commit -m "FaceBattle initial commit"
# Create a repo on github.com, then:
git remote add origin https://github.com/YOUR_USERNAME/facebattle.git
git push -u origin main
```

### Step 2 — Deploy to Railway

1. Go to **https://railway.app** → Sign in with GitHub
2. Click **"New Project"** → **"Deploy from GitHub repo"**
3. Select your `facebattle` repository
4. Railway auto-detects Node.js and runs `npm install && node server.js`
5. Click **"Generate Domain"** in Settings → your site is live!

That's it. One URL, everything on one domain. ✅

---

## Alternative: Deploy to Render (also free)

1. Go to **https://render.com** → Sign in with GitHub
2. New → **Web Service** → connect your repo
3. Build Command: `npm install`
4. Start Command: `node server.js`
5. Click **Create Web Service**

Render auto-detects `render.yaml` if present.

---

## Alternative: Run Locally

```bash
npm install
npm start
# Open http://localhost:3000
```

For dev with auto-restart:
```bash
npm install -g nodemon
npm run dev
```

---

## How It Works

```
Browser A ──WebSocket──► Server ◄──WebSocket── Browser B
    │                       │                      │
    └──── WebRTC offer ─────┤                      │
    │                       │──── forwards ────────►│
    │                       │                      │
    │◄─── WebRTC answer ────┤──── forwards ────────┘
    │                       │
    └───── P2P video ────────────────────────────────►
           (direct, server not involved after setup)
```

- **Signaling** (offers/answers/ICE) goes through your Node.js server via WebSocket
- **Video** goes peer-to-peer via WebRTC (no server bandwidth used for video)
- **Scores** are computed locally via face-api.js and reported to server
- **Chat** messages route through the server

---

## Architecture

```
facebattle/
├── server.js          — Express + WebSocket server
├── public/
│   └── index.html     — Entire frontend (single file)
├── package.json
├── railway.json       — Railway deploy config
├── render.yaml        — Render deploy config
└── README.md
```

---

## Notes

- **No database** — leaderboard is in-memory (resets on server restart). For persistence, add a Redis or SQLite integration.
- **TURN servers** — Using open public TURN (openrelay.metered.ca). For production, get your own at https://dashboard.metered.ca (free tier available).
- **Face-api models** — Loaded from jsDelivr CDN. First scan may take 2–3 seconds while models download.
