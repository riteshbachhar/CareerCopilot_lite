# Improvements to make CareerPilot Lite a good job tracker

## Context

CareerPilot Lite ships a working capture → embed → match → status loop, but its **tracker side is thin**. Today a job row carries title/company/location/seniority/url/status/match plus the raw JD — nothing else. The status picker has six values but **no history, no timestamps, no follow-up date, no notes**. The list view is a flat reverse-chronological feed with text + status filter and no sort options. There is no dedup, no pipeline summary, no export.

For someone actually using this to track a job search (the stated point of the project — dogfood the tracker + match loop), several of those gaps hurt every day. CLAUDE.md is firm that LLM/rewrite features are out of scope, but **everything below is purely tracker-shaped — no model calls, no prompts, no provider keys** — so it sits squarely inside the project's charter.

The plan is tiered so we can land Tier 1 first as a coherent bundle and then evaluate.

---

## Tier 1 — Core tracker gaps (high value, low complexity)

These changes turn the current "captured list with status" into a real tracker. They share infrastructure (one schema migration, one edit-form pass, one render pass) so doing them together is cheaper than doing them sequentially.

### 1.1 Per-JD notes field
- Add `notes: string | null` to the `jobs` row.
- Add a `<textarea>` to the edit form in the detail view (`src/sidepanel.js`).
- Render notes (escaped) above the match section in detail view.
- **Do NOT include `notes` in `buildEmbedText`** (`src/background.js:67`) — notes are metadata, not JD content; including them would poison the JD vector. Editing notes therefore should *not* trigger re-embed or re-match.
- Make notes searchable by adding the field to the filter loop in `renderJobsList` (`src/sidepanel.js:186–215`).

### 1.2 Status history with timestamps
- Add `status_history: [{status, at}]` to the row, appended on every status change in `setStatus` (`src/db.js`). Append only when the status actually changes.
- Lazy-migrate existing rows on first read: if `status_history` is missing, seed it with `[{status: row.status, at: row.timestamp}]`.
- Detail view: render a small timeline strip ("interested → applied 3d ago → interviewing today").
- Unlocks Tier 1.7 (pipeline stats) and a future "time-in-stage" view.

### 1.3 Follow-up date and reminder chip
- Add `follow_up_at: number | null` (epoch ms).
- Edit form gets a `<input type="date">`; list row renders a 📅 chip; chip turns red when `follow_up_at < now`.
- New filter mode "Needs follow-up" alongside the existing status dropdown.
- New sort option (see 1.6) by follow-up date.

### 1.4 Richer JSON-LD fields (capture-time, basically free)
- Extend `extractJobPostingFromPage` in `src/adapters/json-ld.js` to pull `baseSalary` (with currency + min/max range), `validThrough`, and `jobLocationType` (TELECOMMUTE → "remote"). `employmentType` and `datePosted` already extracted today.
- Stash on `structured_fields` (already a free-form sub-object — no schema churn).
- Render as chips in the detail header.

### 1.5 Dedup on capture
- Add a `url` index to the `jobs` store in `src/db.js`. (Schema bump — see migration note below.)
- Before `addJob` in `persistCapture` (`src/background.js`), look up by URL. On hit: skip insert, return the existing row id, and surface a `{deduped: true, id}` flag back to the side panel so it can scroll-to / open the existing row instead of adding a phantom duplicate.
- URL-only dedup is the safe baseline (title+company fuzzy is post-Tier 1).

### 1.6 Sort options
- Add a sort `<select>` next to the existing filter controls in `src/sidepanel.html`.
- Options: Recently captured (default, current behavior), Match score (desc), Follow-up date (asc, nulls last), Status (custom order: interviewing → offer → applied → interested → rejected → archived).
- Implementation is a single comparator switch in `renderJobsList`; the list is already fully in memory.

### 1.7 Pipeline summary strip
- A thin chip strip above the list: `Interested 12 · Applied 5 · Interviewing 2 · Offer 1 · Rejected 8 · Archived 3`.
- Counts are computed from the same `getAllJobs` payload `renderJobsList` already loads — no extra query.
- Clicking a chip sets the status filter dropdown to that value (deep-link the existing control, don't fork it).

### 1.8 CSV / JSON export
- "Export" button in the profile drawer.
- Generates a Blob with `URL.createObjectURL` and triggers download. Reuses `listJobs` from `src/db.js`.
- Include all row fields except `match_facts` (id-only, useless on export) and the embedding (lives in a separate store anyway).
- Toggle to redact `raw_text` for share-with-mentor scenarios.

### ~~1.9 Source-tracking bug~~ — verified not a bug

On a closer read: `persistCapture` does `source: source ?? 'paste'`. The `capture-tab` path passes `extracted.jd` whose `source` is set to `'json-ld'` / `'readability'` / `'dom-text'` by the extractor. The `?? 'paste'` is a default for the paste path only. The current source field is already richer than just paste/tab — it tags the extraction method too. No fix needed.

---

## Tier 2 — Power-user (defer, but design-compatible with Tier 1)

These are valuable but not what makes the tracker "good"; they make it "great." Each is intentionally a separate module per CLAUDE.md ("extensions go in new modules; don't add complexity to `src/match.js` itself").

- **Tags** — `tags: string[]` on the row, free-form chip input, AND-filter in list.
- **Recruiter / contact** — `{name, email, last_contact_at}` sub-object.
- **Attachments** — files (resume version, offer letter PDF) stored in IndexedDB as Blobs in a new `attachments` store. Cache API rule applies only to model weights.
- **Time-in-stage stats** — derived from `status_history`; offer/interview funnel ratios.
- **Per-row "open original" button** — one-click back to `url`.
- **Status keyboard shortcuts** in detail view.

## Tier 3 — Nice-to-have (probably not worth it)

- Calendar integration (export `.ics`).
- Browser notifications for follow-up dates (`chrome.alarms` + notification permission).
- Fuzzy dedup on (title+company) — error-prone; URL dedup covers ~95%.
- Multi-select bulk actions (status change, delete, tag).

## Out of scope (CLAUDE.md)

- Cover letter or rewrite UI (parent project).
- Recruiter outreach drafts (parent project).
- Eval harness (parent project).
- BYOK / API key drawer (parent project).
- Semantic JD search across the corpus (explicitly out of scope per CLAUDE.md).

---

## Critical files to modify (Tier 1)

| File | Change |
|------|--------|
| `src/db.js` | Schema bump v1→v2: add `url` index. New `findByUrl` helper. `setStatus` appends to `status_history` (lazy-seed). `updateJob` accepts notes / follow_up_at patches. |
| `src/background.js` | `persistCapture`: dedup-by-URL (return `{deduped, id}` on hit). New `update-meta` handler for metadata-only edits that skips re-embed. Confirm `buildEmbedText` ignores notes. |
| `src/adapters/json-ld.js` | Extract `baseSalary`, `validThrough`, `jobLocationType`. |
| `src/sidepanel.html` | Sort select, pipeline chip strip, new edit-form fields (notes textarea, follow-up date input), export button. CSS for follow-up chip + structured-field chips + status timeline. |
| `src/sidepanel.js` | Sort comparator, pipeline counts, follow-up chip render, dedup highlight, status-history timeline render, export handler, notes textarea + follow-up date input in edit form, extend filter loop to include `notes`. |
| `src/constants.js` | `SORT_MODES`; `STATUS_ORDER` for the "Status" sort option. |

## Reusable utilities (already exist — do not reinvent)

- `tx()` / `wrap()` IndexedDB wrappers — `src/db.js:45–54`.
- `send()` message dispatch — `src/sidepanel.js:58–60`.
- `escapeHtml()` for safe render — `src/sidepanel.js:66–71`.
- `matchTier()` for chip color logic — `src/sidepanel.js:76–81`. Same pattern (tier function → CSS class) for the follow-up chip.
- `renderJobsList` filter loop — `src/sidepanel.js:186–215`. Extend in place; do not duplicate.
- `listJobs` for both list render and export — `src/db.js:144`.

## Schema-migration note

The IndexedDB v1 layout in CLAUDE.md is committed; bumping to v2 requires the standard `onupgradeneeded` path in `open()`. Concretely:
- New fields (`notes`, `status_history`, `follow_up_at`) are nullable, so no rewrite of existing rows is needed at upgrade time. They get filled in lazily on first read or first edit.
- The new `url` index does require an `objectStore.createIndex('url', 'url', {unique: false})` inside the `onupgradeneeded` callback for the v1→v2 path.
- `model_id` / `model_version` invariant is untouched.

## Verification

End-to-end, in order:

1. `npm run build`, then reload the unpacked extension in `chrome://extensions`. Existing IndexedDB data must survive (smoke-test by opening the side panel: prior captures and profile facts still present).
2. **Notes**: open an existing capture → add a note → save → confirm match score did NOT change (if it did, notes leaked into the embed text). Reopen the row, confirm note persisted. Search for a unique word from the note in the filter box, confirm the row matches.
3. **Status history**: change status of an existing row from "interested" to "applied". Detail view shows the two-step timeline. Change again to "interviewing"; timeline appends.
4. **Follow-up**: set a follow-up date 2 days out → 📅 chip renders on the row. Set one in the past → chip renders red. Sort by follow-up → overdue rows surface at top.
5. **Salary / employment type**: capture a Greenhouse or Ashby JD with a posted salary range. Confirm the value renders in the detail header.
6. **Dedup**: capture the same Greenhouse URL twice. Second capture should open / highlight the existing row, not create a duplicate.
7. **Sort + pipeline**: with ≥10 captures across statuses, switch sort to "Match score". Click each pipeline chip and confirm the status filter follows. Confirm counts in the strip add up to total rows.
8. **Export**: click Export → CSV downloads → open in a spreadsheet, headers + rows present. Repeat for JSON. With redact-raw_text on, confirm the column is blank.
9. **Negative**: edit notes only on a JD with no profile ingested → confirm no spurious "match recompute" telemetry in the service worker console.
10. **Migration**: load an extension that already has v1 data → confirm v1→v2 upgrade runs cleanly, the `url` index is created, and existing rows still render without errors.
11. `npm test` — `tests/parse-markdown.test.js` should still pass (no profile-ingestion changes).
