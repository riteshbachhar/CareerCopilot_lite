// Parse a CSV or JSON backup file into normalized job rows ready for the
// background's import-jobs handler. Pure: no I/O, no embeddings, no IDB.
//
// Output row shape (every field optional except raw_text):
//   {
//     url, title, company,
//     raw_text,                 // required — the importer needs text to re-embed
//     cleaned_text, oneliner,
//     timestamp,                // ms since epoch, or null
//     status,
//     notes, follow_up_at,
//     tags,
//     status_history,           // [{status, at}], or null
//     structured_fields,        // pre-packed object, or null
//   }
//
// Errors are collected per row instead of throwing, so a partial-bad file
// still imports the good rows.

// Strip a BOM if present (some CSV exporters prepend U+FEFF).
function stripBom(s) {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

// Detect format from the first non-whitespace character. Strict: a JSON
// file always starts with [ or { after whitespace; anything else is CSV.
export function detectFormat(text) {
  const trimmed = stripBom(text).trimStart();
  if (!trimmed) return null;
  const c = trimmed[0];
  if (c === '[' || c === '{') return 'json';
  return 'csv';
}

// Minimal RFC-4180 CSV parser. Handles quoted fields, doubled-quote
// escaping, CRLF / LF / CR line endings, and embedded newlines inside
// quoted fields. Returns string[][].
export function parseCsv(text) {
  const src = stripBom(text);
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i++;
        }
      } else {
        field += c;
        i++;
      }
    } else {
      if (c === '"' && field.length === 0) {
        inQuotes = true;
        i++;
      } else if (c === ',') {
        row.push(field);
        field = '';
        i++;
      } else if (c === '\n' || c === '\r') {
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
        if (c === '\r' && src[i + 1] === '\n') i += 2;
        else i++;
      } else {
        field += c;
        i++;
      }
    }
  }
  // Tail field/row — only if there's anything to flush. Avoids appending
  // an empty trailing row when the file ends with a newline.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function emptyToNull(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
}

function parseEpoch(v) {
  if (v == null || v === '') return null;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
}

function parseStatusHistory(v) {
  if (!v) return null;
  // Export shape: "status@iso › status@iso › ..."
  const parts = String(v)
    .split(/\s*›\s*/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (!parts.length) return null;
  const out = [];
  for (const p of parts) {
    const at = p.indexOf('@');
    if (at <= 0) continue;
    const status = p.slice(0, at).trim();
    const at_ms = Date.parse(p.slice(at + 1).trim());
    if (!status || !Number.isFinite(at_ms)) continue;
    out.push({ status, at: at_ms });
  }
  return out.length ? out : null;
}

function packStructuredFields(record) {
  const sf = {};
  if (record.location) sf.location = record.location;
  if (record.seniority) sf.seniority = record.seniority;
  if (record.employment_type) sf.employment_type = record.employment_type;
  if (record.remote) sf.remote = record.remote;
  if (record.date_posted) sf.date_posted = record.date_posted;
  if (record.source) sf.source = record.source;
  // salary on CSV export is the human-formatted chip text; preserve as a
  // free-form string so re-export round-trips it. Round-tripping the full
  // structured salary object would need its own column set.
  if (record.salary) sf.salary_label = record.salary;
  return Object.keys(sf).length ? sf : null;
}

// CSV row → normalized row. record is a plain object keyed by header.
function normalizeCsvRecord(record) {
  const url = emptyToNull(record.url);
  const raw_text = emptyToNull(record.raw_text);
  return {
    url,
    title: emptyToNull(record.title),
    company: emptyToNull(record.company),
    raw_text: raw_text ?? '',
    cleaned_text: null,
    oneliner: null,
    timestamp: parseEpoch(record.captured_at),
    status: emptyToNull(record.status),
    notes: emptyToNull(record.notes),
    follow_up_at: parseEpoch(record.follow_up_at),
    tags: [],
    status_history: parseStatusHistory(record.status_history),
    structured_fields: packStructuredFields(record),
  };
}

// JSON row → normalized row. The JSON export already produces near-final
// shape; this just defends against missing fields and bad types.
function normalizeJsonRow(row) {
  if (!row || typeof row !== 'object') return null;
  const raw_text = typeof row.raw_text === 'string' ? row.raw_text : '';
  return {
    url: emptyToNull(row.url),
    title: emptyToNull(row.title),
    company: emptyToNull(row.company),
    raw_text,
    cleaned_text: typeof row.cleaned_text === 'string' ? row.cleaned_text : null,
    oneliner: typeof row.oneliner === 'string' ? row.oneliner : null,
    timestamp: typeof row.timestamp === 'number' ? row.timestamp : parseEpoch(row.captured_at),
    status: emptyToNull(row.status),
    notes: typeof row.notes === 'string' ? row.notes : null,
    follow_up_at:
      typeof row.follow_up_at === 'number'
        ? row.follow_up_at
        : parseEpoch(row.follow_up_at),
    tags: Array.isArray(row.tags) ? row.tags.filter((t) => typeof t === 'string') : [],
    status_history: Array.isArray(row.status_history)
      ? row.status_history
          .filter(
            (h) => h && typeof h.status === 'string' && typeof h.at === 'number',
          )
          .map((h) => ({ status: h.status, at: h.at }))
      : parseStatusHistory(row.status_history),
    structured_fields:
      row.structured_fields && typeof row.structured_fields === 'object'
        ? row.structured_fields
        : null,
  };
}

export function parseImportText(text, { format } = {}) {
  const errors = [];
  const rows = [];
  if (typeof text !== 'string' || !text.trim()) {
    errors.push({ where: 'input', message: 'empty input' });
    return { rows, errors, format: null };
  }
  const fmt = format ?? detectFormat(text);
  if (fmt === 'json') {
    let parsed;
    try {
      parsed = JSON.parse(stripBom(text));
    } catch (err) {
      errors.push({ where: 'json', message: `parse failed: ${err.message}` });
      return { rows, errors, format: 'json' };
    }
    if (!Array.isArray(parsed)) {
      errors.push({
        where: 'json',
        message: 'top-level value must be an array of job rows',
      });
      return { rows, errors, format: 'json' };
    }
    parsed.forEach((row, i) => {
      const normalized = normalizeJsonRow(row);
      if (!normalized) {
        errors.push({ where: `row ${i}`, message: 'not an object' });
        return;
      }
      if (!normalized.raw_text) {
        errors.push({ where: `row ${i}`, message: 'missing raw_text — cannot re-embed' });
        return;
      }
      rows.push(normalized);
    });
    return { rows, errors, format: 'json' };
  }
  if (fmt === 'csv') {
    const lines = parseCsv(text);
    if (!lines.length) {
      errors.push({ where: 'csv', message: 'no rows' });
      return { rows, errors, format: 'csv' };
    }
    const headers = lines[0].map((h) => h.trim());
    if (!headers.length || !headers.includes('raw_text')) {
      errors.push({
        where: 'csv',
        message: 'header row must include raw_text column',
      });
      return { rows, errors, format: 'csv' };
    }
    for (let i = 1; i < lines.length; i++) {
      const cells = lines[i];
      // Skip blank lines silently — they're a common artifact of editors.
      if (cells.length === 1 && cells[0].trim() === '') continue;
      const record = {};
      for (let j = 0; j < headers.length; j++) {
        record[headers[j]] = cells[j] ?? '';
      }
      const normalized = normalizeCsvRecord(record);
      if (!normalized.raw_text) {
        errors.push({
          where: `row ${i}`,
          message: 'empty raw_text — cannot re-embed',
        });
        continue;
      }
      rows.push(normalized);
    }
    return { rows, errors, format: 'csv' };
  }
  errors.push({ where: 'input', message: `unrecognized format: ${fmt}` });
  return { rows, errors, format: fmt };
}
