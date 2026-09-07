// Minimal IndexedDB wrapper. Seven object stores:
//
//   jobs                  keyPath 'id'                        — JD row metadata + match payload
//   embeddings            keyPath 'jd_id'                     — legacy whole-JD vector (dormant)
//   jd_chunk_embeddings   keyPath ['jd_id', 'chunk_index']    — per-chunk JD vectors used for match
//   profiles              keyPath 'id'                        — {id, name, short_label, version, created_at}
//   profile_facts         keyPath 'id'                        — one atomic claim per row, scoped by profile_id
//   profile_embeddings    keyPath 'fact_id'                   — {fact_id, profile_id, vector: Float32Array, dims}
//   meta                  keyPath 'key'                       — small key/value (currently default_profile_id)
//
// Vectors are stored in separate stores so list/search queries don't
// deserialize Float32Arrays they don't need.
//
// Multi-profile: each profile holds its own facts + embeddings, scoped via
// the profile_id column / index. Each JD row remembers which profile its
// cached match score was computed against (match_profile_id) so freshness
// can be detected across both profile-version bumps and profile switches.
//
// JD chunks: match scoring embeds the JD as a list of atomic chunks rather
// than one whole-JD vector. The legacy `embeddings` store stays around for
// any old rows still pointing to it but is not written by the current path.

import { JOB_STATUSES, DEFAULT_STATUS } from './constants.js';

const DB_NAME = 'careerpilot-lite';
const DB_VERSION = 4;
const STORE_JOBS = 'jobs';
const STORE_EMBEDDINGS = 'embeddings';
const STORE_JD_CHUNK_EMBEDDINGS = 'jd_chunk_embeddings';
const STORE_PROFILES = 'profiles';
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
      if (oldVersion < 3) {
        // Multi-profile schema:
        //   - new `profiles` store
        //   - profile_id index on facts and embeddings
        //   - replace global meta.profile_version with per-profile versions
        //   - migrate any existing profile data into one default 'My Profile'
        const profiles = db.createObjectStore(STORE_PROFILES, { keyPath: 'id' });
        profiles.createIndex('created_at', 'created_at');

        const factsStore = req.transaction.objectStore(STORE_PROFILE_FACTS);
        if (!factsStore.indexNames.contains('profile_id')) {
          factsStore.createIndex('profile_id', 'profile_id', { unique: false });
        }
        const embsStore = req.transaction.objectStore(STORE_PROFILE_EMBEDDINGS);
        if (!embsStore.indexNames.contains('profile_id')) {
          embsStore.createIndex('profile_id', 'profile_id', { unique: false });
        }

        // Data backfill (queued on the upgrade tx so it stays open until done).
        const upTx = req.transaction;
        const factsAllReq = upTx.objectStore(STORE_PROFILE_FACTS).getAll();
        factsAllReq.onsuccess = () => {
          if (!factsAllReq.result.length) return; // empty install — nothing to migrate
          const metaGet = upTx.objectStore(STORE_META).get('profile_version');
          metaGet.onsuccess = () => {
            const oldVer = metaGet.result?.value ?? String(Date.now());
            const defaultId = crypto.randomUUID();
            upTx.objectStore(STORE_PROFILES).add({
              id: defaultId,
              name: 'My Profile',
              short_label: 'MINE',
              version: oldVer,
              created_at: Date.now(),
            });
            upTx.objectStore(STORE_META).put({
              key: 'default_profile_id',
              value: defaultId,
            });
            upTx.objectStore(STORE_META).delete('profile_version');

            for (const f of factsAllReq.result) {
              f.profile_id = defaultId;
              upTx.objectStore(STORE_PROFILE_FACTS).put(f);
            }
            const embsAllReq = upTx.objectStore(STORE_PROFILE_EMBEDDINGS).getAll();
            embsAllReq.onsuccess = () => {
              for (const e of embsAllReq.result) {
                e.profile_id = defaultId;
                upTx.objectStore(STORE_PROFILE_EMBEDDINGS).put(e);
              }
            };
            const jobsAllReq = upTx.objectStore(STORE_JOBS).getAll();
            jobsAllReq.onsuccess = () => {
              for (const j of jobsAllReq.result) {
                if (j.match_score != null && j.match_profile_id == null) {
                  j.match_profile_id = defaultId;
                  upTx.objectStore(STORE_JOBS).put(j);
                }
              }
            };
          };
        };
      }
      if (oldVersion < 4) {
        // JD chunk embeddings. Composite key (jd_id, chunk_index) so all
        // chunks for one JD live together; jd_id index lets us getAll for
        // scoring and delete-cascade. Existing rows have no chunks yet —
        // they re-embed lazily on the next match recompute.
        const chunks = db.createObjectStore(STORE_JD_CHUNK_EMBEDDINGS, {
          keyPath: ['jd_id', 'chunk_index'],
        });
        chunks.createIndex('jd_id', 'jd_id', { unique: false });
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
  // Optional: capture-time cleanup may have already produced these. Callers
  // that skip cleanup omit them and get the historical all-null shape.
  cleaned_text,
  cleaned_at,
  oneliner,
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
    cleaned_text: cleaned_text ?? null,
    cleaned_at: cleaned_text ? (cleaned_at ?? now) : null,
    oneliner: cleaned_text ? (oneliner ?? null) : null,
    structured_fields: structured_fields ?? null,
    model_id,
    model_version,
    status: DEFAULT_STATUS,
    status_history: [{ status: DEFAULT_STATUS, at: now }],
    notes: null,
    follow_up_at: null,
    tags: [],
    profile_id: null,           // null → use default profile
    match_score: null,
    match_facts: null,
    match_computed_at: null,
    match_profile_version: null,
    match_profile_id: null,     // which profile the cached score was computed against
    match_algo_version: null,   // scoring algo version; null means never computed
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
  const t = tx(
    db,
    [STORE_JOBS, STORE_EMBEDDINGS, STORE_JD_CHUNK_EMBEDDINGS],
    'readwrite',
  );
  // Cascade chunk rows by walking the jd_id index — composite-key stores
  // can't delete by partial key directly.
  const chunkIdx = t.objectStore(STORE_JD_CHUNK_EMBEDDINGS).index('jd_id');
  const chunkKeys = await wrap(chunkIdx.getAllKeys(id));
  await Promise.all([
    wrap(t.objectStore(STORE_JOBS).delete(id)),
    wrap(t.objectStore(STORE_EMBEDDINGS).delete(id)),
    ...chunkKeys.map((k) =>
      wrap(t.objectStore(STORE_JD_CHUNK_EMBEDDINGS).delete(k)),
    ),
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

// Replace all chunk embeddings for a JD with the given list. Caller passes
// chunks already in row shape ({chunk_index, chunk_text, vector, dims,
// model_id, model_version}); we attach jd_id and normalize the vector to
// Float32Array. Old chunks for this jd_id are wiped first so re-embed paths
// (edit, cleanup, schema upgrade) don't leave stale rows behind.
export async function putJdChunks(jd_id, chunks) {
  if (!jd_id) throw new Error('putJdChunks: jd_id required');
  const db = await open();
  const t = tx(db, [STORE_JD_CHUNK_EMBEDDINGS], 'readwrite');
  const store = t.objectStore(STORE_JD_CHUNK_EMBEDDINGS);
  const oldKeys = await wrap(store.index('jd_id').getAllKeys(jd_id));
  await Promise.all(oldKeys.map((k) => wrap(store.delete(k))));
  await Promise.all(
    chunks.map((c) => {
      const buf =
        c.vector instanceof Float32Array
          ? c.vector
          : new Float32Array(c.vector);
      return wrap(
        store.put({
          jd_id,
          chunk_index: c.chunk_index,
          chunk_text: c.chunk_text,
          section: c.section ?? null,
          vector: buf,
          dims: c.dims,
          model_id: c.model_id,
          model_version: c.model_version,
        }),
      );
    }),
  );
}

export async function getJdChunks(jd_id) {
  const db = await open();
  const t = tx(db, [STORE_JD_CHUNK_EMBEDDINGS], 'readonly');
  const idx = t.objectStore(STORE_JD_CHUNK_EMBEDDINGS).index('jd_id');
  const rows = await wrap(idx.getAll(jd_id));
  return rows.sort((a, b) => a.chunk_index - b.chunk_index);
}

export async function deleteJdChunks(jd_id) {
  const db = await open();
  const t = tx(db, [STORE_JD_CHUNK_EMBEDDINGS], 'readwrite');
  const store = t.objectStore(STORE_JD_CHUNK_EMBEDDINGS);
  const keys = await wrap(store.index('jd_id').getAllKeys(jd_id));
  await Promise.all(keys.map((k) => wrap(store.delete(k))));
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

// ---------- Profiles ----------

export async function addProfile({ name, short_label }) {
  const db = await open();
  const id = uuid();
  const row = {
    id,
    name: String(name ?? '').trim() || 'Untitled profile',
    short_label: deriveShortLabel(short_label, name),
    version: String(Date.now()),
    created_at: Date.now(),
  };
  const t = tx(db, [STORE_PROFILES], 'readwrite');
  await wrap(t.objectStore(STORE_PROFILES).add(row));
  return row;
}

function deriveShortLabel(explicit, name) {
  const fromExplicit = String(explicit ?? '').trim();
  if (fromExplicit) return fromExplicit.slice(0, 6);
  const firstWord = String(name ?? '').trim().split(/\s+/)[0] ?? '';
  return firstWord.slice(0, 6) || 'NEW';
}

export async function getProfile(id) {
  const db = await open();
  const t = tx(db, [STORE_PROFILES], 'readonly');
  return wrap(t.objectStore(STORE_PROFILES).get(id));
}

export async function listProfiles() {
  const db = await open();
  const t = tx(db, [STORE_PROFILES], 'readonly');
  const rows = await wrap(t.objectStore(STORE_PROFILES).index('created_at').getAll());
  return rows;
}

// One pass: profiles + per-profile fact counts + the default flag.
export async function listProfilesWithCounts() {
  const db = await open();
  const t = tx(db, [STORE_PROFILES, STORE_PROFILE_FACTS, STORE_META], 'readonly');
  const profiles = await wrap(t.objectStore(STORE_PROFILES).index('created_at').getAll());
  const defaultRow = await wrap(t.objectStore(STORE_META).get('default_profile_id'));
  const defaultId = defaultRow?.value ?? null;
  const counts = await Promise.all(
    profiles.map((p) =>
      wrap(t.objectStore(STORE_PROFILE_FACTS).index('profile_id').count(p.id)),
    ),
  );
  return profiles.map((p, i) => ({
    ...p,
    fact_count: counts[i],
    is_default: p.id === defaultId,
  }));
}

export async function renameProfile(id, { name, short_label }) {
  const db = await open();
  const t = tx(db, [STORE_PROFILES], 'readwrite');
  const store = t.objectStore(STORE_PROFILES);
  const row = await wrap(store.get(id));
  if (!row) throw new Error(`profile not found: ${id}`);
  const next = { ...row };
  if (typeof name === 'string') next.name = name.trim() || row.name;
  if (typeof short_label === 'string') {
    next.short_label = deriveShortLabel(short_label, next.name);
  }
  await wrap(store.put(next));
  return next;
}

export async function setProfileVersion(id, version) {
  const db = await open();
  const t = tx(db, [STORE_PROFILES], 'readwrite');
  const store = t.objectStore(STORE_PROFILES);
  const row = await wrap(store.get(id));
  if (!row) throw new Error(`profile not found: ${id}`);
  row.version = version;
  await wrap(store.put(row));
  return row;
}

// Cascade-delete: profile, its facts, its embeddings. Does NOT mutate jobs.
// Background.js handles clearing job.profile_id and job.match_profile_id where
// they referenced this profile (since it also needs to trigger recompute).
export async function deleteProfileCascade(id) {
  const db = await open();
  const t = tx(
    db,
    [STORE_PROFILES, STORE_PROFILE_FACTS, STORE_PROFILE_EMBEDDINGS, STORE_META],
    'readwrite',
  );
  // Delete profile row
  await wrap(t.objectStore(STORE_PROFILES).delete(id));
  // Cursor-delete facts + embeddings by profile_id index
  const factsIdx = t.objectStore(STORE_PROFILE_FACTS).index('profile_id');
  await new Promise((resolve, reject) => {
    const cur = factsIdx.openCursor(IDBKeyRange.only(id));
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c) return resolve();
      c.delete();
      c.continue();
    };
    cur.onerror = () => reject(cur.error);
  });
  const embsIdx = t.objectStore(STORE_PROFILE_EMBEDDINGS).index('profile_id');
  await new Promise((resolve, reject) => {
    const cur = embsIdx.openCursor(IDBKeyRange.only(id));
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c) return resolve();
      c.delete();
      c.continue();
    };
    cur.onerror = () => reject(cur.error);
  });
  // If we deleted the default, clear the default pointer (caller must pick a new one).
  const meta = t.objectStore(STORE_META);
  const defaultRow = await wrap(meta.get('default_profile_id'));
  if (defaultRow?.value === id) {
    await wrap(meta.delete('default_profile_id'));
  }
}

export async function getDefaultProfileId() {
  const db = await open();
  const t = tx(db, [STORE_META], 'readonly');
  const row = await wrap(t.objectStore(STORE_META).get('default_profile_id'));
  return row?.value ?? null;
}

export async function setDefaultProfileId(id) {
  const db = await open();
  const t = tx(db, [STORE_META], 'readwrite');
  await wrap(t.objectStore(STORE_META).put({ key: 'default_profile_id', value: id }));
}

// ---------- Profile facts ----------

export async function addProfileFact({
  profile_id,
  section,
  subsection,
  text,
  order,
  model_id,
  model_version,
}) {
  if (!profile_id) throw new Error('addProfileFact: profile_id required');
  const db = await open();
  const row = {
    id: uuid(),
    profile_id,
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

export async function putProfileEmbedding({ fact_id, profile_id, vector, dims }) {
  if (!profile_id) throw new Error('putProfileEmbedding: profile_id required');
  const db = await open();
  const t = tx(db, [STORE_PROFILE_EMBEDDINGS], 'readwrite');
  const buf = vector instanceof Float32Array ? vector : new Float32Array(vector);
  await wrap(
    t.objectStore(STORE_PROFILE_EMBEDDINGS).put({ fact_id, profile_id, vector: buf, dims }),
  );
}

export async function listProfileFacts(profileId) {
  if (!profileId) throw new Error('listProfileFacts: profileId required');
  const db = await open();
  const t = tx(db, [STORE_PROFILE_FACTS], 'readonly');
  const idx = t.objectStore(STORE_PROFILE_FACTS).index('profile_id');
  const facts = await wrap(idx.getAll(profileId));
  return facts.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

export async function getProfileFact(id) {
  const db = await open();
  const t = tx(db, [STORE_PROFILE_FACTS], 'readonly');
  return wrap(t.objectStore(STORE_PROFILE_FACTS).get(id));
}

export async function countProfileFacts(profileId) {
  const db = await open();
  const t = tx(db, [STORE_PROFILE_FACTS], 'readonly');
  if (profileId) {
    return wrap(t.objectStore(STORE_PROFILE_FACTS).index('profile_id').count(profileId));
  }
  return wrap(t.objectStore(STORE_PROFILE_FACTS).count());
}

// Wipe one profile's facts + embeddings (keeps the profile row itself).
export async function clearProfile(profileId) {
  if (!profileId) throw new Error('clearProfile: profileId required');
  const db = await open();
  const t = tx(db, [STORE_PROFILE_FACTS, STORE_PROFILE_EMBEDDINGS], 'readwrite');
  const factsIdx = t.objectStore(STORE_PROFILE_FACTS).index('profile_id');
  await new Promise((resolve, reject) => {
    const cur = factsIdx.openCursor(IDBKeyRange.only(profileId));
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c) return resolve();
      c.delete();
      c.continue();
    };
    cur.onerror = () => reject(cur.error);
  });
  const embsIdx = t.objectStore(STORE_PROFILE_EMBEDDINGS).index('profile_id');
  await new Promise((resolve, reject) => {
    const cur = embsIdx.openCursor(IDBKeyRange.only(profileId));
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c) return resolve();
      c.delete();
      c.continue();
    };
    cur.onerror = () => reject(cur.error);
  });
}

// Cosine search over one profile's embeddings. Returns {fact_id, score} pairs
// for the caller to hydrate text + breadcrumb from profile_facts.
export async function profileCosineSearch(queryVector, { profileId, topK = 8 } = {}) {
  if (!profileId) throw new Error('profileCosineSearch: profileId required');
  const q = queryVector instanceof Float32Array
    ? queryVector
    : new Float32Array(queryVector);
  const db = await open();
  const t = tx(db, [STORE_PROFILE_EMBEDDINGS], 'readonly');
  const idx = t.objectStore(STORE_PROFILE_EMBEDDINGS).index('profile_id');
  const embs = await wrap(idx.getAll(profileId));
  const scored = embs.map((e) => ({
    fact_id: e.fact_id,
    score: cosine(q, e.vector),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

// Batched variant for JD-chunk asymmetric matching: loads the profile's
// embeddings once and scores every query against them. Returns an array
// parallel to queryVectors, each element a top-K list. With ~30 chunks ×
// ~50 facts this saves ~30× redundant getAll() deserialization.
export async function profileCosineSearchBatch(
  queryVectors,
  { profileId, topKPerQuery = 1 } = {},
) {
  if (!profileId) throw new Error('profileCosineSearchBatch: profileId required');
  if (!Array.isArray(queryVectors) || queryVectors.length === 0) return [];
  const db = await open();
  const t = tx(db, [STORE_PROFILE_EMBEDDINGS], 'readonly');
  const idx = t.objectStore(STORE_PROFILE_EMBEDDINGS).index('profile_id');
  const embs = await wrap(idx.getAll(profileId));
  return queryVectors.map((q) => {
    const qv = q instanceof Float32Array ? q : new Float32Array(q);
    const scored = embs.map((e) => ({
      fact_id: e.fact_id,
      score: cosine(qv, e.vector),
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topKPerQuery);
  });
}
