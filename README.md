# GitNoob

**Paste any GitHub link. Download a ready-to-run app.**

GitNoob turns public GitHub repositories—browser games, React/Vite web apps, Node.js servers, and Python applications—into self-contained, double-click packages with embedded portable runtimes (Node.js / Python), native OS launchers, live in-browser preview, and single-file `.html` artifact export. No terminal, no coding, and no runtime installation required for the end user.

## Architecture

- **`shared/contracts.js`** — Shared target OS options (`macos-arm64`, `macos-x64`, `windows-x64`, `linux-x64`), package formats (`bundle-zip`, `single-html`), and 7-stage pipeline definitions.
- **`server/index.js`** — Express API server (`http://localhost:3456`), live SSE progress streaming, artifact downloads, live preview proxy, and SPA static serving.
- **`server/store.js`** — Atomic JSON persistence (`data/catalog.json`) with startup reconciliation for interrupted jobs and analysis caching.
- **`server/jobs.js`** — Asynchronous packaging job orchestrator with per-job event replay buffers so refreshed or late-joining clients receive full build history plus live updates.
- **`server/preview.js`** — Live Artifact Preview Sandbox supporting static apps (with automatic `<base>` / root-relative asset rewriting and iframe safety) and dynamic Node.js/Python apps spawned on ephemeral ports with automatic 15-minute idle reaping.
- **`server/curated.js`** — Verified showcase of 12 real public GitHub repositories across games, web apps, static sites, Node.js, and Python.
- **`server/analyzer/`** — GitHub URL parser, stack/framework detector, `.env.example` parser, and plain-English README summarizer.
- **`server/packager/`** — Portable runtime manager, isolated clone/build pipeline, single-file HTML inliner, native OS launcher generator, automated smoke tester, and ZIP archiver.
- **`client/`** — Monochrome Swiss-editorial React + TypeScript + Vite web application.

## Quick Start

```bash
# 1. Install server dependencies
npm install

# 2. Install & build the frontend
npm --prefix client install
npm run build:client

# 3. Start GitNoob
npm start
```

Open [http://localhost:3456](http://localhost:3456) in your browser.

For frontend development with hot reload:

```bash
# Terminal 1: API server
npm run dev

# Terminal 2: Vite dev server (proxies /api and /preview to :3456)
npm --prefix client run dev
```

## API Endpoints

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/health` | Host diagnostics, Python availability, and runtime cache status |
| `GET` | `/api/curated` | Curated list of instant-try public GitHub repositories |
| `POST` | `/api/analyze` | Inspect a GitHub URL and return plain-English blueprint & stack metadata |
| `POST` | `/api/package` | Enqueue an async packaging job (`202 Accepted`) |
| `GET` | `/api/jobs` | List all packaging jobs (newest first) |
| `GET` | `/api/jobs/:id` | Get status, logs, and artifact details for a specific job |
| `GET` | `/api/jobs/:id/events` | Server-Sent Events stream (`progress`, `log`, `complete`, `error`) |
| `GET` | `/api/jobs/:id/download` | Download `.zip` bundle or `?format=single-html` artifact |
| `POST` | `/api/jobs/:id/preview/start` | Start live preview sandbox and return `/preview/:id/` |
| `POST` | `/api/jobs/:id/preview/stop` | Stop an active dynamic preview process |
| `ALL` | `/preview/:id/*` | Serve static preview or reverse-proxy dynamic app preview |
| `GET` | `/api/runtimes` | Inspect cached portable Node.js and Python runtimes |
| `DELETE` | `/api/jobs/:id` | Delete job record and clean up `data/builds/<id>` and `data/packages/<id>` |
