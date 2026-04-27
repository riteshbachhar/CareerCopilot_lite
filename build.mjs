import * as esbuild from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const watch = process.argv.includes('--watch');
const outdir = 'dist';

// Extension pages: ESM (offscreen, sidepanel, background service worker).
// No content scripts anymore — capture uses chrome.scripting.executeScript
// with an inline function via activeTab.
const esmEntries = [
  'src/background.js',
  'src/offscreen.js',
  'src/sidepanel.js',
];

const esmOptions = {
  entryPoints: esmEntries,
  bundle: true,
  format: 'esm',
  target: ['chrome116'],
  outdir,
  logLevel: 'info',
  sourcemap: true,
};

// Readability injector: IIFE bundle, loaded into the target tab via
// chrome.scripting.executeScript({files: ['readability.js']}) before the
// extractor runs. Must be IIFE (not ESM) because executeScript with files
// expects a classic script that mutates globalThis.
const readabilityOptions = {
  entryPoints: ['src/readability-inject.js'],
  bundle: true,
  format: 'iife',
  target: ['chrome116'],
  outfile: path.join(outdir, 'readability.js'),
  logLevel: 'info',
  sourcemap: true,
};

async function copyStatic() {
  await rm(outdir, { recursive: true, force: true });
  await mkdir(outdir, { recursive: true });

  // HTML files
  await cp('src/offscreen.html', path.join(outdir, 'offscreen.html'));
  await cp('src/sidepanel.html', path.join(outdir, 'sidepanel.html'));

  // Manifest
  await cp('manifest.json', path.join(outdir, 'manifest.json'));

  // ONNX Runtime Web WASM files — required for transformers.js (Phase 2+)
  const ortDir = 'node_modules/onnxruntime-web/dist';
  if (existsSync(ortDir)) {
    await mkdir(path.join(outdir, 'wasm'), { recursive: true });
    await cp(ortDir, path.join(outdir, 'wasm'), {
      recursive: true,
      filter: (src) => /\.(wasm|mjs)$|dist$/.test(src),
    });
    console.log('[build] copied ORT WASM files');
  } else {
    console.log('[build] onnxruntime-web not installed yet — skipping WASM copy');
  }
}

await copyStatic();

if (watch) {
  const esmCtx = await esbuild.context(esmOptions);
  const readabilityCtx = await esbuild.context(readabilityOptions);
  await Promise.all([esmCtx.watch(), readabilityCtx.watch()]);
  console.log('[build] watching for changes…');
} else {
  await Promise.all([
    esbuild.build(esmOptions),
    esbuild.build(readabilityOptions),
  ]);
  console.log('[build] done');
}
