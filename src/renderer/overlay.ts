/// <reference lib="dom" />
import {
  TINTS, TINT_KEYS, GLASS_PRESETS,
  type Card, type CardStyle, type Note, type NoteStyle, type OverlayPayload, type TintKey,
} from '../shared/types';
import { EDGE_INSET, pinCard } from '../shared/layout';
import { footerFor } from '../shared/footer';
import { buildCard, applyNoteStyle, applyCardStyle, settled } from './card';

/**
 * The live overlay: every card, absolutely positioned over a blurred capture
 * of the desktop, iOS "jiggle to arrange" applied to the whole screen.
 *
 * Gestures:
 *   click a note          toggle done
 *   hold a note or card   enter jiggle mode and start dragging it
 *   in jiggle mode        drag starts on movement; x badges delete; the dot
 *                         opens the tint popover; Esc leaves jiggle mode
 *   drag a note           within its card reorders, onto another card moves
 *                         it there, anywhere else makes it a new card
 *   drag a card           moves it
 *   right-click a note    tint popover, in any mode
 *   Esc                   close popover / cancel drag / leave jiggle / close
 */

interface HazeboardApi {
  getCards(): Promise<Card[]>;
  addCard(text: string, x?: number, y?: number): Promise<Card[]>;
  addNote(cardId: string, text: string): Promise<Card[]>;
  toggleNote(id: string): Promise<Card[]>;
  removeNote(id: string): Promise<Card[]>;
  removeCard(id: string): Promise<Card[]>;
  moveCard(id: string, x: number, y: number): Promise<Card[]>;
  moveNote(noteId: string, cardId: string, index: number): Promise<Card[]>;
  detachNote(noteId: string, x: number, y: number): Promise<Card[]>;
  setNoteStyle(noteId: string, style: Partial<NoteStyle>): Promise<Card[]>;
  setCardTitle(id: string, title: string): Promise<Card[]>;
  setCardStyle(id: string, style: Partial<CardStyle>): Promise<Card[]>;
  close(): void;
}

function api(): HazeboardApi {
  const a = (window as unknown as { hazeboard?: HazeboardApi }).hazeboard;
  if (!a) throw new Error('preload bridge missing: window.hazeboard is undefined');
  return a;
}

/** How long to hold before the board flips into jiggle mode. */
const HOLD_MS = 450;
/** Movement (px) that turns a press into a drag, or cancels a hold. */
const DRAG_SLOP = 6;
/** Where a detached note's new card lands relative to the dropped row, so the
 *  row itself ends up roughly where it was let go. */
const DETACH_DX = 36;
const DETACH_DY = 96;

let cards: Card[] = [];
let W = 0;
let H = 0;
let cardW = 560;
let jiggle = false;
let wired = false;

type Kind = 'note' | 'card';

interface Pending {
  kind: Kind;
  el: HTMLElement;
  startX: number;
  startY: number;
  timer: number | undefined;
}

interface Drag {
  kind: Kind;
  el: HTMLElement;
  ghost: HTMLElement;
  offX: number;
  offY: number;
  srcCardId: string;
  srcIndex: number;
  overCardEl: HTMLElement | null;
  index: number;
  gap: HTMLElement;
}

let pending: Pending | null = null;
let drag: Drag | null = null;
let lastPointer = { x: 0, y: 0 };
/** A hold or a drag must not ALSO count as the click that follows pointerup. */
let suppressClick = false;

const $ = <T extends HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`overlay: missing element ${sel}`);
  return el;
};

/* ------------------------------------------------------------------ *
 *  Init / render                                                      *
 * ------------------------------------------------------------------ */

async function initOverlay(payload: OverlayPayload): Promise<void> {
  W = payload.canvasW;
  H = payload.canvasH;
  cardW = payload.cardW;
  cards = payload.cards;

  const s = document.documentElement.style;
  s.setProperty('--blur', `${payload.backdrop.blur}px`);
  s.setProperty('--saturate', String(payload.backdrop.saturate));
  s.setProperty('--dim', String(payload.backdrop.dim));

  const shot = $<HTMLImageElement>('#shot');
  shot.src = payload.screenshotUrl;
  try {
    await shot.decode();
  } catch {
    throw new Error('screen capture failed to decode');
  }

  if (!wired) {
    wire();
    wired = true;
  }
  closePopover();
  closePanelMenu();
  closeDraft();
  cancelDraw();
  setJiggle(false);
  render();
  if (payload.tutorial) startTutorial(payload.tutorial.hotkey);
  else endTutorial();
  await settled();
}

/** Re-draw every card from authoritative state. */
function render(): void {
  const field = $('#field');
  field.replaceChildren();

  const built = cards.map((card) => {
    const el = buildCard(card, { mode: 'overlay', footer: footerFor(card) });
    el.style.setProperty('--card-w', `${cardW}px`);
    el.style.setProperty('--card-max-h', `${H - EDGE_INSET * 2}px`);
    el.style.setProperty('--card-x', `${Math.round(card.x * W)}px`);
    el.style.setProperty('--card-y', `${Math.round(card.y * H)}px`);
    field.appendChild(el);
    return { card, el };
  });

  // Read every height first, then write every position, so the pin does not
  // trigger a layout per card. The pin is the same function the bake uses.
  const heights = built.map(({ el }) => el.getBoundingClientRect().height);
  built.forEach(({ card, el }, i) => {
    const p = pinCard(card.x, card.y, heights[i], W, H);
    el.style.setProperty('--card-x', `${p.x}px`);
    el.style.setProperty('--card-y', `${p.y}px`);
  });

  document.body.classList.toggle('is-empty', cards.length === 0);
  updateHint();
  // render() rebuilds every card, so the step's highlight must be re-applied.
  highlightTarget();
}

function updateHint(): void {
  $('#hint').textContent = jiggle
    ? 'drag to arrange  ·  drop a note outside to make a panel  ·  esc to finish'
    : cards.length === 0
      ? 'type below to make your first panel  ·  esc to close'
      : 'click to tick  ·  hold to arrange  ·  drag on empty space for a new panel  ·  right-click for options  ·  esc to close';
}

function setJiggle(on: boolean): void {
  jiggle = on;
  document.body.classList.toggle('jiggle', on);
  updateHint();
}

function noteById(id: string): Note | null {
  for (const c of cards) {
    const n = c.notes.find((x) => x.id === id);
    if (n) return n;
  }
  return null;
}

async function apply(op: Promise<Card[]>): Promise<void> {
  cards = await op;
  render();
}

/* ------------------------------------------------------------------ *
 *  Wiring                                                             *
 * ------------------------------------------------------------------ */

function wire(): void {
  const field = $('#field');

  field.addEventListener('pointerdown', onPointerDown);
  document.addEventListener('pointermove', onPointerMove);
  document.addEventListener('pointerup', onPointerUp);
  document.addEventListener('pointercancel', onPointerUp);
  field.addEventListener('click', (e) => { void onClick(e); });

  // Right-click: a note gets its colour popover, the rest of a panel gets the
  // panel menu. Text boxes keep the system menu so copy/paste still works.
  field.addEventListener('contextmenu', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('input')) return;
    const row = t.closest<HTMLElement>('.note');
    if (row) {
      e.preventDefault();
      closePanelMenu();
      openPopover(row);
      return;
    }
    const cardEl = t.closest<HTMLElement>('.card');
    if (!cardEl) return;
    e.preventDefault();
    closePopover();
    openPanelMenu(cardEl, e.clientX, e.clientY);
  });

  // Per-card composer: Enter appends to that card.
  field.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const input = e.target as HTMLInputElement;
    if (!input.closest('.composer')) return;
    const cardEl = input.closest<HTMLElement>('.card');
    const text = input.value.trim();
    if (!cardEl?.dataset.id || !text) return;
    input.value = '';
    void apply(api().addNote(cardEl.dataset.id, text)).then(() => { tutorialEvent('addNote'); });
  });

  const newCard = $<HTMLInputElement>('#newcard input');
  newCard.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const text = newCard.value.trim();
    if (!text) return;
    newCard.value = '';
    void apply(api().addCard(text)).then(() => { tutorialEvent('addCard'); });
  });

  $('#coach .coach-skip').addEventListener('click', endTutorial);
  $('#coach .coach-done').addEventListener('click', endTutorial);

  // Clicking the wallpaper leaves jiggle mode, like tapping the home screen.
  // Pressing it and dragging draws a new panel.
  document.body.addEventListener('pointerdown', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('.card, #popover, #newcard, #coach, #panelmenu, #draft')) return;
    closePopover();
    closePanelMenu();
    closeDraft();
    if (jiggle && !drag) setJiggle(false);
    if (e.button === 0 && !drag) beginDraw(e.clientX, e.clientY);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    if (!$('#panelmenu').hidden) { closePanelMenu(); return; }
    if (!$('#draft').hidden) { closeDraft(); return; }
    if (!$('#popover').hidden) { closePopover(); return; }
    if (drag) { cancelDrag(); return; }
    if (jiggle) { setJiggle(false); return; }
    tutorialEvent('close');
    api().close();
  });

  wirePopover();
  wirePanelMenu();
  wireDraft();
}

/* ------------------------------------------------------------------ *
 *  Press / hold / drag                                                *
 * ------------------------------------------------------------------ */

function onPointerDown(e: PointerEvent): void {
  if (e.button !== 0) return;
  suppressClick = false;
  const t = e.target as HTMLElement;
  if (t.closest('button, input, #popover')) return;

  const row = t.closest<HTMLElement>('.note');
  const cardEl = t.closest<HTMLElement>('.card');
  if (!cardEl) return;

  lastPointer = { x: e.clientX, y: e.clientY };
  pending = {
    kind: row ? 'note' : 'card',
    el: row ?? cardEl,
    startX: e.clientX,
    startY: e.clientY,
    timer: undefined,
  };

  // In jiggle mode a drag starts on movement. Outside it, a hold enters
  // jiggle mode AND picks the element up, the way iOS does.
  if (jiggle) return;
  pending.timer = window.setTimeout(() => {
    if (!pending) return;
    const p = pending;
    pending = null;
    suppressClick = true;
    setJiggle(true);
    startDrag(p, lastPointer.x, lastPointer.y);
  }, HOLD_MS);
}

function onPointerMove(e: PointerEvent): void {
  lastPointer = { x: e.clientX, y: e.clientY };
  if (drawing) {
    updateDraw(e.clientX, e.clientY);
    return;
  }
  if (drag) {
    updateDrag(e.clientX, e.clientY);
    return;
  }
  if (!pending) return;
  const moved = Math.hypot(e.clientX - pending.startX, e.clientY - pending.startY) > DRAG_SLOP;
  if (!moved) return;

  if (jiggle) {
    const p = pending;
    pending = null;
    suppressClick = true;
    startDrag(p, e.clientX, e.clientY);
  } else {
    // Moving before the hold fired: this is a click or a scroll, not a hold.
    cancelPending();
  }
}

function onPointerUp(e: PointerEvent): void {
  if (drawing) {
    endDraw();
    return;
  }
  if (drag) {
    void endDrag(e.clientX, e.clientY);
    return;
  }
  cancelPending();
}

function cancelPending(): void {
  if (pending?.timer !== undefined) window.clearTimeout(pending.timer);
  pending = null;
}

async function onClick(e: MouseEvent): Promise<void> {
  if (suppressClick) {
    suppressClick = false;
    return;
  }
  const t = e.target as HTMLElement;
  const row = t.closest<HTMLElement>('.note');
  const cardEl = t.closest<HTMLElement>('.card');

  if (t.closest('.remove') && row?.dataset.id) {
    await apply(api().removeNote(row.dataset.id));
    return;
  }
  if (t.closest('.card-remove') && cardEl?.dataset.id) {
    await apply(api().removeCard(cardEl.dataset.id));
    return;
  }
  if (t.closest('.tint') && row) {
    openPopover(row);
    return;
  }
  if (t.closest('.composer')) return;
  if (row?.dataset.id && !jiggle) {
    await apply(api().toggleNote(row.dataset.id));
    tutorialEvent('toggle');
  }
}

function startDrag(p: Pending, x: number, y: number): void {
  const cardEl = p.el.closest<HTMLElement>('.card');
  if (!cardEl?.dataset.id) throw new Error('drag source is not inside a card');
  closePopover();

  const rect = p.el.getBoundingClientRect();
  const ghost = p.el.cloneNode(true) as HTMLElement;
  ghost.classList.add('ghost');
  ghost.style.left = `${rect.left}px`;
  ghost.style.top = `${rect.top}px`;
  ghost.style.width = `${rect.width}px`;
  document.body.appendChild(ghost);

  const siblings = p.kind === 'note'
    ? Array.from(cardEl.querySelectorAll<HTMLElement>('.note'))
    : [];
  const gap = document.createElement('li');
  gap.className = 'drop-gap';

  // Offset from where the pointer went DOWN, not from the move that crossed
  // the slop: the ghost then tracks the pointer from the first frame instead
  // of lagging by the slop distance for the whole drag.
  drag = {
    kind: p.kind,
    el: p.el,
    ghost,
    offX: p.startX - rect.left,
    offY: p.startY - rect.top,
    srcCardId: cardEl.dataset.id,
    srcIndex: siblings.indexOf(p.el),
    overCardEl: null,
    index: -1,
    gap,
  };
  p.el.classList.add('drag-source');
  document.body.classList.add('dragging');
  updateDrag(x, y);
}

function updateDrag(x: number, y: number): void {
  const d = drag;
  if (!d) return;
  d.ghost.style.left = `${x - d.offX}px`;
  d.ghost.style.top = `${y - d.offY}px`;
  if (d.kind === 'card') return;

  // Drop-target hit test. The ghost has pointer-events: none, and the source
  // row is display: none, so neither can catch its own drop.
  const over = Array.from($('#field').querySelectorAll<HTMLElement>('.card')).find((c) => {
    const r = c.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }) ?? null;

  if (over !== d.overCardEl) {
    d.gap.remove();
    d.overCardEl = over;
    d.index = -1;
  }
  if (!over) {
    d.ghost.classList.add('will-detach');
    return;
  }
  d.ghost.classList.remove('will-detach');

  const list = over.querySelector<HTMLElement>('.notes');
  if (!list) throw new Error('card has no note list');
  const rows = Array.from(list.querySelectorAll<HTMLElement>('.note')).filter((r) => r !== d.el);
  let index = rows.findIndex((r) => {
    const rr = r.getBoundingClientRect();
    return y < rr.top + rr.height / 2;
  });
  if (index === -1) index = rows.length;

  if (index !== d.index || !d.gap.isConnected) {
    d.index = index;
    if (index < rows.length) list.insertBefore(d.gap, rows[index]);
    else list.appendChild(d.gap);
  }
}

function teardownDrag(): Drag | null {
  const d = drag;
  if (!d) return null;
  drag = null;
  d.ghost.remove();
  d.gap.remove();
  d.el.classList.remove('drag-source');
  document.body.classList.remove('dragging');
  return d;
}

function cancelDrag(): void {
  teardownDrag();
  render();
}

async function endDrag(_x: number, _y: number): Promise<void> {
  const d = teardownDrag();
  if (!d) return;
  const id = d.el.dataset.id;
  if (!id) throw new Error('dragged element has no id');
  const left = parseFloat(d.ghost.style.left);
  const top = parseFloat(d.ghost.style.top);

  if (d.kind === 'card') {
    await apply(api().moveCard(id, left / W, top / H));
    tutorialEvent('moveCard');
    return;
  }

  const toId = d.overCardEl?.dataset.id;
  if (toId) {
    if (toId === d.srcCardId && d.index === d.srcIndex) {
      render();
      return;
    }
    await apply(api().moveNote(id, toId, d.index));
    return;
  }

  await apply(api().detachNote(id, (left - DETACH_DX) / W, (top - DETACH_DY) / H));
}

/* ------------------------------------------------------------------ *
 *  Tint popover                                                       *
 * ------------------------------------------------------------------ */

let popoverNoteId: string | null = null;

function wirePopover(): void {
  const pop = $('#popover');
  const swatches = pop.querySelector<HTMLElement>('.swatches')!;
  for (const key of TINT_KEYS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'swatch';
    b.dataset.tint = key;
    b.title = key;
    b.style.setProperty('--sh', String(TINTS[key].h));
    b.style.setProperty('--ss', `${TINTS[key].s}%`);
    swatches.appendChild(b);
  }

  swatches.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('.swatch');
    const tint = b?.dataset.tint as TintKey | undefined;
    if (!tint || !popoverNoteId) return;
    void restyle(popoverNoteId, { tint }, true).then(() => { tutorialEvent('colour'); });
  });

  const slider = pop.querySelector<HTMLInputElement>('input[type=range]')!;
  // Live preview on every tick; persist once on release, so dragging the
  // slider does not write board.json sixty times a second.
  slider.addEventListener('input', () => {
    if (popoverNoteId) void restyle(popoverNoteId, { intensity: Number(slider.value) }, false);
  });
  slider.addEventListener('change', () => {
    if (popoverNoteId) void restyle(popoverNoteId, { intensity: Number(slider.value) }, true);
  });
}

function openPopover(row: HTMLElement): void {
  const id = row.dataset.id;
  const note = id ? noteById(id) : null;
  if (!id || !note) return;
  popoverNoteId = id;

  const pop = $('#popover');
  pop.querySelectorAll<HTMLElement>('.swatch').forEach((s) => {
    s.classList.toggle('active', s.dataset.tint === note.style.tint);
  });
  pop.querySelector<HTMLInputElement>('input[type=range]')!.value = String(note.style.intensity);

  pop.hidden = false;
  const r = row.getBoundingClientRect();
  const pw = pop.offsetWidth;
  const ph = pop.offsetHeight;
  let left = r.right + 12;
  if (left + pw > W - EDGE_INSET) left = r.left - pw - 12;
  let top = r.top;
  if (top + ph > H - EDGE_INSET) top = H - EDGE_INSET - ph;
  pop.style.left = `${Math.max(EDGE_INSET, left)}px`;
  pop.style.top = `${Math.max(EDGE_INSET, top)}px`;
}

function closePopover(): void {
  $('#popover').hidden = true;
  popoverNoteId = null;
}

/** Restyle the row in place (no re-render, so the popover stays open). */
async function restyle(id: string, patch: Partial<NoteStyle>, persist: boolean): Promise<void> {
  const note = noteById(id);
  if (!note) return;
  note.style = { ...note.style, ...patch };
  const row = $('#field').querySelector<HTMLElement>(`.note[data-id="${id}"]`);
  if (row) applyNoteStyle(row, note.style);
  $('#popover').querySelectorAll<HTMLElement>('.swatch').forEach((s) => {
    s.classList.toggle('active', s.dataset.tint === note.style.tint);
  });
  if (persist) cards = await api().setNoteStyle(id, patch);
}

/* ------------------------------------------------------------------ *
 *  Draw a panel                                                       *
 * ------------------------------------------------------------------ */

/**
 * Press on empty space and drag: a dashed rectangle follows the pointer and,
 * on release, a draft panel opens at its top-left corner. Panels have one
 * fixed width, so the rectangle chooses WHERE, not how big. A press that
 * never moves past DRAW_SLOP stays a plain click and does nothing, so a stray
 * click on the wallpaper cannot leave an empty panel behind.
 */
const DRAW_SLOP = 12;

let drawing: { x0: number; y0: number; x1: number; y1: number; shown: boolean } | null = null;
let draftAt: { x: number; y: number } | null = null;

function beginDraw(x: number, y: number): void {
  drawing = { x0: x, y0: y, x1: x, y1: y, shown: false };
}

function updateDraw(x: number, y: number): void {
  const d = drawing;
  if (!d) return;
  d.x1 = x;
  d.y1 = y;
  if (!d.shown && Math.hypot(x - d.x0, y - d.y0) < DRAW_SLOP) return;
  d.shown = true;
  const r = $('#drawrect');
  r.hidden = false;
  r.style.left = `${Math.min(d.x0, d.x1)}px`;
  r.style.top = `${Math.min(d.y0, d.y1)}px`;
  r.style.width = `${Math.abs(d.x1 - d.x0)}px`;
  r.style.height = `${Math.abs(d.y1 - d.y0)}px`;
}

function endDraw(): void {
  const d = drawing;
  cancelDraw();
  if (!d?.shown) return;
  openDraft(Math.min(d.x0, d.x1), Math.min(d.y0, d.y1));
}

function cancelDraw(): void {
  drawing = null;
  $('#drawrect').hidden = true;
}

function openDraft(x: number, y: number): void {
  const el = $('#draft');
  el.style.width = `${cardW}px`;
  el.hidden = false;
  // Keep the whole draft on screen; the stored position is clamped the same
  // way by pinCard when the panel is drawn for real.
  const left = Math.max(EDGE_INSET, Math.min(x, W - cardW - EDGE_INSET));
  const top = Math.max(EDGE_INSET, Math.min(y, H - el.offsetHeight - EDGE_INSET));
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  draftAt = { x: left, y: top };
  const input = el.querySelector<HTMLInputElement>('input')!;
  input.value = '';
  input.focus();
}

function closeDraft(): void {
  $('#draft').hidden = true;
  draftAt = null;
}

function wireDraft(): void {
  const input = $<HTMLInputElement>('#draft input');
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeDraft();
      return;
    }
    if (e.key !== 'Enter') return;
    const text = input.value.trim();
    const at = draftAt;
    if (!text || !at) return;
    closeDraft();
    void apply(api().addCard(text, at.x / W, at.y / H)).then(() => { tutorialEvent('addCard'); });
  });
}

/* ------------------------------------------------------------------ *
 *  Panel menu (right-click a panel)                                   *
 * ------------------------------------------------------------------ */

let menuCardId: string | null = null;
/** Delete takes two clicks: a panel and all its notes cannot be brought back. */
let deleteArmed = false;

function cardByIdLocal(id: string): Card | null {
  return cards.find((c) => c.id === id) ?? null;
}

function cardEl(id: string): HTMLElement | null {
  return $('#field').querySelector<HTMLElement>(`.card[data-id="${id}"]`);
}

function wirePanelMenu(): void {
  const menu = $('#panelmenu');

  const swatches = menu.querySelector<HTMLElement>('.pm-swatches')!;
  const none = document.createElement('button');
  none.type = 'button';
  none.className = 'swatch none';
  none.dataset.tint = '';
  none.title = 'no colour';
  swatches.appendChild(none);
  for (const key of TINT_KEYS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'swatch';
    b.dataset.tint = key;
    b.title = key;
    b.style.setProperty('--sh', String(TINTS[key].h));
    b.style.setProperty('--ss', `${TINTS[key].s}%`);
    swatches.appendChild(b);
  }
  swatches.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('.swatch');
    if (!b || b.dataset.tint === undefined) return;
    const tint = b.dataset.tint === '' ? null : (b.dataset.tint as TintKey);
    void restylePanel({ tint }, true);
  });

  const presets = menu.querySelector<HTMLElement>('.pm-presets')!;
  for (const p of GLASS_PRESETS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = p.label;
    b.dataset.glass = String(p.glass);
    presets.appendChild(b);
  }
  presets.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('button');
    if (!b?.dataset.glass) return;
    void restylePanel({ glass: Number(b.dataset.glass) }, true);
  });

  const slider = menu.querySelector<HTMLInputElement>('.pm-glass')!;
  // Preview every tick, persist once on release (same as the note slider).
  slider.addEventListener('input', () => { void restylePanel({ glass: Number(slider.value) }, false); });
  slider.addEventListener('change', () => { void restylePanel({ glass: Number(slider.value) }, true); });

  menu.querySelector<HTMLElement>('.pm-rename')!.addEventListener('click', () => {
    const id = menuCardId;
    closePanelMenu();
    if (id) startRename(id);
  });

  const del = menu.querySelector<HTMLElement>('.pm-delete')!;
  del.addEventListener('click', () => {
    const id = menuCardId;
    if (!id) return;
    if (!deleteArmed) {
      deleteArmed = true;
      del.classList.add('armed');
      del.textContent = 'Click again to delete';
      return;
    }
    closePanelMenu();
    void apply(api().removeCard(id));
  });
}

function openPanelMenu(el: HTMLElement, x: number, y: number): void {
  const id = el.dataset.id;
  const card = id ? cardByIdLocal(id) : null;
  if (!id || !card) return;
  menuCardId = id;
  deleteArmed = false;

  const menu = $('#panelmenu');
  const del = menu.querySelector<HTMLElement>('.pm-delete')!;
  del.classList.remove('armed');
  del.textContent = 'Delete panel';
  syncPanelMenu(card.style);

  menu.hidden = false;
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  const left = x + mw + EDGE_INSET > W ? x - mw : x;
  const top = y + mh + EDGE_INSET > H ? H - EDGE_INSET - mh : y;
  menu.style.left = `${Math.max(EDGE_INSET, left)}px`;
  menu.style.top = `${Math.max(EDGE_INSET, top)}px`;
}

function closePanelMenu(): void {
  $('#panelmenu').hidden = true;
  menuCardId = null;
  deleteArmed = false;
}

function syncPanelMenu(style: CardStyle): void {
  const menu = $('#panelmenu');
  menu.querySelectorAll<HTMLElement>('.pm-swatches .swatch').forEach((s) => {
    s.classList.toggle('active', (s.dataset.tint || null) === style.tint);
  });
  menu.querySelectorAll<HTMLElement>('.pm-presets button').forEach((b) => {
    b.classList.toggle('active', Math.abs(Number(b.dataset.glass) - style.glass) < 0.005);
  });
  menu.querySelector<HTMLInputElement>('.pm-glass')!.value = String(style.glass);
}

/** Restyle the panel in place (no re-render, so the menu stays open). */
async function restylePanel(patch: Partial<CardStyle>, persist: boolean): Promise<void> {
  const id = menuCardId;
  const card = id ? cardByIdLocal(id) : null;
  if (!id || !card) return;
  card.style = { ...card.style, ...patch };
  const el = cardEl(id);
  if (el) applyCardStyle(el, card.style);
  syncPanelMenu(card.style);
  if (persist) cards = await api().setCardStyle(id, patch);
}

/** Swap the header's title for a text box; Enter or clicking away saves. */
function startRename(id: string): void {
  const el = cardEl(id);
  const card = cardByIdLocal(id);
  const brand = el?.querySelector<HTMLElement>('header .brand');
  if (!el || !card || !brand) return;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'rename';
  input.value = card.title ?? '';
  input.placeholder = 'Panel name';
  input.maxLength = 40;
  input.spellcheck = false;
  brand.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const commit = (): void => {
    if (done) return;
    done = true;
    void apply(api().setCardTitle(id, input.value));
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); return; }
    if (e.key === 'Escape') {
      // Cancel the rename only; do not let Esc go on to close the board.
      e.stopPropagation();
      done = true;
      render();
    }
  });
  input.addEventListener('blur', commit);
}

/* ------------------------------------------------------------------ *
 *  Tutorial                                                           *
 * ------------------------------------------------------------------ */

/**
 * First-run tutorial. A step never advances on a "Next" button: it waits for
 * the user to do the thing it describes, so finishing the tour means having
 * done every gesture once. Steps whose target does not exist (ticking a note
 * on an empty board) are skipped rather than pointing at nothing.
 */
type TutorialEvent = 'toggle' | 'addNote' | 'addCard' | 'moveCard' | 'colour' | 'close';

interface TutorialStep {
  event: TutorialEvent;
  title: string;
  body: (hotkey: string) => string;
  /** What to highlight; null only for the final step, which needs none. */
  target: () => HTMLElement | null;
}

const STEPS: TutorialStep[] = [
  {
    event: 'toggle',
    title: 'Tick something off',
    body: () => 'Click a note to mark it done. Click it again to bring it back.',
    target: () => document.querySelector<HTMLElement>('#field .note'),
  },
  {
    event: 'addNote',
    title: 'Add a note',
    body: () => 'Type something in the "Add to this panel" box and press Enter.',
    target: () => document.querySelector<HTMLElement>('#field .composer input'),
  },
  {
    event: 'addCard',
    title: 'Make your own panel',
    body: () => 'Type a first note in "New panel" at the bottom and press Enter, or drag on an '
      + 'empty spot to put a panel exactly there. Each panel is its own list: today, groceries, ideas...',
    target: () => document.querySelector<HTMLElement>('#newcard input'),
  },
  {
    event: 'moveCard',
    title: 'Put it where you want',
    body: () => 'Press and hold a panel for half a second until it wiggles, then drag it anywhere.',
    target: () => document.querySelector<HTMLElement>('#field .card'),
  },
  {
    event: 'colour',
    title: 'Give it a colour',
    body: () => 'Right-click any note and pick a colour. The slider sets how strong it is.',
    target: () => document.querySelector<HTMLElement>('#field .note'),
  },
  {
    event: 'close',
    title: 'Save it to your desktop',
    body: (hotkey) => 'Press Esc. Your panels become part of your wallpaper, so they stay '
      + `on your desktop even when Hazeboard is closed. Press ${hotkey} to open the board again.`,
    target: () => null,
  },
];

let tutorialStep: number | null = null;
let tutorialHotkey = '';

/** The first step from `i` on that has something to point at. */
function firstAvailable(i: number): number {
  let k = i;
  while (k < STEPS.length - 1 && !STEPS[k].target()) k++;
  return k;
}

function startTutorial(hotkey: string): void {
  tutorialHotkey = hotkey;
  tutorialStep = firstAvailable(0);
  showCoach();
}

function endTutorial(): void {
  tutorialStep = null;
  $('#coach').hidden = true;
  highlightTarget();
}

function tutorialEvent(ev: TutorialEvent): void {
  if (tutorialStep === null || STEPS[tutorialStep].event !== ev) return;
  if (tutorialStep === STEPS.length - 1) {
    endTutorial();
    return;
  }
  tutorialStep = firstAvailable(tutorialStep + 1);
  showCoach();
}

function showCoach(): void {
  if (tutorialStep === null) return;
  const step = STEPS[tutorialStep];
  const last = tutorialStep === STEPS.length - 1;
  $('#coach .coach-step').textContent = `Step ${tutorialStep + 1} of ${STEPS.length}`;
  $('#coach .coach-title').textContent = step.title;
  $('#coach .coach-body').textContent = step.body(tutorialHotkey);
  $('#coach .coach-skip').hidden = last;
  $('#coach .coach-done').hidden = !last;
  $('#coach').hidden = false;
  highlightTarget();
}

function highlightTarget(): void {
  document.querySelectorAll('.coach-target').forEach((el) => el.classList.remove('coach-target'));
  if (tutorialStep === null) return;
  STEPS[tutorialStep].target()?.classList.add('coach-target');
}

const w = window as unknown as Record<string, unknown>;
w.__initOverlay = initOverlay;
w.__focusNewPanel = (): void => { $<HTMLInputElement>("#newcard input").focus(); };
