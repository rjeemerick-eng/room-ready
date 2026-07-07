/**
 * Room Ready – NDI Output Module
 *
 * Sends the board display as a live NDI video source using the grandiose package.
 * Requires:
 *   1. npm install grandiose  (or it's already in node_modules)
 *   2. NDI Runtime installed on the machine:
 *      Mac  → https://ndi.video/tools/ndi-tools/ (free download)
 *      Win  → same URL, Windows installer
 */

'use strict';

let grandiose      = null;   // loaded lazily so app still starts without it
let ndiSender      = null;
let captureTimer   = null;
let isRunning      = false;
let lastSourceName = '';

// ── Try to load grandiose ─────────────────────────────────────────────────
function tryLoad() {
  if (grandiose) return true;
  try {
    grandiose = require('grandiose');
    return true;
  } catch (e) {
    return false;
  }
}

// ── Start NDI output ──────────────────────────────────────────────────────
async function start(webContents, config) {
  if (!tryLoad()) {
    return { ok: false, error: 'grandiose not installed — run: npm install grandiose' };
  }

  // Stop any existing sender first
  await stop();

  const sourceName = (config.ndiSourceName || 'Room Ready Board').trim();
  const fps        = Math.max(1, Math.min(60, parseInt(config.ndiFps) || 30));
  const interval   = Math.round(1000 / fps);

  try {
    ndiSender = await grandiose.send({
      name:       sourceName,
      clockVideo: true,
      clockAudio: false,
    });

    lastSourceName = sourceName;
    isRunning      = true;

    captureTimer = setInterval(async () => {
      if (!ndiSender || !webContents || webContents.isDestroyed()) return;
      try {
        const image  = await webContents.capturePage();
        const size   = image.getSize();
        if (!size.width || !size.height) return;

        // capturePage returns BGRA bitmap
        const buffer = image.toBitmap();

        await ndiSender.video({
          xres:               size.width,
          yres:               size.height,
          frameRateN:         fps * 1000,
          frameRateD:         1000,
          pictureAspectRatio: size.width / size.height,
          fourCC:             grandiose.FOURCC_BGRA,
          data:               buffer,
        });
      } catch (_) {
        // Skip dropped frames silently
      }
    }, interval);

    return { ok: true, sourceName, fps };
  } catch (e) {
    isRunning = false;
    return { ok: false, error: e.message };
  }
}

// ── Stop NDI output ───────────────────────────────────────────────────────
async function stop() {
  isRunning = false;
  if (captureTimer)  { clearInterval(captureTimer); captureTimer = null; }
  if (ndiSender)     { try { await ndiSender.destroy(); } catch (_) {} ndiSender = null; }
}

// ── Status ────────────────────────────────────────────────────────────────
function status() {
  return {
    available:  tryLoad(),
    running:    isRunning,
    sourceName: lastSourceName,
  };
}

module.exports = { start, stop, status };
