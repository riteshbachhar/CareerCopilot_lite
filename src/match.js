import { profileCosineSearch } from './db.js';

// Average cosine of the top-K facts (from one profile) retrieved against the
// JD vector. Reuses the existing profile retrieval path; no LLM, no chunking.
// Score is bounded [0, 1]; ~0.5+ is a meaningful overlap, ~0.7+ is strong.
export async function computeMatch(jdVector, { profileId, topK = 10 } = {}) {
  if (!profileId) throw new Error('computeMatch: profileId required');
  const top = await profileCosineSearch(jdVector, { profileId, topK });
  const score = top.length
    ? top.reduce((s, f) => s + f.score, 0) / top.length
    : 0;
  return { score, top_facts: top };
}
