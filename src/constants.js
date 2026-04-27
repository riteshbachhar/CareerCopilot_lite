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

export const SORT_MODES = [
  { value: 'recent', label: 'Recently captured' },
  { value: 'match', label: 'Match score' },
  { value: 'follow_up', label: 'Follow-up date' },
  { value: 'status', label: 'Status' },
];
export const DEFAULT_SORT = 'recent';
