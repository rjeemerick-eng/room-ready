/**
 * Room Ready – Electron Main Process
 */

const { app, BrowserWindow, Tray, Menu, nativeImage, shell, dialog, session } = require('electron');
const path   = require('path');
const fs     = require('fs');
const server  = require('./server');
const ndi     = require('./ndi');
const updater = require('./updater');

let mainWindow = null;
let tray       = null;
let localIP    = 'localhost';
let serverPort = 8080;

// ── Start the HTTP server ─────────────────────────────────────────────────
server.start();
localIP    = server.getLocalIP();
serverPort = server.PORT;

// ── Config helper ─────────────────────────────────────────────────────────
// Reads app_config.json from userData; returns safe defaults if the file
// doesn't exist yet (e.g. first launch before Settings is ever saved).
function readAppConfig() {
  const cfgPath = path.join(app.getPath('userData'), 'app_config.json');
  try {
    if (fs.existsSync(cfgPath)) {
      return JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    }
  } catch (e) {
    console.warn('[Config] Could not read app_config.json:', e.message);
  }
  return { ndiEnabled: false };
}

// ── Create the display board window ──────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width:  1920,
    height: 1080,
    title:  'Room Ready – Classroom Board',
    backgroundColor: '#000000',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // Load the board from the local server
  mainWindow.loadURL(`http://localhost:${serverPort}/classroom-board.html`);

  // App menu with Settings access
  const appMenu = Menu.buildFromTemplate([
    {
      label: 'Room Ready',
      submenu: [
        { label: 'About Room Ready', role: 'about' },
        { type: 'separator' },
        { label: 'Quit', accelerator: 'Cmd+Q', click: () => app.quit() },
      ]
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Settings',
          accelerator: 'Cmd+,',
          click: () => openSettings()
        },
        {
          label: 'Admin Panel',
          accelerator: 'Cmd+Shift+A',
          click: () => shell.openExternal(`http://localhost:${serverPort}/admin.html`)
        },
        { type: 'separator' },
        { label: 'Reload Board', accelerator: 'Cmd+R', click: () => mainWindow && mainWindow.reload() },
        { label: 'Toggle Full Screen', accelerator: 'Ctrl+Cmd+F', role: 'togglefullscreen' },
        { type: 'separator' },
        { label: 'Check for Updates…', click: () => updater.checkManual() },
      ]
    }
  ]);
  Menu.setApplicationMenu(appMenu);

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ── Settings window ───────────────────────────────────────────────────────
let settingsWindow = null;
function openSettings() {
  if (settingsWindow) { settingsWindow.focus(); return; }
  settingsWindow = new BrowserWindow({
    width:  780,
    height: 700,
    title:  'Room Ready – Settings',
    backgroundColor: '#0a0a0a',
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  settingsWindow.loadURL(`http://localhost:${serverPort}/settings.html`);
  settingsWindow.on('closed', () => { settingsWindow = null; });
}

// ── System tray icon ──────────────────────────────────────────────────────
function createTray() {
  // Simple 16x16 tray icon (white square placeholder — replace with real icon if desired)
  const icon = nativeImage.createEmpty();
  tray = new Tray(icon);

  const adminURL = `http://${localIP}:${serverPort}/admin.html`;

  const menu = Menu.buildFromTemplate([
    { label: '✦ Room Ready Board', enabled: false },
    { type: 'separator' },
    {
      label: 'Show Board Window',
      click: () => {
        if (mainWindow) mainWindow.show();
        else createWindow();
      }
    },
    {
      label: 'Open Admin Panel',
      click: () => shell.openExternal(`http://localhost:${serverPort}/admin.html`)
    },
    {
      label: 'Open Settings',
      click: () => openSettings()
    },
    { type: 'separator' },
    {
      label: 'Copy Volunteer Link',
      click: () => {
        const { clipboard } = require('electron');
        clipboard.writeText(adminURL);
        dialog.showMessageBox({
          type: 'info',
          title: 'Link Copied',
          message: 'Volunteer admin link copied!',
          detail: `Share this with your team:\n\n${adminURL}`,
          buttons: ['OK']
        });
      }
    },
    {
      label: 'Show Volunteer Link',
      click: () => {
        dialog.showMessageBox({
          type: 'info',
          title: 'Volunteer Admin Link',
          message: 'Share this link with your team:',
          detail: adminURL,
          buttons: ['OK']
        });
      }
    },
    { type: 'separator' },
    { label: 'Quit Room Ready', click: () => app.quit() },
  ]);

  tray.setToolTip('Room Ready Board');
  tray.setContextMenu(menu);
}

// ── NDI management ────────────────────────────────────────────────────────
let ndiPollTimer      = null;
let ndiErrorLogged    = false;

function startNDIPolling() {
  // Poll config every 5s; start/stop NDI based on ndiEnabled flag
  ndiPollTimer = setInterval(async () => {
    if (!mainWindow) return;
    try {
      const cfg    = readAppConfig();
      const status = ndi.status();
      if (cfg.ndiEnabled && !status.running) {
        const result = await ndi.start(mainWindow.webContents, cfg);
        if (result.ok) {
          console.log(`[NDI] Started: "${result.sourceName}" @ ${result.fps}fps`);
          ndiErrorLogged = false;
        } else if (!ndiErrorLogged) {
          // Log once instead of every 5 seconds
          console.warn('[NDI] Start failed:', result.error);
          ndiErrorLogged = true;
        }
      } else if (!cfg.ndiEnabled && status.running) {
        await ndi.stop();
        console.log('[NDI] Stopped');
      }
    } catch (e) {
      if (!ndiErrorLogged) {
        console.warn('[NDI] Polling error:', e.message);
        ndiErrorLogged = true;
      }
    }
  }, 5000);
}

// Expose NDI controls to the HTTP server for the settings page
server._ndiGetStatus = () => ndi.status();
server._ndiControl   = async (action) => {
  if (action === 'start' && mainWindow) {
    await ndi.start(mainWindow.webContents, readAppConfig());
  } else if (action === 'stop') {
    await ndi.stop();
  }
};

// ── App lifecycle ─────────────────────────────────────────────────────────
app.whenReady().then(() => {
  // Grant local-fonts permission so Settings can read from macOS Font Book / Windows fonts
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'local-fonts') { callback(true); return; }
    callback(false);
  });

  createWindow();
  createTray();
  startNDIPolling();
  updater.init(mainWindow);

  // Show the volunteer link on first launch
  setTimeout(() => {
    const adminURL = `http://${localIP}:${serverPort}/admin.html`;
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Room Ready is running!',
      message: '✦ Room Ready Board is live.',
      detail: `Share this link with volunteers so they can update rooms from their phones:\n\n${adminURL}\n\nThe board window is ready for NDI Screen Capture.`,
      buttons: ['Got it']
    });
  }, 1500);
});

// Keep the app alive in the tray on ALL platforms when the board window is
// closed. Subscribing to this event without calling app.quit() prevents the
// default quit-on-last-window-closed behavior on Windows/Linux; macOS never
// quits on window close by default.
app.on('window-all-closed', () => {
  /* intentionally empty — app stays in the tray */
});

app.on('activate', () => {
  if (mainWindow === null) createWindow();
});
