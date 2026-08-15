// LLM settings live in chrome.storage.local — never IndexedDB. Storing the
// API key in IDB would put it in the same backup surface as captured JDs;
// keeping it in storage.local matches the convention for credentials and
// makes the "Clear settings" action a single delete.

import { DEFAULT_LLM_MODEL, RETIRED_LLM_MODELS } from '../constants.js';

const KEY = 'llm_settings';

export const DEFAULT_LLM_SETTINGS = {
  provider: 'groq',
  apiKey: '',
  model: DEFAULT_LLM_MODEL,
  enabled: false,
};

export async function getLlmSettings() {
  const out = await chrome.storage.local.get(KEY);
  const settings = { ...DEFAULT_LLM_SETTINGS, ...(out?.[KEY] ?? {}) };
  // Migrate on read rather than on write: the retirement happens on the
  // provider's clock, not ours, so a settings blob written months ago can
  // go stale without the user touching this drawer again.
  const replacement = RETIRED_LLM_MODELS[settings.model];
  if (replacement) settings.model = replacement;
  return settings;
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
