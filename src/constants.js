// Embedding model identity. Stored on every vector so future model swaps
// are detectable and trigger reindex rather than silent corruption.
export const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
export const MODEL_VERSION = 'q-v1'; // quantized, v1 of our adoption
export const EMBEDDING_DIMS = 384;

export const JOB_STATUSES = [
  'interested',
  'applied',
  'interviewing',
  'offer',
  'rejected',
  'archived',
];
export const DEFAULT_STATUS = 'interested';

// Custom status order used by the "Status" sort mode in the library list.
// Active / hottest stages first, dead/cold stages last.
export const STATUS_ORDER = [
  'interviewing',
  'offer',
  'applied',
  'interested',
  'rejected',
  'archived',
];

// Groq models offered in the settings drawer. Every id here must be a live
// Groq model id — a stale string is only discovered at request time, as a
// 404 from the provider, with no local validation to catch it first.
export const LLM_MODELS = [
  {
    value: 'openai/gpt-oss-120b',
    label: 'gpt-oss-120b (best quality, default)',
  },
  {
    value: 'qwen/qwen3.6-27b',
    label: 'qwen3.6-27b (faster, preview)',
  },
];
export const DEFAULT_LLM_MODEL = 'openai/gpt-oss-120b';

// Groq retirements, mapped to their replacement. getLlmSettings() rewrites a
// stored id through this table on read, so a user who saved a model before it
// was retired lands on a working one instead of a 404 on their next cleanup.
// llama-3.1-8b-instant / llama-3.3-70b-versatile shut down 2026-08-16;
// mixtral-8x7b-32768 and gemma2-9b-it were retired earlier.
export const RETIRED_LLM_MODELS = {
  'llama-3.1-8b-instant': 'qwen/qwen3.6-27b',
  'llama-3.3-70b-versatile': 'openai/gpt-oss-120b',
  'mixtral-8x7b-32768': 'openai/gpt-oss-120b',
  'gemma2-9b-it': 'qwen/qwen3.6-27b',
};

export const SORT_MODES = [
  { value: 'recent', label: 'Recently captured' },
  { value: 'match', label: 'Match score' },
  { value: 'follow_up', label: 'Follow-up date' },
  { value: 'status', label: 'Status' },
];
export const DEFAULT_SORT = 'recent';
