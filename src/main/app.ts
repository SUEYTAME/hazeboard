import {
  app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, nativeImage, screen, shell,
  desktopCapturer, Notification,
} from 'electron';
import * as path from 'path';
import * as store from './store';
import { composeAndApply } from './compose';
import { callPage, CARD_W } from './render';
import { DEFAULT_BACKDROP, type Card, type NoteStyle, type OverlayPayload } from '../shared/types';

const HOTKEY = 'Control+Alt+W';

let tray: Tray | null = null;
let overlay: BrowserWindow | null = null;
/** Guards against a second hotkey press while the capture is in flight. */
let opening = false;
/** Set when notes changed while the overlay was open, so we only re-bake once. */
let dirty = false;

function assetPath(...parts: string[]): string {
  return path.join(__dirname, '..', '..', 'assets', ...parts);
}

function overlayHtml(): string {
  return path.join(__dirname, '..', 'renderer', 'overlay.html');
}

/* ------------------------------------------------------------------ *
 *  Overlay                                                            *
 * ------------------------------------------------------------------ */

/**
 * Capture the whole primary display at full resolution. Measured at 166ms for
 * 1920x1200 including other windows and the taskbar. JPEG rather than PNG:
 * the page blurs it heavily, so compression artefacts are invisible, and it
 * crosses the executeJavaScript boundary in a fraction of the bytes.
 */
async function captureScreen(display: Electron.Display, widthPx: number, heightPx: number): Promise<string> {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: widthPx, height: heightPx },
  });
  const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[0];
  if (!source) throw new Error('desktopCapturer returned no screen sources');

  const size = source.thumbnail.getSize();
  if (size.width === 0 || size.height === 0) {
    throw new Error('screen capture is empty (is screen recording blocked?)');
  }
  return `data:image/jpeg;base64,${source.thumbnail.toJPEG(88).toString('base64')}`;
}

function createOverlay(display: Electron.Display): BrowserWindow {
  const win = new BrowserWindow({
    // display.bounds, not workArea: the overlay must cover the taskbar too.
    // Bounds alone are not enough - Windows clamps a normal window to the
    // work area (verified: viewport 1140 of 1200px, taskbar visible) - so the
    // window is created in fullscreen mode, which is exempt from that clamp.
    // It must stay resizable: on Windows, Electron silently ignores
    // fullscreen for a window created with resizable: false (verified).
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
    fullscreen: true,
    frame: false,
    show: false,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: '#0a0908',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setMenuBarVisibility(false);

  // Closing the overlay is what re-bakes the wallpaper: doing it on every
  // change would mean a full render per keystroke.
  win.on('hide', () => { void flush(); });
  win.on('closed', () => { overlay = null; });

  // Never navigate away or open windows from inside the board.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  return win;
}

/**
 * Failures must reach the user. A tray tooltip or a console line is invisible
 * to someone who launched the app from the Start menu, which is exactly how
 * "Ctrl+Alt+W does nothing" went undiagnosed.
 */
function notify(body: string): void {
  if (!Notification.isSupported()) return;
  new Notification({ title: 'Hazeboard', body }).show();
}

async function openOverlay(focusNewPanel = false): Promise<void> {
  if (opening) return;
  opening = true;
  try {
    const display = screen.getPrimaryDisplay();
    const scale = display.scaleFactor || 1;
    const canvasW = Math.round(display.size.width * scale);
    const canvasH = Math.round(display.size.height * scale);

    // Capture BEFORE the window shows, or the overlay captures itself.
    const screenshotUrl = await captureScreen(display, canvasW, canvasH);

    if (!overlay) {
      overlay = createOverlay(display);
      await overlay.loadFile(overlayHtml());
    } else {
      overlay.setBounds(display.bounds);
    }
    // One CSS pixel = one wallpaper pixel, exactly as in the bake, so the live
    // card and the baked card are the same size at the same place.
    await overlay.webContents.setZoomFactor(1 / scale);

    const payload: OverlayPayload = {
      mode: 'overlay',
      cards: store.load().cards,
      screenshotUrl,
      canvasW,
      canvasH,
      cardW: CARD_W,
      backdrop: DEFAULT_BACKDROP,
    };
    await callPage(overlay, `window.__initOverlay(${JSON.stringify(payload)})`);

    overlay.show();
    // The taskbar is itself a topmost window. A window Windows refuses to
    // bring to the foreground (the hotkey does not grant that) stays under it
    // even when fullscreen, so re-assert topmost order after showing.
    overlay.setAlwaysOnTop(true, 'screen-saver');
    overlay.moveTop();
    overlay.focus();
    if (focusNewPanel) await callPage(overlay, 'window.__focusNewPanel()');
  } catch (err) {
    const msg = (err as Error).message;
    console.error(`hazeboard: could not open overlay: ${msg}`);
    if (tray) tray.setToolTip(`Hazeboard - board FAILED: ${msg}`);
    notify(`Could not open your board: ${msg}`);
  } finally {
    opening = false;
  }
}

function toggleOverlay(): void {
  if (overlay?.isVisible()) overlay.hide();
  else void openOverlay();
}

async function flush(): Promise<void> {
  if (!dirty) return;
  dirty = false;
  try {
    await composeAndApply();
  } catch (err) {
    // Surfaced rather than swallowed: if the wallpaper did not update, the
    // notes the user just wrote are not where they expect to see them.
    const msg = (err as Error).message;
    console.error(`hazeboard: wallpaper refresh failed: ${msg}`);
    if (tray) tray.setToolTip(`Hazeboard - refresh FAILED: ${msg}`);
    notify(`Your panels could not be saved to the wallpaper: ${msg}`);
  }
}

/* ------------------------------------------------------------------ *
 *  Tray / IPC                                                         *
 * ------------------------------------------------------------------ */

function buildTray(): void {
  const icon = nativeImage.createFromPath(assetPath('tray.png'));
  tray = new Tray(icon);
  tray.setToolTip(`Hazeboard - ${HOTKEY.replace(/Control/, 'Ctrl')} opens your board`);

  tray.setContextMenu(Menu.buildFromTemplate([
    // The accelerator is shown, not registered: globalShortcut owns the key.
    { label: 'Open my board', accelerator: HOTKEY, registerAccelerator: false, click: () => { void openOverlay(); } },
    { label: 'New panel', click: () => { void openOverlay(true); } },
    { type: 'separator' },
    {
      label: 'Start with Windows',
      type: 'checkbox',
      checked: autostartEnabled(),
      click: (item) => { setAutostart(item.checked); },
    },
    { type: 'separator' },
    {
      label: 'Refresh wallpaper',
      click: () => { dirty = true; void flush(); },
    },
    {
      label: 'Open image folder',
      click: () => { void shell.openPath(store.outDir()); },
    },
    { type: 'separator' },
    { label: 'Quit Hazeboard', click: () => { app.exit(0); } },
  ]));

  tray.on('click', toggleOverlay);
}

/**
 * First launch (no board.json yet): leave one panel explaining the basics, and
 * start with Windows so the hotkey is live after every reboot. Without the
 * login item nothing listens for Ctrl+Alt+W once the machine restarts - the
 * cause of the "hotkey does nothing" reports. Only a packaged install registers
 * it: a dev build would register electron.exe plus a checkout path.
 */
function seedFirstRun(): void {
  const panel = store.addCard('Click a note to tick it off', { x: 0.62, y: 0.22 });
  store.addNote('Type in the box below to add a note', panel.id);
  store.addNote(`Press ${HOTKEY.replace(/Control/, 'Ctrl')} any time to open your board`, panel.id);
  store.setCardTitle(panel.id, 'WELCOME');
  dirty = true;
  if (app.isPackaged) setAutostart(true);
}

function wireIpc(): void {
  const cards = (): Card[] => store.load().cards;
  const mutate = (fn: () => void): Card[] => { fn(); dirty = true; return cards(); };

  ipcMain.handle('gb:getCards', () => cards());
  ipcMain.handle('gb:addCard', (_e, text: string, x?: number, y?: number) =>
    mutate(() => store.addCard(text, x !== undefined && y !== undefined ? { x, y } : undefined)));
  ipcMain.handle('gb:addNote', (_e, cardId: string, text: string) =>
    mutate(() => store.addNote(text, cardId)));
  ipcMain.handle('gb:toggleNote', (_e, id: string) => mutate(() => store.toggleNote(id)));
  ipcMain.handle('gb:removeNote', (_e, id: string) => mutate(() => store.removeNote(id)));
  ipcMain.handle('gb:removeCard', (_e, id: string) => mutate(() => store.removeCard(id)));
  ipcMain.handle('gb:moveCard', (_e, id: string, x: number, y: number) =>
    mutate(() => store.moveCard(id, x, y)));
  ipcMain.handle('gb:moveNote', (_e, noteId: string, cardId: string, index: number) =>
    mutate(() => store.moveNote(noteId, cardId, index)));
  ipcMain.handle('gb:detachNote', (_e, noteId: string, x: number, y: number) =>
    mutate(() => store.detachNote(noteId, x, y)));
  ipcMain.handle('gb:setNoteStyle', (_e, noteId: string, style: Partial<NoteStyle>) =>
    mutate(() => store.setNoteStyle(noteId, style)));
  ipcMain.on('gb:close', () => { overlay?.hide(); });
}

export function startApp(): void {
  // Second launch just pops the board of the instance already running.
  if (!app.requestSingleInstanceLock()) {
    app.exit(0);
    return;
  }
  // Opening Hazeboard again from the Start menu shows the board, never a no-op.
  app.on('second-instance', () => { void openOverlay(); });

  // Windows only shows toasts for an app with an AppUserModelID. Same value as
  // build.appId in package.json, which the installer registers.
  app.setAppUserModelId('com.sueytame.hazeboard');

  const firstRun = !store.hasBoard();
  if (firstRun) seedFirstRun();

  wireIpc();
  buildTray();

  const key = HOTKEY.replace(/Control/, 'Ctrl');
  if (!globalShortcut.register(HOTKEY, toggleOverlay)) {
    console.error(`hazeboard: could not register ${HOTKEY} - another app likely owns it.`);
    if (tray) tray.setToolTip(`Hazeboard - ${key} unavailable`);
    notify(`${key} is taken by another app. Click the Hazeboard icon in the taskbar tray to open your board.`);
  }

  if (firstRun) void openOverlay();

  app.on('will-quit', () => globalShortcut.unregisterAll());

  // Tray app: closing the overlay must not end the process.
  app.on('window-all-closed', () => { /* stay resident */ });
}

/* ------------------------------------------------------------------ *
 *  Login item                                                         *
 * ------------------------------------------------------------------ */

/**
 * Note this is only needed for the tray and hotkey. The NOTES themselves are
 * already visible at login without any process running at all, because they
 * are baked into the wallpaper - which is the entire point of the design.
 */
function loginItemOptions(): Electron.Settings {
  // Unpackaged, execPath is electron.exe and it needs the app directory as an
  // argument; packaged, execPath is the app itself.
  const appPath = path.join(__dirname, '..', '..');
  return app.isPackaged
    ? { openAtLogin: true, path: process.execPath, args: [] }
    : { openAtLogin: true, path: process.execPath, args: [appPath] };
}

export function setAutostart(enabled: boolean): void {
  if (enabled) app.setLoginItemSettings(loginItemOptions());
  else app.setLoginItemSettings({ openAtLogin: false });
}

export function autostartEnabled(): boolean {
  return app.getLoginItemSettings().openAtLogin;
}
