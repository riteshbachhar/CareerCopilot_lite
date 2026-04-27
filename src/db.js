// Minimal IndexedDB wrapper. Five object stores:
//
//   jobs                keyPath 'id'       — JD row metadata + match payload
//   embeddings          keyPath 'jd_id'    — {jd_id, vector: Float32Array, dims}
//   profile_facts       keyPath 'id'       — one atomic claim per row (from profile.md)
//   profile_embeddings  keyPath 'fact_id'  — {fact_id, vector: Float32Array, dims}
//   meta                keyPath 'key'      — small key/value (currently profile_version)
//
// Vectors are stored in separate stores so list/search queries don't
// deserialize Float32Arrays they don't need.

import { JOB_STATUSES, DEFAULT_STATUS } from './constants.js';

const DB_NAME = 'careerpilot-lite';
const DB_VERSION = 2;
const STORE_JOBS = 'jobs';
const STORE_EMBEDDINGS = 'embeddings';
const STORE_PROFILE_FACTS = 'profile_facts';
const STORE_PROFILE_EMBEDDINGS = 'profile_embeddings';
const STORE_META = 'meta';

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      const oldVersion = event.oldVersion ?? 0;
      if (oldVersion < 1) {
        const jobs = db.createObjectStore(STORE_JOBS, { keyPath: 'id' });
        jobs.createIndex('timestamp', 'timestamp');
        db.createObjectStore(STORE_EMBEDDINGS, { keyPath: 'jd_id' });
        const facts = db.createObjectStore(STORE_PROFILE_FACTS, { keyPath: 'id' });
        facts.createIndex('order', 'order');
        facts.createIndex('section', 'section');
        db.createObjectStore(STORE_PROFILE_EMBEDDINGS, { keyPath: 'fact_id' });
        db.createObjectStore(STORE_META, { keyPath: 'key' });
      }
      if (oldVersion < 2) {
        // url index enables dedup on capture. Non-unique because
        // {null, ''} URLs are valid for paste captures and may repeat.
        const jobsStore = req.transaction.objectStore(STORE_JOBS);
        if (!jobsStore.indexNames.contains('url')) {
          jobsStore.createIndex('url', 'url', { unique: false });
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(db, stores, mode) {
  return db.transaction(stores, mode);
}

function wrap(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function uuid() {
  return crypto.randomUUID();
}

export async function addJob({
  url,
  title,
  company,
  raw_text,
  structured_fields,
  model_id,
  model_version,
}) {
  const db = await open();
  const now = Date.now();
  const row = {
    id: uuid(),
    url: url ?? null,
    title: title ?? null,
    company: company ?? null,
    timestamp: now,
    raw_text,
    cleaned_text: null,
    cleaned_at: null,
    structured_fields: structured_fields ?? null,
    model_id,
    model_version,
    status: DEFAULT_STATUS,
    status_history: [{ status: DEFAULT_STATUS, at: now }],
    notes: null,
    follow_up_at: null,
    match_score: null,
    match_facts: null,
    match_computed_at: null,
    match_profile_version: null,
  };
  const t = tx(db, [STORE_JOBS], 'readwrite');
  await wrap(t.objectStore(STORE_JOBS).add(row));
  return row;
}

// Find an existing job by URL. Returns null when no match — used by
// persistCapture to dedup repeat captures of the same listing.
export async function findJobByUrl(url) {
  if (!url) return null;
  const db = await open();
  const t = tx(db, [STORE_JOBS], 'readonly');
  const idx = t.objectStore(STORE_JOBS).index('url');
  const row = await wrap(idx.get(url));
  return row ?? null;
}

export async function deleteJob(id) {
  const db = await open();
  const t = tx(db, [STORE_JOBS, STORE_EMBEDDINGS], 'readwrite');
  await Promise.all([
    wrap(t.objectStore(STORE_JOBS).delete(id)),
    wrap(t.objectStore(STORE_EMBEDDINGS).delete(id)),
  ]);
}

export async function updateJob(id, patch) {
  const db = await open();
  const t = tx(db, [STORE_JOBS], 'readwrite');
  const store = t.objectStore(STORE_JOBS);
  const row = await wrap(store.get(id));
  if (!row) throw new Error(`job not found: ${id}`);
  const next = { ...row, ...patch };
  await wrap(store.put(next));
  return next;
}

export async function setStatus(id, status) {
  if (!JOB_STATUSES.includes(status)) {
    throw new Error(`invalid status: ${status}`);
  }
  const db = await open();
  const t = tx(db, [STORE_JOBS], 'readwrite');
  const store = t.objectStore(STORE_JOBS);
  const row = await wrap(store.get(id));
  if (!row) throw new Error(`job not found: ${id}`);
  // Lazy-seed status_history for legacy v1 rows.
  if (!Array.isArray(row.status_history) || row.status_history.length === 0) {
    row.status_history = [
      { status: row.status ?? DEFAULT_STATUS, at: row.timestamp ?? Date.now() },
    ];
  }
  if (row.status !== status) {
    row.status_history.push({ status, at: Date.now() });
  }
  row.status = status;
  await wrap(store.put(row));
  return row;
}

export async function putEmbedding({ jd_id, vector, dims }) {
  const db = await open();
  const t = tx(db, [STORE_EMBEDDINGS], 'readwrite');
  const buf = vector instanceof Float32Array ? vector : new Float32Array(vector);
  await wrap(t.objectStore(STORE_EMBEDDINGS).put({ jd_id, vector: buf, dims }));
}

export async function getEmbedding(jd_id) {
  const db = await open();
  const t = tx(db, [STORE_EMBEDDINGS], 'readonly');
  return wrap(t.objectStore(STORE_EMBEDDINGS).get(jd_id));
}

export async function getJob(id) {
  const db = await open();
  const t = tx(db, [STORE_JOBS], 'readonly');
  return wrap(t.objectStore(STORE_JOBS).get(id));
}

export async function listJobs() {
  const db = await open();
  const t = tx(db, [STORE_JOBS], 'readonly');
  const store = t.objectStore(STORE_JOBS);
  const rows = await wrap(store.index('timestamp').getAll());
  return rows.sort((a, b) => b.timestamp - a.timestamp);
}

export async function getAllEmbeddings() {
  const db = await open();
  const t = tx(db, [STORE_EMBEDDINGS], 'readonly');
  return wrap(t.objectStore(STORE_EMBEDDINGS).getAll());
}

// Cosine similarity. Vectors are L2-normalized at embed time, so this is
// just a dot product — but we don't rely on that invariant here.
function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

// ---------- Profile facts ----------

export async function addProfileFact({
  section,
  subsection,
  text,
  order,
  model_id,
  model_version,
}) {
  const db = await open();
  const row = {
    id: uuid(),
    section: section ?? null,
    subsection: subsection ?? null,
    text,
    order,
    model_id,
    model_version,
    timestamp: Date.now(),
  };
  const t = tx(db, [STORE_PROFILE_FACTS], 'readwrite');
  await wrap(t.objectStore(STORE_PROFILE_FACTS).add(row));
  return row;
}

export async function putProfileEmbedding({ fact_id, vector, dims }) {
  const db = await open();
  const t = tx(db, [STORE_PROFILE_EMBEDDINGS], 'readwrite');
  const buf = vector instanceof Float32Array ? vector : new Float32Array(vector);
  await wrap(t.objectStore(STORE_PROFILE_EMBEDDINGS).put({ fact_id, vector: buf, dims }));
}

export async function listProfileFacts() {
  const db = await open();
  const t = tx(db, [STORE_PROFILE_FACTS], 'readonly');
  const store = t.objectStore(STORE_PROFILE_FACTS);
  return wrap(store.index('order').getAll());
}

export async function getProfileFact(id) {
  const db = await open();
  const t = tx(db, [STORE_PROFILE_FACTS], 'readonly');
  return wrap(t.objectStore(STORE_PROFILE_FACTS).get(id));
}

export async function countProfileFacts() {
  const db = await open();
  const t = tx(db, [STORE_PROFILE_FACTS], 'readonly');
  return wrap(t.objectStore(STORE_PROFILE_FACTS).count());
}

export async function getAllProfileEmbeddings() {
  const db = await open();
  const t = tx(db, [STORE_PROFILE_EMBEDDINGS], 'readonly');
  return wrap(t.objectStore(STORE_PROFILE_EMBEDDINGS).getAll());
}

export async function clearProfile() {
  const db = await open();
  const t = tx(db, [STORE_PROFILE_FACTS, STORE_PROFILE_EMBEDDINGS], 'readwrite');
  await Promise.all([
    wrap(t.objectStore(STORE_PROFILE_FACTS).clear()),
    wrap(t.objectStore(STORE_PROFILE_EMBEDDINGS).clear()),
  ]);
}

// Mirror of cosineSearch over the profile corpus. Returns {fact_id, score}
// pairs so the caller can hydrate text + breadcrumb from profile_facts.
export async function profileCosineSearch(queryVector, { topK = 8 } = {}) {
  const q = queryVector instanceof Float32Array
    ? queryVector
    : new Float32Array(queryVector);
  const embs = await getAllProfileEmbeddings();
  const scored = embs.map((e) => ({
    fact_id: e.fact_id,
    score: cosine(q, e.vector),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

// ---------- Meta (profile_version etc.) ----------

export async function getProfileVersion() {
  const db = await open();
  const t = tx(db, [STORE_META], 'readonly');
  const row = await wrap(t.objectStore(STORE_META).get('profile_version'));
  return row?.value ?? null;
}

export async function setProfileVersion(value) {
  const db = await open();
  const t = tx(db, [STORE_META], 'readwrite');
  await wrap(t.objectStore(STORE_META).put({ key: 'profile_version', value }));
}

export async function clearProfileVersion() {
  const db = await open();
  const t = tx(db, [STORE_META], 'readwrite');
  await wrap(t.objectStore(STORE_META).delete('profile_version'));
}
