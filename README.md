# Career Copilot Lite

Local-first job tracker Chrome extension with profile-grounded match scoring.

Capture a job posting from any tab, embed it locally, and score it against your own profile facts. Optional, BYOK on-demand LLM cleanup reorganizes scraped JD bodies into clean markdown sections and produces a one-line role summary used as the row preview. No data leaves the browser unless you opt in to the cleanup call.

## What it does

- **Capture** any job page via the toolbar icon — generic JSON-LD extractor with Readability + DOM-text fallbacks. Works on Greenhouse, Lever, Ashby, Workable, Interfolio, and most branded ATSes.
- **Track** captured jobs with status (interested / applied / interviewing / offer / rejected / archived), filters, tags, notes, and follow-up dates.
- **Match** each JD against your ingested profile using local sentence embeddings (`all-MiniLM-L6-v2`, 384-dim, runs in-browser via ONNX Runtime Web). Score is the mean cosine of the top-10 matched facts; surfaces as a colored chip on each row plus a full breakdown in detail view.
- **Enhance** (optional, BYOK): one click runs the captured `raw_text` through Groq, gets back a cleaned markdown version of the body plus a short factual one-liner used as the row preview. The original `raw_text` is preserved alongside the cleaned text — both are viewable.

## Tech stack

- Manifest V3 Chrome extension. Three contexts (side panel, background service worker, offscreen document).
- esbuild for bundling. No framework — vanilla JS + IndexedDB.
- `@huggingface/transformers` (`all-MiniLM-L6-v2` quantized to int8) for embeddings. ONNX Runtime Web bundled locally so first-run model download is the only network hop.
- `@mozilla/readability` injected as a classic script for the Readability fallback.
- `pdfjs-dist` for resume PDF extraction in the offscreen doc.
- Groq API (`llama-3.1-8b-instant` default, `llama-3.3-70b-versatile` recommended for cleanup) — only called for cleanup and resume parsing, both gated behind a BYOK key.

## Install (development)

```bash
npm install
npm run build      # one-shot
npm run watch      # rebuild on changes (recommended)
```

Then in Chrome:

1. Visit `chrome://extensions`.
2. Enable Developer mode (top right).
3. Click **Load unpacked** and select the `dist/` folder.
4. Pin the toolbar icon. Clicking it opens the side panel.

After rebuilds, click the reload icon on the extension's card.

## Quick smoke test

1. Open the side panel, then the **Profile** drawer (the person icon). Paste a markdown profile or upload a resume PDF / text file. The progress bar fills as facts are embedded.
2. Navigate to any job posting (try Greenhouse, Lever, Ashby, or a branded careers page) and click **Capture current tab**.
3. The captured row should appear with a title, a colored match-score chip, and a status picker. Click it for the detail view.
4. Optional: click **Clean up JD** to run the LLM enhancement (requires a Groq key in Settings). The row preview switches to the LLM-generated one-liner.

## Repository layout

```
manifest.json          MV3 manifest
build.mjs              esbuild + static-file copy
src/
  background.js        Service worker — owns IndexedDB, message routing, capture pipeline
  offscreen.js         Long-lived DOM context — hosts transformers.js + pdf.js
  embed.js             Embedding pipeline (loaded by offscreen)
  sidepanel.html|js    UI — talks only to the background SW
  match.js             Profile match scoring (mean top-K cosine)
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
- [`study.md`](study.md) — guided tour of the tech stack and end-to-end workflows (capture, embed, match, ingest, enhance). Read this if you want to understand how the pieces fit together.

## Relation to the parent project

This is a sibling to `../CareerPilot`, not a fork. It exists separately so the tracker + match loop can be dogfooded independently of the rewrite / cover-letter / eval workstreams. If you need the model to author or rewrite content (cover letters, application drafts, summaries), open the parent. If you need anything tracker-, capture-, match-, or filter-and-reorganize-shaped, work here.

## Permissions

`<all_urls>` — required for the generic extractor to reach any job page. Dev-mode tradeoff; will migrate to `optional_host_permissions` + per-origin requests before any Chrome Web Store submission.

`api.groq.com` is the only outbound LLM endpoint, used solely for the on-demand cleanup and resume-parsing calls.

## License

Private. Not yet published.
