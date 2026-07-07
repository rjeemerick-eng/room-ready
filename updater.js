/**
 * Room Ready – OTA Updater
 *
 * Wraps electron-updater against GitHub Releases (public repo, no token
 * needed at runtime). Loaded lazily so the app still starts if the module
 * is missing, and only active in a packaged, signed build — running from
 * source (npm start / the .command launchers) updates via git, not Squirrel.
 *
 * Show safety: the board NEVER restarts on its own. Updates download quietly
 * and install on the next normal quit, unless the operator explicitly chooses
 * "Install & Restart Now".
 */

'use strict';

const { app, dialog } = require('electron');

let autoUpdater  = null;
let log          = null;
let mainWindow   = null;
let checkTimer   = null;
let manualCheck  = false; // true while a user-initiated check is in flight
let wired        = false;

function tryLoad() {
  if (autoUpdater) return true;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (e) {
    return false;
  }
  try {
    log = require('electron-log');
    log.transports.file.level = 'info';
    autoUpdater.logger = log;
  } catch (_) { /* logging is optional */ }
  return true;
}

function warn(msg) {
  if (log) log.warn(msg);
  else console.warn(msg);
}

function wireEvents() {
  if (wired) return;
  wired = true;

  autoUpdater.on('update-not-available', () => {
    if (manualCheck && mainWindow) {
      dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'Up to Date',
        message: 'Room Ready is up to date.',
        buttons: ['OK'],
      });
    }
    manualCheck = false;
  });

  autoUpdater.on('update-available', () => {
    // Download proceeds automatically; the prompt happens on update-downloaded.
    manualCheck = false;
  });

  autoUpdater.on('update-downloaded', (info) => {
    if (!mainWindow) return;
    const version = (info && info.version) ? info.version : '';
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Update Ready',
      message: `Room Ready ${version} is ready to install.`,
      detail: 'The board will not restart on its own. Install now, or it will '
            + 'update automatically the next time you quit Room Ready.',
      buttons: ['Install & Restart Now', 'Later'],
      defaultId: 1,
      cancelId: 1,
    }).then(({ response }) => {
      if (response === 0) {
        // Give the dialog a beat to close before Squirrel takes over.
        setImmediate(() => autoUpdater.quitAndInstall());
      }
    }).catch(() => {});
  });

  autoUpdater.on('error', (err) => {
    warn('[Updater] error: ' + (err == null ? 'unknown' : (err.message || String(err))));
    manualCheck = false;
  });
}

function check() {
  if (!autoUpdater) return;
  autoUpdater.checkForUpdates().catch((e) => {
    warn('[Updater] check failed: ' + (e && e.message ? e.message : e));
    manualCheck = false;
  });
}

// ── Public API ──────────────────────────────────────────────────────────────

function init(win) {
  mainWindow = win;

  // OTA only makes sense in a packaged, signed build.
  if (!app.isPackaged) return;
  if (!tryLoad())      return;

  autoUpdater.autoDownload         = true;
  autoUpdater.autoInstallOnAppQuit = true; // safe: only installs on a clean quit
  wireEvents();

  check();
  // Re-check every 6 hours for machines left on between Sundays.
  checkTimer = setInterval(check, 6 * 60 * 60 * 1000);
}

// Called by the "Check for Updates…" menu item — always gives the user feedback.
function checkManual() {
  if (!app.isPackaged) {
    if (mainWindow) {
      dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'Updates',
        message: 'Update checking is only available in the installed app.',
        detail: 'You appear to be running Room Ready from source.',
        buttons: ['OK'],
      });
    }
    return;
  }
  if (!tryLoad()) return;
  wireEvents();
  manualCheck = true;
  check();
}

module.exports = { init, checkManual };
