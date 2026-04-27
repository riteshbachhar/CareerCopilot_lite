// LLM settings live in chrome.storage.local — never IndexedDB. Storing the
// API key in IDB would put it in the same backup surface as captured JDs;
// keeping it in storage.local matches the convention for credentials and
// makes the "Clear settings" action a single delete.

const KEY = 'llm_settings';

export const DEFAULT_LLM_SETTINGS = {
  provider: 'groq',
  apiKey: '',
  model: 'llama-3.1-8b-instant',
  enabled: false,
};

export async function getLlmSettings() {
  const out = await chrome.storage.local.get(KEY);
  return { ...DEFAULT_LLM_SETTINGS, ...(out?.[KEY] ?? {}) };
}

export async function setLlmSettings(patch) {
  const current = await getLlmSettings();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}

export async function clearLlmSettings() {
  await chrome.storage.local.remove(KEY);
}
