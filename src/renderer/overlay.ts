/// <reference lib="dom" />
import {
  TINTS, TINT_KEYS,
  type Card, type Note, type NoteStyle, type OverlayPayload, type TintKey,
} from '../shared/types';
import { EDGE_INSET, pinCard } from '../shared/layout';
import { footerFor } from '../shared/footer';
import { buildCard, applyNoteStyle, settled } from './card';

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
  setJiggle(false);
  render();
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
}

function updateHint(): void {
  $('#hint').textContent = jiggle
    ? 'drag to arrange  ·  drop a note outside to make a panel  ·  esc to finish'
    : cards.length === 0
      ? 'type below to make your first panel  ·  esc to close'
      : 'click to tick  ·  hold to arrange  ·  right-click for colour  ·  esc to close';
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

  field.addEventListener('contextmenu', (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('.note');
    if (!row) return;
    e.preventDefault();
    openPopover(row);
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
    void apply(api().addNote(cardEl.dataset.id, text));
  });

  const newCard = $<HTMLInputElement>('#newcard input');
  newCard.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const text = newCard.value.trim();
    if (!text) return;
    newCard.value = '';
    void apply(api().addCard(text));
  });

  // Clicking the wallpaper leaves jiggle mode, like tapping the home screen.
  document.body.addEventListener('pointerdown', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('.card, #popover, #newcard')) return;
    closePopover();
    if (jiggle && !drag) setJiggle(false);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    if (!$('#popover').hidden) { closePopover(); return; }
    if (drag) { cancelDrag(); return; }
    if (jiggle) { setJiggle(false); return; }
    api().close();
  });

  wirePopover();
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
    void restyle(popoverNoteId, { tint }, true);
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

const w = window as unknown as Record<string, unknown>;
w.__initOverlay = initOverlay;
w.__focusNewPanel = (): void => { $<HTMLInputElement>("#newcard input").focus(); };
