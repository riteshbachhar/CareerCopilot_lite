// IIFE-bundled by build.mjs into dist/readability.js, then injected into
// the target tab via chrome.scripting.executeScript({files}) before the
// extractor runs. Exposes Mozilla's Readability on the page's isolated
// world so the extractor (which is also injected via executeScript) can
// reach it as `globalThis.Readability`.
//
// Two-step injection (this file, then the extractor func) is required
// because the extractor is serialized to a string and cannot import.

import { Readability } from '@mozilla/readability';

globalThis.Readability = Readability;
