# QuizArena ⚡ — Live Multiplayer Quiz & Poll Platform

**QuizArena** is a real-time multiplayer Kahoot-style quiz and live polling SaaS platform built with **Node.js**, **Express**, **WebSockets (`ws`)**, and **Vertex AI (`gemini-3.8-flash`)**. It supports 100–250+ concurrent players in a single low-latency room with an invite-only **Creator Studio**, AI-powered quiz generation, multi-format import/export, synthesized Web Audio sound effects, and durable **Google Cloud Storage** persistence for serverless **Cloud Run** deployments.

---

## ✨ Key Features

### 🎨 Invite-Only Creator Studio (`/studio`)
- **Strict Access Control**: Public self-registration and anonymous guest quiz creation are disabled (`403`). Only approved emails can register or sign in.
- **Super Admin Console (`🔐 Access Control`)**: Manage the allowlist of authorized creators in real time—pre-approve emails before sign-up or revoke access (immediately invalidating active sessions).
- **WYSIWYG Visual Quiz Builder**:
  - **4-Choice Multiple Choice (MCQ)** and **2-Choice True / False** questions
  - **Point Modes**: `1× Standard` (1,000 pts + speed bonus), `2× Boss Round` (2,000 pts), and `0× Live Poll` (no-score audience pulse)
  - Per-question countdown timers (`5s–120s`), category badges, and facilitator debrief explanations
- **✨ Vertex AI Quiz Generator**: Generate balanced, distraction-tested quizzes from a topic prompt or pasted notes in seconds using **Gemini 3.8 Flash** (`gemini-3.8-flash`).
- **📥 Multi-Format Import & Export**: Import and export quizzes in **RFC-4180 CSV/TSV**, **JSON**, or **Markdown**, or clone from 4 built-in public templates.

### 🏟️ Real-Time Multiplayer Arena (`/`)
- **Zero-Friction Player Join**: Participants join via a 6-digit PIN or instant scannable QR code—no participant login required, with mobile wake-lock and automatic WebSocket session reconnect.
- **Projector-Ready Host Stage**: Automatic fullscreen mode on launch, animated countdown timer, live response counter, option distribution bar charts, Top-8 leaderboard rounds, and synthesized Web Audio API sound effects + celebratory podium confetti.
- **Scoring Engine**: Speed-scaled points (`500–1,000` base points by reaction time), `2×` Boss multipliers, and hot-streak fire bonuses (`+100` to `+300`).
- **📊 Session Analytics**: Every completed game automatically archives player rankings, accuracy rates, and per-question accuracy breakdowns with 1-click CSV export.

---

## 🗂️ Project Structure

```text
.
├── server.js                 # Express HTTP + WebSocket multiplayer room server
├── questions.js              # Seeded enterprise AI & cloud architecture question bank
├── lib/
│   ├── auth.js               # scrypt password hashing, session tokens, & allowlist enforcement
│   ├── store.js              # Atomic local JSON + Cloud Storage (GCS) persistence engine
│   └── quiz_importer.js      # Vertex AI (gemini-3.8-flash) generator & CSV/JSON/Markdown parser
├── public/
│   ├── index.html / app.js   # Live Player + Projector Host Stage UI
│   ├── audio.js              # Zero-dependency Web Audio API synthesizer (lobby, ticks, fanfare)
│   ├── styles.css            # Responsive arena theme
│   └── studio.{html,js,css}  # Multi-tenant Creator Studio & Super Admin Access Control UI
├── tests/
│   └── e2e_product_test.js   # Automated 100-player WebSocket + Studio + Auth E2E test suite
├── Dockerfile                # Production Node 24 container image
└── deploy.sh                 # 1-command Cloud Run deployment script
```

---

## 🚀 Local Quickstart

### Prerequisites
- **Node.js 20+** (Node 24 recommended)
- *(Optional, for AI Quiz Generation)* Google Cloud SDK (`gcloud auth application-default login`) with Vertex AI API enabled

### 1. Install & Configure
```bash
npm install
cp .env.example .env
```

Edit `.env` to set your Super Admin credentials and (optionally) your GCP project for Vertex AI:
```dotenv
PORT=8085
SUPERADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=replace-with-strong-password
AUTHORIZED_EMAILS=teammate@example.com
GOOGLE_CLOUD_PROJECT=your-gcp-project-id
```

### 2. Run the Server
```bash
npm start
```
- **Participant Join & Live Stage**: `http://localhost:8085/`
- **Creator Studio & Host Login**: `http://localhost:8085/studio`

---

## 🧪 Running the End-to-End Test Suite

Run the full integration suite (covering Invite-Only Access Control, Guest/Unapproved `403` guards, Super Admin allowlist management, Custom Quiz CRUD, CSV/JSON/Markdown import, Vertex AI generation, and a live **100-player concurrent WebSocket game** through Podium & CSV report export):

```bash
npm test
```

---

## ☁️ Deploying to Google Cloud Run

QuizArena is designed to run on Cloud Run with `--min-instances 1 --max-instances 1 --concurrency 250 --session-affinity` so up to 250 concurrent WebSocket connections share a single in-memory game loop while persisting accounts, quizzes, and session reports to a Google Cloud Storage bucket:

```bash
# 1. Create a GCS bucket for durable state (once per project)
gcloud storage buckets create gs://<YOUR_GCP_PROJECT_ID>-quizarena-data --location=us-central1

# 2. Deploy to Cloud Run
SUPERADMIN_EMAIL="admin@yourdomain.com" \
ADMIN_PASSWORD="your-strong-password" \
./deploy.sh <YOUR_GCP_PROJECT_ID> us-central1
```
