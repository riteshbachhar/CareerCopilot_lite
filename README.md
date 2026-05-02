# Career Copilot Lite

Local-first job tracker Chrome extension with profile-grounded match scoring.

Capture a job posting from any tab, embed it locally, and score it against your own profile facts. Optional, BYOK on-demand LLM cleanup reorganizes scraped JD bodies into clean markdown sections and produces a one-line role summary used as the row preview. No data leaves the browser unless you opt in to the cleanup call.

## What it does

- **Capture** any job page via the toolbar icon — generic JSON-LD extractor with Readability + DOM-text fallbacks. Works on Greenhouse, Lever, Ashby, Workable, Interfolio, and most branded ATSes.
- **Track** captured jobs with status (interested / applied / interviewing / offer / rejected / archived), filters, tags, notes, and follow-up dates.
- **Match** each JD against your ingested profile using local sentence embeddings (`all-MiniLM-L6-v2`, 384-dim, runs in-browser via ONNX Runtime Web). The JD is split into atomic requirement-shaped chunks and each chunk is scored against the profile; the score is the mean of per-chunk best matches. Detail view groups by JD chunk into Strong matches and Gaps so you can see what the profile covers and what it doesn't.
- **Enhance** (optional, BYOK): one click runs the captured `raw_text` through Groq, gets back a cleaned markdown version of the body plus a short factual one-liner used as the row preview. The original `raw_text` is preserved alongside the cleaned text — both are viewable.

## Tech stack

- Manifest V3 Chrome extension. Three contexts (side panel, background service worker, offscreen document).
- esbuild for bundling. No framework — vanilla JS + IndexedDB.
- `@huggingface/transformers` (`all-MiniLM-L6-v2` quantized to int8) for embeddings. ONNX Runtime Web bundled locally so first-run model download is the only network hop.
- `@mozilla/readability` injected as a classic script for the Readability fallback.
- `pdfjs-dist` for resume PDF extraction in the offscreen doc.
- Groq API (`llama-3.1-8b-instant` default, `llama-3.3-70b-versatile` recommended for cleanup) — only called for cleanup and resume parsing, both gated behind a BYOK key.

## Install

Prerequisite: Node 18+ and a Chromium-based browser (Chrome, Edge, Brave, Arc).

```bash
npm install
npm run build      # one-shot build into dist/
npm run watch      # rebuild on file changes (recommended during dev)
```

Then load the extension:

1. Visit `chrome://extensions`.
2. Enable **Developer mode** (toggle in the top right).
3. Click **Load unpacked** and select the `dist/` folder at the repo root.
4. Pin the toolbar icon. Clicking it opens the side panel.

After rebuilds, click the **reload** icon on the extension's card. The IndexedDB database (`careerpilot-lite`) survives rebuilds — only clicking **Remove** on the card wipes captured jobs and the ingested profile.

## How to use

### 1. Ingest your profile (one-time)

Match scoring needs a profile. Open the side panel and click the **Profile** drawer (person icon). Two ways to load it:

- **Paste markdown** — see [`atomic_facts.md`](atomic_facts.md) for the expected shape (`## Section` / `### Subsection` / bullet facts). Hand-curated and most accurate.
- **Upload a resume** (PDF or `.txt`) — requires a Groq key (see step 2). The LLM splits the resume into atomic facts; the text of each fact stays verbatim from the resume.

Either path runs every fact through the local embedding model. Watch the progress bar; first run downloads the model (~23 MB, cached).

To update later: re-ingest. Existing match chips immediately strikethrough as stale, and a **Recompute** banner offers a one-click refresh of all rows.

### 2. (Optional) Add a Groq key for LLM features

Open the **Settings** drawer (gear icon). Paste a Groq API key, toggle the feature on, save. The key is stored in `chrome.storage.local`. The key powers two things and nothing else:

- **JD cleanup** — reorganizes captured `raw_text` into clean markdown, drops CTAs and boilerplate, returns a one-line role summary used as the row preview.
- **Resume parsing** — splits an uploaded resume into atomic facts.

Capture and matching work fully offline without a key.

### 3. Capture a job posting

Two ways:

- **Capture current tab** — navigate to a job posting and click the button in the side panel. The generic JSON-LD + Readability + DOM-text extractor handles Greenhouse, Lever, Ashby, Workable, LinkedIn, and most branded ATSes including Greenhouse-embedded boards.
- **Paste JD text** — paste the body into the textbox and submit. Useful when extraction fails on an oddly-structured page.

Each capture chunks the JD into atomic requirement-shaped pieces, embeds each chunk locally, scores it against your profile, and stores the row. First capture is ~3–8s (one-time model warm-up); subsequent captures are sub-second.

### 4. Read the match

Each row shows a colored chip: green = strong, yellow = medium, red = weak / no profile match. Click a row to open the detail view, which groups by JD chunk:

- **Strong matches** — JD chunks with a confident profile fact behind them, with the matched fact shown.
- **Gaps** — JD chunks that have no strong profile match. These are what to address in a cover letter or skill build-up.

The score itself is a section-weighted mean of per-chunk best matches: requirements / qualifications count 1.25×, nice-to-have / preferred / bonus count 0.75×, everything else 1.0×.

### 5. Track and manage

- **Status picker** on each row: interested → applied → interviewing → offer / rejected → archived.
- **Filters** at the top: free-text search and status filter.
- **Per-row** in the detail view: notes, tags, follow-up date, edit (forces re-embed), delete (wipes both the row and its embeddings).
- **Recompute match** in the detail view rescore a single row without re-embedding.

### 6. (Optional) Clean up the JD

In the detail view, click **Clean up JD ✨**. Groq returns a reorganized markdown version of the body (Responsibilities / Requirements / Benefits sections, no CTAs) plus a short factual one-liner that becomes the row preview. The original `raw_text` is preserved alongside the cleaned text — both are viewable. After cleanup, the row is automatically re-chunked and rescored against the now-better-structured body.

### Troubleshooting

- **First capture fails with "Failed to fetch"** — open the offscreen DevTools (extension card → click `offscreen.html`) and check for `[embed fetch] FAILED <url>`. Usually a CSP miss for a Hugging Face host.
- **"Cannot access contents of the page"** — the `<all_urls>` host grant wasn't accepted at install. Reload the extension and accept the prompt.
- **Match chip never appears** — you haven't ingested a profile yet, or the profile is empty.
- **All chips show stale after profile re-ingest** — expected. Click **Recompute** in the banner.

## Repository layout

```
manifest.json          MV3 manifest
build.mjs              esbuild + static-file copy
atomic_facts.md        Sample profile demonstrating the markdown format
src/
  background.js        Service worker — owns IndexedDB, message routing, capture pipeline
  offscreen.js         Long-lived DOM context — hosts transformers.js + pdf.js
  embed.js             Embedding pipeline (loaded by offscreen)
  sidepanel.html|js    UI — talks only to the background SW
  match.js             Simple top-K-mean baseline (locked, kept for reference)
  match-coverage.js    Active scorer: JD-chunk asymmetric coverage
  chunk-jd.js          Splits a JD into atomic requirement-shaped chunks
  db.js                IndexedDB wrapper
  constants.js         Model ID, embedding dims, status enums
  adapters/
    json-ld.js         Generic JD extractor (runs in target page)
  llm/
    groq-client.js     Cleanup / resume-extraction / connection-test
    settings.js        BYOK settings in chrome.storage.local
  profile/
    parse-markdown.js  Markdown profile -> atomic facts
    parse-resume.js    Validator for LLM resume-extraction output
  readability-inject.js  IIFE wrapper around @mozilla/readability
tests/                 Node test runner — pure-function tests
```

## Documentation

- [`CLAUDE.md`](CLAUDE.md) — design decisions, scope boundaries, and the rules for working in this repo. Read this before changing the architecture.

## Relation to the parent project

This is a sibling to `../CareerPilot`, not a fork. It exists separately so the tracker + match loop can be dogfooded independently of the rewrite / cover-letter / eval workstreams. If you need the model to author or rewrite content (cover letters, application drafts, summaries), open the parent. If you need anything tracker-, capture-, match-, or filter-and-reorganize-shaped, work here.

## Permissions

`<all_urls>` — required for the generic extractor to reach any job page. Dev-mode tradeoff; will migrate to `optional_host_permissions` + per-origin requests before any Chrome Web Store submission.

`api.groq.com` is the only outbound LLM endpoint, used solely for the on-demand cleanup and resume-parsing calls.

## License

MIT © 2026 Ritesh Bachhar
