# learn-codex web

Interactive docs and visualization site for **learn-codex** — a course that rebuilds a
Codex-style coding-agent harness one mechanism at a time, in TypeScript, across 20
progressive chapters (`s01` → `s20`).

The site renders each chapter's `code.ts`, README (Chinese source + English translation),
an agent-loop simulator, an execution-flow diagram, and a stepped concept visualization.

## Stack

- [Next.js](https://nextjs.org) (App Router) + React 19 + TypeScript
- Tailwind CSS v4
- Bilingual: `en` and `zh` (route prefix `/en`, `/zh`)

## Develop

```bash
npm install
npm run dev        # predev runs `npm run extract` first
```

Open <http://localhost:3000> — it redirects to `/en`.

## Content extraction

`npm run extract` (also wired into `predev` / `prebuild`) runs
`scripts/extract-content.ts`, which scans the repo root for `sNN_*` chapter folders and:

- reads each `code.ts` to extract classes, functions, registered tools, and LOC
- reads each chapter's `README.md` (zh) and `README.en.md` (en)
- copies chapter `images/*.svg` into `public/course-assets/`
- writes `src/data/generated/versions.json` and `docs.json`, and computes per-step diffs

Run it again whenever a chapter changes.

## Build

```bash
npm run build      # prebuild runs `npm run extract` first
npm run start
```
