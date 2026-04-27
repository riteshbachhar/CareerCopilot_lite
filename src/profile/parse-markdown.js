// Parse profile.md into atomic facts.
//
// The profile is already authored as one-claim-per-bullet, so chunking is
// literally: every top-level `-` bullet under an H2 (and optional H3) is a
// fact. We record the section + subsection breadcrumb because a bullet like
// "Primary language: Python." is only meaningful when you know which project
// it belongs to.
//
// Rules:
//   - `## X` sets the current section.
//   - `### X` sets the current subsection.
//   - `- text` under those headings is one fact.
//   - Bullets inside blockquotes (`> - …`) are ignored — they're authoring
//     conventions, not claims.
//   - Bullets starting with `[ADD]` are placeholder gaps and are skipped.
//     `[VERIFY]`-prefixed bullets are kept; they're flagged but still content.
//   - Bullets starting with `[ ]` / `[x]` are treated as task-list items
//     (the author's own todos / gap trackers) and are skipped.
//   - HTML comments (`<!-- ... -->`, possibly multi-line) are stripped before
//     parsing, so commented-out sections never contribute facts.

const H2_RE = /^##\s+(.+?)\s*$/;
const H3_RE = /^###\s+(.+?)\s*$/;
const BULLET_RE = /^-\s+(.+?)\s*$/;
const ADD_MARKER_RE = /^\[ADD\]/i;
const CHECKBOX_RE = /^\[[ xX]\]/;
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;

export function parseProfileMarkdown(md) {
  const cleaned = String(md ?? '').replace(HTML_COMMENT_RE, '');
  const lines = cleaned.split(/\r?\n/);
  const facts = [];
  let section = null;
  let subsection = null;
  let order = 0;

  for (const raw of lines) {
    const line = raw.replace(/ /g, ' ');

    const h2 = line.match(H2_RE);
    if (h2) {
      section = h2[1].trim();
      subsection = null;
      continue;
    }

    const h3 = line.match(H3_RE);
    if (h3) {
      subsection = h3[1].trim();
      continue;
    }

    const bullet = line.match(BULLET_RE);
    if (!bullet) continue;

    const text = bullet[1].trim();
    if (!text) continue;
    if (ADD_MARKER_RE.test(text)) continue;
    if (CHECKBOX_RE.test(text)) continue;

    facts.push({
      section,
      subsection,
      text,
      order: order++,
    });
  }

  return facts;
}
