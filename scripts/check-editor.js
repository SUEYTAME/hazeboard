// Boots the editor window offscreen, drives it into edit mode, and captures it.
// Verifies layout/CSS without needing anyone to click anything.
const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const fs = require('fs');

// Running a bare script makes Electron default the app name to 'Electron',
// which points userData at an empty directory. Match the real app.
app.setName('glassboard');

const root = path.join(__dirname, '..');
const store = require(path.join(root, 'dist', 'main', 'store.js'));

let win;

app.whenReady().then(async () => {
  const notes = () => store.load().notes;
  ipcMain.handle('gb:getNotes', () => notes());
  ipcMain.handle('gb:add', (_e, t) => { store.addNote(t); return notes(); });
  ipcMain.handle('gb:toggle', (_e, id) => { store.toggleNote(id); return notes(); });
  ipcMain.handle('gb:remove', (_e, id) => { store.removeNote(id); return notes(); });
  ipcMain.handle('gb:clearDone', () => { store.clearDone(); return notes(); });
  ipcMain.on('gb:close', () => {});
  ipcMain.on('gb:resize', (_e, physical) => {
    if (!Number.isFinite(physical)) return;
    const [w] = win.getContentSize();
    const scale = screen.getDisplayMatching(win.getBounds()).scaleFactor || 1;
    win.setContentSize(w, Math.round(Math.min(Math.max(physical / scale, 200), 820)));
  });

  win = new BrowserWindow({
    width: 620, height: 660, frame: false, show: false, skipTaskbar: true,
    backgroundColor: '#2a201a',   // stand-in for acrylic, which capturePage can't see
    webPreferences: {
      preload: path.join(root, 'dist', 'main', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
    },
  });

  const errors = [];
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) errors.push(message);
  });

  await win.loadFile(path.join(root, 'dist', 'renderer', 'board.html'));

  const payload = {
    mode: 'editor',
    notes: notes(),
    backgroundUrl: null,
    footer: 'hold a note to edit  ·  esc to close',
    geometry: null,
  };

  const run = async (expr) => {
    const r = await win.webContents.executeJavaScript(`
      (async () => { try { return { ok:true, v: await (${expr}) }; }
                     catch(e){ return { ok:false, m: (e&&e.message)||String(e) }; } })()`);
    if (!r.ok) throw new Error(r.m);
    return r.v;
  };

  await run(`window.__renderBoard(${JSON.stringify(payload)})`);
  await run('window.__initEditor()');
  await new Promise((r) => setTimeout(r, 350));

  const outDir = path.join(root, 'tmp');
  fs.mkdirSync(outDir, { recursive: true });

  const viewShot = await win.webContents.capturePage();
  fs.writeFileSync(path.join(outDir, 'editor-view.png'), viewShot.toPNG());

  // Force edit mode the same way a long-press would.
  await run(`(() => { document.body.classList.add('editing'); return 1; })()`);
  await new Promise((r) => setTimeout(r, 250));
  const editShot = await win.webContents.capturePage();
  fs.writeFileSync(path.join(outDir, 'editor-edit.png'), editShot.toPNG());

  const sizes = await run(`({
    cardRect: Math.round(document.getElementById('card').getBoundingClientRect().height),
    bodyScroll: document.body.scrollHeight,
    docScroll: document.documentElement.scrollHeight,
    innerH: window.innerHeight,
    dpr: window.devicePixelRatio,
    zoom: 'n/a',
  })`);
  console.log('page sizes:', JSON.stringify(sizes), 'window content:', JSON.stringify(win.getContentSize()));

  const counts = await run(`({
    rows: document.querySelectorAll('#notes li').length,
    removeButtons: document.querySelectorAll('#notes li .remove').length,
    composer: !!document.querySelector('.composer input'),
    bridge: typeof window.glassboard,
  })`);

  console.log('rendered:', JSON.stringify(counts));
  console.log('console errors:', errors.length ? errors : 'none');
  console.log('wrote tmp/editor-view.png and tmp/editor-edit.png');
  app.exit(errors.length ? 1 : 0);
});

app.on('window-all-closed', () => {});
