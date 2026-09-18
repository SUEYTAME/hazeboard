/// <reference lib="dom" />
import type { BoardPayload, Geometry, Note } from '../shared/types';

let currentBg: HTMLImageElement | null = null;
let currentGeometry: Geometry | null = null;

/**
 * Renders the board and resolves only once the browser has actually painted it.
 * The main process awaits this before capturing, otherwise the capture races
 * layout and you bake a half-drawn card into your wallpaper.
 */
async function renderBoard(payload: BoardPayload): Promise<void> {
  const body = document.body;
  body.className = `mode-${payload.mode}`;
  currentGeometry = payload.geometry;

  const bg = document.getElementById('bg') as HTMLImageElement;
  currentBg = bg;

  if (payload.geometry) applyGeometry(payload.geometry);

  if (payload.backgroundUrl) {
    bg.src = payload.backgroundUrl;
  }

  document.getElementById('date')!.textContent = new Date().toLocaleDateString(undefined, {
    weekday: 'short', day: 'numeric', month: 'short',
  });

  const list = document.getElementById('notes')!;
  list.replaceChildren();
  for (const note of payload.notes) list.appendChild(noteRow(note));
  body.classList.toggle('is-empty', payload.notes.length === 0);

  document.getElementById('foot')!.textContent = payload.footer;

  await settled(bg, Boolean(payload.backgroundUrl));
}

/**
 * The viewport IS the region. The background image is sized to the full
 * wallpaper and shifted by -regionX/-regionY, so the pixels sitting behind the
 * card are the real wallpaper pixels and backdrop-filter blurs the truth.
 */
function applyGeometry(g: Geometry): void {
  const s = document.documentElement.style;
  s.setProperty('--region-w', `${g.regionW}px`);
  s.setProperty('--region-h', `${g.regionH}px`);
  s.setProperty('--bg-w', `${g.canvasW}px`);
  s.setProperty('--bg-h', `${g.canvasH}px`);
  s.setProperty('--bg-left', `${-g.regionX}px`);
  s.setProperty('--bg-top', `${-g.regionY}px`);
  s.setProperty('--card-w', `${g.cardW}px`);
  s.setProperty('--card-margin', `${g.cardMargin}px`);
  s.setProperty('--card-max-h', `${g.regionH - g.cardMargin * 2}px`);
}

function noteRow(note: Note): HTMLLIElement {
  const li = document.createElement('li');
  li.dataset.id = note.id;
  if (note.done) li.classList.add('done');

  const mark = document.createElement('span');
  mark.className = 'mark';

  const text = document.createElement('span');
  text.className = 'text';
  text.textContent = note.text;

  li.append(mark, text);
  return li;
}

/** Wait for fonts, the background image, and two frames of layout. */
async function settled(bg: HTMLImageElement, hasBackground: boolean): Promise<void> {
  const waits: Promise<unknown>[] = [document.fonts.ready];
  if (hasBackground) {
    waits.push(
      bg.decode().catch(() => {
        throw new Error(`background image failed to decode: ${bg.src}`);
      })
    );
  }
  await Promise.all(waits);
  await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
}

/**
 * Composite the captured card region onto a full-size wallpaper canvas.
 * Canvas dimensions are not bound by the window, which is the whole point.
 */
async function compositeBoard(regionPngDataUrl: string): Promise<string> {
  const g = currentGeometry;
  const bg = currentBg;
  if (!g) throw new Error('compositeBoard called before renderBoard set a geometry');
  if (!bg || !bg.naturalWidth) throw new Error('background image is not loaded');

  const canvas = document.createElement('canvas');
  canvas.width = g.canvasW;
  canvas.height = g.canvasH;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('could not get a 2d context');

  // Reproduce the crop Windows "Fill" would apply, so what we bake matches
  // what the shell would have shown for this base image.
  const scale = Math.max(g.canvasW / bg.naturalWidth, g.canvasH / bg.naturalHeight);
  const sw = g.canvasW / scale;
  const sh = g.canvasH / scale;
  const sx = (bg.naturalWidth - sw) / 2;
  const sy = (bg.naturalHeight - sh) / 2;
  ctx.drawImage(bg, sx, sy, sw, sh, 0, 0, g.canvasW, g.canvasH);

  const region = new Image();
  region.src = regionPngDataUrl;
  await region.decode();
  ctx.drawImage(region, g.regionX, g.regionY);

  return canvas.toDataURL('image/png');
}

const w = window as unknown as Record<string, unknown>;
w.__renderBoard = renderBoard;
w.__compositeBoard = compositeBoard;

/* ------------------------------------------------------------------ *
 *  Editor mode                                                        *
 *  Only wired when the window is the interactive board; in wallpaper   *
 *  mode none of this runs.                                            *
 * ------------------------------------------------------------------ */

interface GlassboardApi {
  getNotes(): Promise<Note[]>;
  add(text: string): Promise<Note[]>;
  toggle(id: string): Promise<Note[]>;
  remove(id: string): Promise<Note[]>;
  clearDone(): Promise<Note[]>;
  close(): void;
  resize(height: number): void;
}

/** How long to hold a note before the board flips into edit mode. */
const HOLD_MS = 550;

function api(): GlassboardApi {
  const a = (window as unknown as { glassboard?: GlassboardApi }).glassboard;
  if (!a) throw new Error('preload bridge missing: window.glassboard is undefined');
  return a;
}

function initEditor(): void {
  const list = document.getElementById('notes')!;
  const card = document.getElementById('card')!;

  const composer = buildComposer();
  card.appendChild(composer.el);

  let holdTimer: number | undefined;
  let held = false;

  const startHold = (): void => {
    held = false;
    holdTimer = window.setTimeout(() => {
      held = true;
      setEditing(true);
    }, HOLD_MS);
  };
  const cancelHold = (): void => {
    if (holdTimer !== undefined) window.clearTimeout(holdTimer);
    holdTimer = undefined;
  };

  list.addEventListener('pointerdown', (e) => {
    if ((e.target as HTMLElement).closest('.remove')) return;
    startHold();
  });
  list.addEventListener('pointerup', cancelHold);
  list.addEventListener('pointerleave', cancelHold);
  list.addEventListener('pointercancel', cancelHold);

  list.addEventListener('click', async (e) => {
    const target = e.target as HTMLElement;
    const row = target.closest('li') as HTMLLIElement | null;
    if (!row) return;
    const id = row.dataset.id;
    if (!id) return;

    if (target.closest('.remove')) {
      repaint(await api().remove(id));
      return;
    }
    // A click that ended a long-press opened edit mode; don't also toggle.
    if (held) { held = false; return; }
    if (document.body.classList.contains('editing')) return;
    repaint(await api().toggle(id));
  });

  // Esc backs out of edit mode first, and only closes the board on a second press.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (document.body.classList.contains('editing')) setEditing(false);
    else api().close();
  });

  // Clicking the card outside the list leaves edit mode, like tapping the
  // wallpaper on iOS.
  card.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('#notes') || t.closest('.composer')) return;
    if (document.body.classList.contains('editing')) setEditing(false);
  });

  composer.input.focus();
  fitWindow();
}

function setEditing(on: boolean): void {
  document.body.classList.toggle('editing', on);
  document.getElementById('foot')!.textContent = on
    ? 'tap x to delete  ·  esc to finish'
    : 'hold a note to edit  ·  esc to close';
}

function buildComposer(): { el: HTMLElement; input: HTMLInputElement } {
  const wrap = document.createElement('div');
  wrap.className = 'composer';

  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'Write something to remember...';
  input.autocomplete = 'off';
  input.spellcheck = false;

  input.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    repaint(await api().add(text));
  });

  wrap.appendChild(input);
  return { el: wrap, input };
}

/** Re-draw the list from authoritative state returned by the main process. */
function repaint(notes: Note[]): void {
  const list = document.getElementById('notes')!;
  list.replaceChildren();
  for (const n of notes) list.appendChild(editableRow(n));
  document.body.classList.toggle('is-empty', notes.length === 0);
  fitWindow();
}

let lastSentHeight = -1;
let cardObserver: ResizeObserver | null = null;

/**
 * Keep the window shrink-wrapped around the card.
 *
 * A one-shot measurement is unreliable: measuring in the frame after a repaint
 * catches the card mid-layout and leaves a dead band. A ResizeObserver watches
 * the card's real box and self-corrects. The 2px guard stops the
 * resize -> max-height -> resize feedback loop from oscillating.
 */
function fitWindow(): void {
  const card = document.getElementById('card');
  if (!card) return;

  // Report PHYSICAL pixels. getBoundingClientRect returns CSS pixels, but the
  // window APIs take DIPs, and the two only agree when devicePixelRatio equals
  // the display scale factor - which it does not here (DPR is 1 on a 125%
  // display). Main divides by the display's scaleFactor to get DIPs back.
  const send = (cssHeight: number): void => {
    const physical = Math.ceil(cssHeight * window.devicePixelRatio);
    if (Math.abs(physical - lastSentHeight) <= 2) return;
    lastSentHeight = physical;
    api().resize(physical);
  };

  if (!cardObserver) {
    cardObserver = new ResizeObserver((entries) => {
      for (const entry of entries) send(entry.contentRect.height + verticalPadding(card));
    });
    cardObserver.observe(card);
  }
  send(card.getBoundingClientRect().height);
}

function verticalPadding(el: HTMLElement): number {
  const cs = getComputedStyle(el);
  return parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
}

function editableRow(note: Note): HTMLLIElement {
  const li = noteRow(note);
  const del = document.createElement('button');
  del.className = 'remove';
  del.type = 'button';
  del.setAttribute('aria-label', `Delete note: ${note.text}`);
  del.textContent = '×';
  li.appendChild(del);
  return li;
}

w.__initEditor = (): void => {
  // The initial render used the wallpaper row builder; swap in editable rows.
  void api().getNotes().then(repaint).then(() => initEditor());
};
