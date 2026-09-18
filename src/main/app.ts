import { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, nativeImage, screen, shell } from 'electron';
import * as path from 'path';
import * as store from './store';
import { composeAndApply } from './compose';
import type { BoardPayload } from '../shared/types';

const HOTKEY = 'Control+Alt+W';

let tray: Tray | null = null;
let editor: BrowserWindow | null = null;
/** Set when notes changed while the editor was open, so we only re-bake once. */
let dirty = false;

function assetPath(...parts: string[]): string {
  return path.join(__dirname, '..', '..', 'assets', ...parts);
}

function boardHtml(): string {
  return path.join(__dirname, '..', 'renderer', 'board.html');
}

function createEditor(): BrowserWindow {
  const win = new BrowserWindow({
    width: 620,
    height: 660,
    frame: false,
    resizable: false,
    show: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    // Windows 11 acrylic gives the window a real live blur of whatever is
    // behind it. backdrop-filter cannot do that here: in a standalone window
    // there is nothing behind the page for CSS to sample.
    backgroundMaterial: 'acrylic',
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(boardHtml());

  win.webContents.once('did-finish-load', async () => {
    const payload: BoardPayload = {
      mode: 'editor',
      notes: store.load().notes,
      backgroundUrl: null,
      footer: 'hold a note to edit  ·  esc to close',
      geometry: null,
    };
    await win.webContents.executeJavaScript(
      `window.__renderBoard(${JSON.stringify(payload)}).then(() => window.__initEditor())`
    );
    win.show();
    win.focus();
  });

  // Closing the editor is what re-bakes the wallpaper: doing it on every
  // keystroke would mean a full render per character.
  win.on('hide', () => { void flush(); });
  win.on('closed', () => { editor = null; });

  // Never navigate away or open windows from inside the board.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  return win;
}

async function flush(): Promise<void> {
  if (!dirty) return;
  dirty = false;
  try {
    await composeAndApply();
  } catch (err) {
    // Surfaced rather than swallowed: if the wallpaper did not update, the
    // notes the user just wrote are not where they expect to see them.
    console.error(`glassboard: wallpaper refresh failed: ${(err as Error).message}`);
    if (tray) tray.setToolTip(`glassboard - refresh FAILED: ${(err as Error).message}`);
  }
}

function toggleEditor(): void {
  if (!editor) {
    editor = createEditor();
    return;
  }
  if (editor.isVisible()) editor.hide();
  else { editor.show(); editor.focus(); }
}

function buildTray(): void {
  const icon = nativeImage.createFromPath(assetPath('tray.png'));
  tray = new Tray(icon);
  tray.setToolTip('glassboard');

  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open board', click: toggleEditor },
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
    { label: `Hotkey: ${HOTKEY.replace(/Control/, 'Ctrl')}`, enabled: false },
    { type: 'separator' },
    { label: 'Quit glassboard', click: () => { app.exit(0); } },
  ]));

  tray.on('click', toggleEditor);
}

function wireIpc(): void {
  const notes = (): ReturnType<typeof store.load>['notes'] => store.load().notes;

  ipcMain.handle('gb:getNotes', () => notes());
  ipcMain.handle('gb:add', (_e, text: string) => { store.addNote(text); dirty = true; return notes(); });
  ipcMain.handle('gb:toggle', (_e, id: string) => { store.toggleNote(id); dirty = true; return notes(); });
  ipcMain.handle('gb:remove', (_e, id: string) => { store.removeNote(id); dirty = true; return notes(); });
  ipcMain.handle('gb:clearDone', () => { store.clearDone(); dirty = true; return notes(); });
  ipcMain.on('gb:close', () => { editor?.hide(); });

  ipcMain.on('gb:resize', (_e, physicalHeight: number) => {
    if (!editor || !Number.isFinite(physicalHeight)) return;
    const [w] = editor.getContentSize();
    const scale = screen.getDisplayMatching(editor.getBounds()).scaleFactor || 1;
    const dip = physicalHeight / scale;
    // Clamped: a huge list must not grow a window taller than the screen, and
    // an empty board should still be big enough to type into.
    const h = Math.round(Math.min(Math.max(dip, 200), 820));
    editor.setContentSize(w, h);
  });
}

export function startApp(): void {
  // Second launch just pops the board of the instance already running.
  if (!app.requestSingleInstanceLock()) {
    app.exit(0);
    return;
  }
  app.on('second-instance', toggleEditor);

  wireIpc();
  buildTray();

  if (!globalShortcut.register(HOTKEY, toggleEditor)) {
    console.error(`glassboard: could not register ${HOTKEY} - another app likely owns it.`);
    if (tray) tray.setToolTip(`glassboard - ${HOTKEY} unavailable`);
  }

  app.on('will-quit', () => globalShortcut.unregisterAll());

  // Tray app: closing the editor must not end the process.
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
