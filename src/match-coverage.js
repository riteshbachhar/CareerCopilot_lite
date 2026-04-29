import { profileCosineSearchBatch } from './db.js';

// Asymmetric JD-coverage match score.
//
// Given a list of JD chunks (each with its own embedding), find the best
// matching profile fact for each chunk and average those per-chunk best
// cosines. This answers "does my profile cover the JD's requirements?"
// rather than the symmetric "what are my closest profile sentences to
// the JD-as-a-bag?" that the simple top-K-mean baseline answers.
//
// Score is bounded [0, 1]. Empty profile or empty chunks → 0.
//
// `search` is injected so unit tests can stub the data layer.
export async function computeMatchCoverage(
  chunkVectors,
  { profileId, search = profileCosineSearchBatch } = {},
) {
  if (!profileId) throw new Error('computeMatchCoverage: profileId required');
  if (!Array.isArray(chunkVectors) || chunkVectors.length === 0) {
    return { score: 0, top_facts: [] };
  }
  const queries = chunkVectors.map((c) => c.vector);
  const results = await search(queries, { profileId, topKPerQuery: 1 });
  const top_facts = chunkVectors.map((c, i) => {
    const top = results[i]?.[0];
    return {
      chunk_index: c.chunk_index,
      chunk_text: c.chunk_text,
      fact_id: top?.fact_id ?? null,
      score: top?.score ?? 0,
    };
  });
  const score =
    top_facts.reduce((s, f) => s + f.score, 0) / top_facts.length;
  return { score, top_facts };
}
