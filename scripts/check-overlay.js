// Boots the overlay offscreen against a THROWAWAY board, drives it with
// synthetic pointer events through every gesture, and screenshots each state.
// Verifies layout, CSS and the drag/drop paths without anyone clicking anything.
//
//   node scripts/check-overlay.js        (or: npm run check)
//
// Writes tmp/overlay-*.png. Exits 1 on any failed check or renderer error.
const { app, BrowserWindow, ipcMain, screen, desktopCapturer } = require('electron');
const path = require('path');
const fs = require('fs');

// Running a bare script makes Electron default the app name to 'Electron'.
app.setName('hazeboard');

const root = path.join(__dirname, '..');
const outDir = path.join(root, 'tmp');
fs.mkdirSync(outDir, { recursive: true });

// A private userData so the real board.json is never touched.
const userData = path.join(outDir, 'check-userdata');
fs.rmSync(userData, { recursive: true, force: true });
fs.mkdirSync(userData, { recursive: true });
app.setPath('userData', userData);
app.setPath('sessionData', path.join(userData, 'session'));

const now = new Date().toISOString();
const note = (id, text, done, tint, intensity) =>
  ({ id, text, done, createdAt: now, style: { tint, intensity } });
fs.writeFileSync(path.join(userData, 'board.json'), JSON.stringify({
  version: 2, baseWallpaper: null, updatedAt: now,
  cards: [
    { id: 'card0001', title: null, x: 0.62, y: 0.22, createdAt: now, notes: [
      note('n0000001', 'Book the dentist before Friday', false, 'blue', 0.5),
      note('n0000002', 'Renew the parking permit', true, 'graphite', 0.32),
      note('n0000003', 'A deliberately long reminder that wraps onto a second line to exercise the measuring pass', false, 'orange', 0.7),
    ] },
    { id: 'card0002', title: 'GROCERIES', x: 0.08, y: 0.55, createdAt: now, notes: [
      note('n0000004', 'Coffee beans', false, 'green', 0.4),
      note('n0000005', 'Oat milk', false, 'mint', 0.4),
    ] },
  ],
}, null, 2));

const store = require(path.join(root, 'dist', 'main', 'store.js'));
const { CARD_W, EDGE_INSET } = require(path.join(root, 'dist', 'shared', 'layout.js'));
const { DEFAULT_BACKDROP } = require(path.join(root, 'dist', 'shared', 'types.js'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];
const failures = [];
const check = (cond, msg) => {
  if (!cond) failures.push(msg);
  console.log(`${cond ? ' ok ' : 'FAIL'}  ${msg}`);
};
const cardById = (id) => store.load().cards.find((c) => c.id === id);

let win;
let closed = false;

app.whenReady().then(main).catch((err) => {
  console.error(`check failed: ${err.message}`);
  console.error('console errors:', errors.length ? errors : 'none');
  app.exit(1);
});

async function main() {
  const cards = () => store.load().cards;
  const mutate = (fn) => { fn(); return cards(); };
  ipcMain.handle('gb:getCards', () => cards());
  ipcMain.handle('gb:addCard', (_e, text, x, y) =>
    mutate(() => store.addCard(text, x !== undefined && y !== undefined ? { x, y } : undefined)));
  ipcMain.handle('gb:addNote', (_e, cardId, text) => mutate(() => store.addNote(text, cardId)));
  ipcMain.handle('gb:toggleNote', (_e, id) => mutate(() => store.toggleNote(id)));
  ipcMain.handle('gb:removeNote', (_e, id) => mutate(() => store.removeNote(id)));
  ipcMain.handle('gb:removeCard', (_e, id) => mutate(() => store.removeCard(id)));
  ipcMain.handle('gb:moveCard', (_e, id, x, y) => mutate(() => store.moveCard(id, x, y)));
  ipcMain.handle('gb:moveNote', (_e, n, c, i) => mutate(() => store.moveNote(n, c, i)));
  ipcMain.handle('gb:detachNote', (_e, n, x, y) => mutate(() => store.detachNote(n, x, y)));
  ipcMain.handle('gb:setNoteStyle', (_e, n, s) => mutate(() => store.setNoteStyle(n, s)));
  ipcMain.handle('gb:setCardTitle', (_e, id, t) => mutate(() => store.setCardTitle(id, t)));
  ipcMain.handle('gb:setCardStyle', (_e, id, s) => mutate(() => store.setCardStyle(id, s)));
  ipcMain.on('gb:close', () => { closed = true; });

  const display = screen.getPrimaryDisplay();
  const scale = display.scaleFactor || 1;
  // Offscreen windows are clamped to the work area, so the check runs at that
  // size. The real overlay uses display.bounds and covers the taskbar too.
  const W = Math.round(display.workArea.width * scale);
  const H = Math.round(display.workArea.height * scale);

  win = new BrowserWindow({
    x: 0, y: 0, width: display.workArea.width, height: display.workArea.height,
    frame: false, show: false, skipTaskbar: true, backgroundColor: '#0a0908',
    webPreferences: {
      preload: path.join(root, 'dist', 'main', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true,
    },
  });
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) errors.push(message);
  });
  await win.loadFile(path.join(root, 'dist', 'renderer', 'overlay.html'));
  await win.webContents.setZoomFactor(1 / scale);

  // HAZEBOARD_CHECK_SHOT=<png> uses that image as the "desktop" instead of a
  // live capture - e.g. a baked wallpaper, to see how the blur treats the
  // baked cards sitting behind the live ones.
  let screenshotUrl;
  if (process.env.HAZEBOARD_CHECK_SHOT) {
    const png = fs.readFileSync(process.env.HAZEBOARD_CHECK_SHOT);
    screenshotUrl = `data:image/png;base64,${png.toString('base64')}`;
  } else {
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: W, height: H } });
    const src = sources.find((s) => s.display_id === String(display.id)) ?? sources[0];
    if (!src) throw new Error('no screen source');
    screenshotUrl = `data:image/jpeg;base64,${src.thumbnail.toJPEG(88).toString('base64')}`;
  }

  const run = async (expr) => {
    const r = await win.webContents.executeJavaScript(`
      (async () => { try { return { ok:true, v: await (${expr}) }; }
                     catch(e){ return { ok:false, m: (e&&e.message)||String(e) }; } })()`);
    if (!r.ok) throw new Error(r.m);
    return r.v;
  };
  const shot = async (name) => {
    await sleep(150);
    fs.writeFileSync(path.join(outDir, name), (await win.webContents.capturePage()).toPNG());
  };

  const t0 = Date.now();
  await run(`window.__initOverlay(${JSON.stringify({
    mode: 'overlay', cards: cards(), screenshotUrl, canvasW: W, canvasH: H, cardW: CARD_W, backdrop: DEFAULT_BACKDROP, tutorial: null,
  })})`);
  console.log(`init: ${Date.now() - t0}ms at ${W}x${H}`);
  await shot('overlay-view.png');

  const counts = await run(`({
    cards: document.querySelectorAll('#field .card').length,
    notes: document.querySelectorAll('#field .note').length,
    bridge: typeof window.hazeboard,
  })`);
  check(counts.cards === 2 && counts.notes === 5, `rendered 2 cards / 5 notes (got ${counts.cards}/${counts.notes})`);
  check(counts.bridge === 'object', 'preload bridge present');

  const rects = await run(`[...document.querySelectorAll('#field .card')].map((c) => {
    const r = c.getBoundingClientRect(); return { id: c.dataset.id, l: r.left, t: r.top, r: r.right, b: r.bottom };
  })`);
  check(
    rects.every((r) => r.l >= EDGE_INSET && r.t >= EDGE_INSET && r.r <= W - EDGE_INSET && r.b <= H - EDGE_INSET),
    `all cards pinned inside the screen ${JSON.stringify(rects.map((r) => [r.id, Math.round(r.l), Math.round(r.t)]))}`
  );

  // Synthetic gesture helpers, defined in the page.
  await run(`(() => {
    window.__ev = (type, x, y, onDocument) => {
      const el = onDocument ? document : document.elementFromPoint(x, y);
      el.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0,
        buttons: type === 'pointerup' ? 0 : 1, pointerId: 1, pointerType: 'mouse',
      }));
      return 1;
    };
    window.__center = (sel) => {
      const el = document.querySelector(sel);
      if (!el) throw new Error('no element ' + sel);
      const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2];
    };
    // A real click is pointerdown, pointerup, click; the page resets its
    // hold/drag click-suppression on pointerdown, so send all three.
    window.__click = (sel) => {
      const el = document.querySelector(sel);
      if (!el) throw new Error('no element ' + sel);
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, pointerId: 1, pointerType: 'mouse' };
      el.dispatchEvent(new PointerEvent('pointerdown', { ...opts, buttons: 1 }));
      el.dispatchEvent(new PointerEvent('pointerup', { ...opts, buttons: 0 }));
      el.dispatchEvent(new MouseEvent('click', opts));
      return 1;
    };
    window.__key = (key) => { document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })); return 1; };
    return 1;
  })()`);

  // 1. A plain click toggles a note.
  const [cx, cy] = await run(`window.__center('.note[data-id="n0000004"]')`);
  await run(`(window.__ev('pointerdown', ${cx}, ${cy}), window.__ev('pointerup', ${cx}, ${cy}, true),
             document.elementFromPoint(${cx}, ${cy}).dispatchEvent(new MouseEvent('click', { bubbles: true })), 1)`);
  await sleep(200);
  check(cardById('card0002').notes[0].done === true, 'click toggled a note done');

  // 2. A hold enters jiggle mode and picks the note up.
  const [hx, hy] = await run(`window.__center('.note[data-id="n0000001"]')`);
  await run(`window.__ev('pointerdown', ${hx}, ${hy})`);
  await sleep(650);
  const jig = await run(`({ jiggle: document.body.classList.contains('jiggle'), ghost: !!document.querySelector('.ghost') })`);
  check(jig.jiggle && jig.ghost, 'hold entered jiggle mode and started a drag');
  await shot('overlay-jiggle.png');

  // 3. Drag it over the other card and drop: moveNote.
  const [tx, ty] = await run(`window.__center('.card[data-id="card0002"] .notes')`);
  await run(`window.__ev('pointermove', ${hx + 20}, ${hy + 20}, true)`);
  await run(`window.__ev('pointermove', ${tx}, ${ty}, true)`);
  await sleep(60);
  check(await run(`!!document.querySelector('.card[data-id="card0002"] .drop-gap')`), 'drop gap shown inside the target card');
  await shot('overlay-drag.png');
  await run(`window.__ev('pointerup', ${tx}, ${ty}, true)`);
  await sleep(250);
  check(cardById('card0002').notes.some((n) => n.id === 'n0000001'), 'note moved into the other card');
  check(cardById('card0001').notes.length === 2, 'source card lost the note');
  check(await run(`document.body.classList.contains('jiggle')`), 'still in jiggle mode after the drop');

  // 4. In jiggle mode, drag a note into empty space: detachNote -> new card.
  const [dx, dy] = await run(`window.__center('.note[data-id="n0000005"]')`);
  const freeX = Math.round(W * 0.45);
  const freeY = Math.round(H * 0.12);
  await run(`window.__ev('pointerdown', ${dx}, ${dy})`);
  await run(`window.__ev('pointermove', ${dx + 30}, ${dy}, true)`);
  await run(`window.__ev('pointermove', ${freeX}, ${freeY}, true)`);
  await sleep(60);
  check(await run(`!!document.querySelector('.ghost.will-detach')`), 'ghost signals detach when outside every card');
  await run(`window.__ev('pointerup', ${freeX}, ${freeY}, true)`);
  await sleep(250);
  check(store.load().cards.length === 3, `detached note became a new card (${store.load().cards.length} cards)`);

  // 5. Drag a card by its header.
  const before = cardById('card0001');
  const [chx, chy] = await run(`window.__center('.card[data-id="card0001"] > header .brand')`);
  await run(`window.__ev('pointerdown', ${chx}, ${chy})`);
  await run(`window.__ev('pointermove', ${chx - 200}, ${chy + 100}, true)`);
  await run(`window.__ev('pointerup', ${chx - 200}, ${chy + 100}, true)`);
  await sleep(250);
  const after = cardById('card0001');
  const movedX = (after.x - before.x) * W;
  const movedY = (after.y - before.y) * H;
  check(Math.abs(movedX + 200) <= 2 && Math.abs(movedY - 100) <= 2,
    `card moved by the drag distance (dx ${movedX.toFixed(1)}, dy ${movedY.toFixed(1)}; expected -200, +100)`);

  // 6. Tint popover from the dot; a swatch persists.
  await run(`window.__click('.note[data-id="n0000002"] .tint')`);
  await sleep(60);
  check(await run(`!document.getElementById('popover').hidden`), 'tint popover opened');
  await run(`window.__click('#popover .swatch[data-tint="pink"]')`);
  await sleep(200);
  await shot('overlay-popover.png');
  check(cardById('card0001').notes.find((n) => n.id === 'n0000002').style.tint === 'pink', 'swatch persisted a tint');

  // 7. Esc: popover, then jiggle, then close.
  await run(`window.__key('Escape')`);
  check(await run(`document.getElementById('popover').hidden`), 'esc closed the popover');
  await run(`window.__key('Escape')`);
  check(await run(`!document.body.classList.contains('jiggle')`), 'esc left jiggle mode');
  await run(`window.__key('Escape')`);
  await sleep(100);
  check(closed, 'esc closed the overlay via the bridge');

  // 8. Composers.
  await run(`(() => { const i = document.querySelector('.card[data-id="card0002"] .composer input');
    i.value = 'Bananas'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return 1; })()`);
  await sleep(250);
  check(cardById('card0002').notes.some((n) => n.text === 'Bananas'), 'card composer appended a note');
  await run(`(() => { const i = document.querySelector('#newcard input');
    i.value = 'Fresh card'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return 1; })()`);
  await sleep(250);
  check(store.load().cards.length === 4, 'new-card composer made a card');

  // 9. Delete badges in jiggle mode.
  await run(`(() => { document.body.classList.add('jiggle'); return 1; })()`);
  await run(`window.__click('.note[data-id="n0000003"] .remove')`);
  await sleep(250);
  check(!cardById('card0001').notes.some((n) => n.id === 'n0000003'), 'x badge removed a note');
  await shot('overlay-final.png');

  // 10. Tutorial. An empty board has no note to tick or panel to add to, so
  //     the tour must start at "make your own panel" instead of pointing at nothing.
  const payload = (cs, tutorial) => JSON.stringify({
    mode: 'overlay', cards: cs, screenshotUrl, canvasW: W, canvasH: H, cardW: CARD_W,
    backdrop: DEFAULT_BACKDROP, tutorial,
  });
  const coach = () => run(`({ hidden: document.getElementById('coach').hidden,
    step: document.querySelector('#coach .coach-step').textContent,
    target: document.querySelectorAll('.coach-target').length })`);
  await run(`window.__initOverlay(${payload([], { hotkey: 'Ctrl+Alt+W' })})`);
  let c = await coach();
  check(!c.hidden && c.step === 'Step 3 of 6', `empty board starts the tutorial at step 3 (${c.step})`);

  //     The full walk: every step advances only on its real gesture.
  await run(`window.__initOverlay(${payload(cards(), { hotkey: 'Ctrl+Alt+W' })})`);
  c = await coach();
  check(!c.hidden && c.step === 'Step 1 of 6' && c.target === 1, `tutorial opens at step 1 with a highlight (${c.step}, ${c.target})`);
  await shot('tutorial-step1.png');

  const [n1x, n1y] = await run(`window.__center('#field .note')`);
  await run(`(window.__ev('pointerdown', ${n1x}, ${n1y}), window.__ev('pointerup', ${n1x}, ${n1y}, true),
             document.elementFromPoint(${n1x}, ${n1y}).dispatchEvent(new MouseEvent('click', { bubbles: true })), 1)`);
  await sleep(250);
  check((await coach()).step === 'Step 2 of 6', 'ticking a note advanced to step 2');

  await run(`(() => { const i = document.querySelector('#field .composer input');
    i.value = 'Tutorial note'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return 1; })()`);
  await sleep(250);
  check((await coach()).step === 'Step 3 of 6', 'adding a note advanced to step 3');

  await run(`(() => { const i = document.querySelector('#newcard input');
    i.value = 'Tutorial panel'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return 1; })()`);
  await sleep(250);
  check((await coach()).step === 'Step 4 of 6', 'making a panel advanced to step 4');

  const [bx, by] = await run(`window.__center('#field .card > header .brand')`);
  await run(`window.__ev('pointerdown', ${bx}, ${by})`);
  await sleep(650);
  await run(`window.__ev('pointermove', ${bx - 120}, ${by + 60}, true)`);
  await run(`window.__ev('pointerup', ${bx - 120}, ${by + 60}, true)`);
  await sleep(250);
  check((await coach()).step === 'Step 5 of 6', 'holding and dragging a panel advanced to step 5');

  await run(`(() => { document.querySelector('#field .note').dispatchEvent(
    new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); return 1; })()`);
  await sleep(60);
  check((await coach()).step === 'Step 5 of 6', 'opening the colour popover alone does not advance');
  await run(`window.__click('#popover .swatch[data-tint="green"]')`);
  await sleep(250);
  c = await coach();
  check(c.step === 'Step 6 of 6' && c.target === 0, `picking a colour advanced to step 6 (${c.step})`);
  await shot('tutorial-step6.png');

  closed = false;
  await run(`window.__key('Escape')`); // popover
  await run(`window.__key('Escape')`); // jiggle
  await run(`window.__key('Escape')`); // close
  await sleep(100);
  c = await coach();
  check(closed && c.hidden && c.target === 0, 'esc on the last step finished the tutorial and closed the board');

  //     Skip ends it at any step.
  await run(`window.__initOverlay(${payload(cards(), { hotkey: 'Ctrl+Alt+W' })})`);
  await run(`window.__click('#coach .coach-skip')`);
  c = await coach();
  check(c.hidden && c.target === 0, 'skip hides the coach and the highlight');

  //     A normal opening never shows it.
  await run(`window.__initOverlay(${payload(cards(), null)})`);
  check((await coach()).hidden, 'normal opening has no tutorial');

  // 11. Part B: draw a panel, the panel menu, rename, glass, delete.
  await run(`window.__initOverlay(${payload(cards(), null)})`);
  closed = false;
  // An empty spot: nothing interactive under it.
  const [ex, ey] = await run(`(() => {
    for (let y = 120; y < ${H} - 200; y += 40) for (let x = 60; x < ${W} - 700; x += 40) {
      const t = document.elementFromPoint(x, y);
      if (t && !t.closest('.card, #newcard, #coach, #hint, #popover, #panelmenu')
          && !document.elementFromPoint(x + 260, y + 160)?.closest('.card, #newcard, #coach')) return [x, y];
    }
    throw new Error('no empty spot found');
  })()`);
  const before11 = store.load().cards.length;

  //     A plain click on the wallpaper must not start a panel.
  await run(`(window.__ev('pointerdown', ${ex}, ${ey}), window.__ev('pointerup', ${ex}, ${ey}, true), 1)`);
  check(await run(`document.getElementById('draft').hidden && document.getElementById('drawrect').hidden`),
    'a plain click on empty space does not open a draft');

  //     Press, drag, release: rectangle, then a draft at its corner.
  await run(`window.__ev('pointerdown', ${ex}, ${ey})`);
  await run(`window.__ev('pointermove', ${ex + 260}, ${ey + 160}, true)`);
  check(await run(`!document.getElementById('drawrect').hidden`), 'dragging on empty space shows the rectangle');
  await shot('panel-draw.png');
  await run(`window.__ev('pointerup', ${ex + 260}, ${ey + 160}, true)`);
  await sleep(60);
  check(await run(`!document.getElementById('draft').hidden && document.activeElement === document.querySelector('#draft input')`),
    'release opens a draft panel with the cursor in it');

  //     Esc in the draft cancels it without closing the board.
  await run(`(() => { document.querySelector('#draft input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return 1; })()`);
  check(await run(`document.getElementById('draft').hidden`) && !closed, 'esc cancels the draft and keeps the board open');

  //     Draw again and create it.
  await run(`window.__ev('pointerdown', ${ex}, ${ey})`);
  await run(`window.__ev('pointermove', ${ex + 260}, ${ey + 160}, true)`);
  await run(`window.__ev('pointerup', ${ex + 260}, ${ey + 160}, true)`);
  await sleep(60);
  await run(`(() => { const i = document.querySelector('#draft input');
    i.value = 'Drawn here'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return 1; })()`);
  await sleep(250);
  const drawn = store.load().cards.find((c) => c.notes.some((n) => n.text === 'Drawn here'));
  check(store.load().cards.length === before11 + 1 && !!drawn, 'enter in the draft made a panel');
  check(!!drawn && Math.abs(drawn.x * W - ex) <= 2 && Math.abs(drawn.y * H - ey) <= 2,
    `drawn panel sits at the rectangle's corner (${drawn ? `${(drawn.x * W).toFixed(0)},${(drawn.y * H).toFixed(0)}` : 'none'} vs ${ex},${ey})`);

  //     Right-click: note -> colour popover; panel -> panel menu.
  const did = drawn.id;
  await run(`(() => { document.querySelector('.card[data-id="${did}"] .note').dispatchEvent(
    new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })); return 1; })()`);
  check(await run(`!document.getElementById('popover').hidden && document.getElementById('panelmenu').hidden`),
    'right-click on a note still opens the note colours');
  const [px, py] = await run(`window.__center('.card[data-id="${did}"] > header .brand')`);
  await run(`(() => { document.querySelector('.card[data-id="${did}"] > header .brand').dispatchEvent(
    new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: ${px}, clientY: ${py} })); return 1; })()`);
  check(await run(`!document.getElementById('panelmenu').hidden && document.getElementById('popover').hidden`),
    'right-click on a panel opens the panel menu');

  //     Colour and glass.
  await run(`window.__click('#panelmenu .swatch[data-tint="blue"]')`);
  await sleep(200);
  await run(`window.__click('#panelmenu .pm-presets button[data-glass="0.9"]')`);
  await sleep(200);
  const styled = cardById(did).style;
  check(styled.tint === 'blue' && styled.glass === 0.9, `panel colour and Solid glass saved (${JSON.stringify(styled)})`);
  const live = await run(`(() => { const el = document.querySelector('.card[data-id="${did}"]');
    return { tinted: el.classList.contains('tinted'), gk: el.style.getPropertyValue('--gk') }; })()`);
  check(live.tinted && Math.abs(Number(live.gk) - 0.9 / 0.35) < 0.001, `panel restyled live (${JSON.stringify(live)})`);
  await shot('panel-menu.png');
  await run(`window.__click('#panelmenu .swatch.none')`);
  await sleep(200);
  check(cardById(did).style.tint === null, '"no colour" clears the panel tint');

  //     Rename: Enter saves, blank clears, Esc cancels without closing the board.
  await run(`window.__click('#panelmenu .pm-rename')`);
  check(await run(`!!document.querySelector('.card[data-id="${did}"] header input.rename') && document.getElementById('panelmenu').hidden`),
    'rename puts a text box in the header');
  await run(`(() => { const i = document.querySelector('.card[data-id="${did}"] header input.rename');
    i.value = '  Groceries  '; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return 1; })()`);
  await sleep(250);
  check(cardById(did).title === 'Groceries', `rename saved a trimmed title (${JSON.stringify(cardById(did).title)})`);

  const renameAgain = async () => {
    const [bx2, by2] = await run(`window.__center('.card[data-id="${did}"] > header .brand')`);
    await run(`(() => { document.querySelector('.card[data-id="${did}"] > header .brand').dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: ${bx2}, clientY: ${by2} })); return 1; })()`);
    await run(`window.__click('#panelmenu .pm-rename')`);
  };
  await renameAgain();
  await run(`(() => { const i = document.querySelector('.card[data-id="${did}"] header input.rename');
    i.value = 'Should not stick'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return 1; })()`);
  await sleep(150);
  check(cardById(did).title === 'Groceries' && !closed, 'esc cancels a rename and keeps the board open');
  await renameAgain();
  await run(`(() => { const i = document.querySelector('.card[data-id="${did}"] header input.rename');
    i.value = '   '; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return 1; })()`);
  await sleep(250);
  check(cardById(did).title === null, 'a blank name clears the title');

  //     Delete needs two clicks.
  const [dx2, dy2] = await run(`window.__center('.card[data-id="${did}"] > header .brand')`);
  await run(`(() => { document.querySelector('.card[data-id="${did}"] > header .brand').dispatchEvent(
    new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: ${dx2}, clientY: ${dy2} })); return 1; })()`);
  await run(`window.__click('#panelmenu .pm-delete')`);
  await sleep(150);
  check(!!cardById(did) && await run(`document.querySelector('#panelmenu .pm-delete').classList.contains('armed')`),
    'first delete click only arms it');
  await run(`window.__click('#panelmenu .pm-delete')`);
  await sleep(250);
  check(!cardById(did), 'second delete click removed the panel');

  //     Drawing a panel also completes tutorial step 3.
  await run(`window.__initOverlay(${payload([], { hotkey: 'Ctrl+Alt+W' })})`);
  await run(`window.__ev('pointerdown', ${ex}, ${ey})`);
  await run(`window.__ev('pointermove', ${ex + 260}, ${ey + 160}, true)`);
  await run(`window.__ev('pointerup', ${ex + 260}, ${ey + 160}, true)`);
  await sleep(60);
  await run(`(() => { const i = document.querySelector('#draft input');
    i.value = 'Tutorial by drawing'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return 1; })()`);
  await sleep(250);
  check((await coach()).step === 'Step 4 of 6', 'drawing a panel completes tutorial step 3');

  console.log('console errors:', errors.length ? errors : 'none');
  console.log(`${failures.length} failure(s); wrote tmp/overlay-*.png`);
  app.exit(errors.length || failures.length ? 1 : 0);
}

app.on('window-all-closed', () => {});
