import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import {
  STATE_VERSION, DEFAULT_STYLE, normalizeStyle,
  type BoardState, type Card, type Note, type NoteStyle,
} from '../shared/types';

export function dataDir(): string {
  const dir = app.getPath('userData');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Where generated wallpapers are written.
 *
 * Deliberately NOT under app.getPath('userData'). IDesktopWallpaper refuses any
 * image living under AppData (Roaming or Local) with a flatly misleading
 * 0x80070002 "file not found" for a file that is definitely there. Verified by
 * copying identical bytes to several directories: Pictures and the user profile
 * root work, everything under AppData fails.
 */
export function outDir(): string {
  const dir = path.join(app.getPath('pictures'), 'Glassboard');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function statePath(): string {
  return path.join(dataDir(), 'board.json');
}

function newId(): string {
  return randomUUID().slice(0, 8);
}

/** Where the v1 card sat: right-hand side, clear of the desktop icons. */
const MIGRATED_X = 0.66;
const MIGRATED_Y = 0.3;

function emptyState(): BoardState {
  return {
    version: STATE_VERSION,
    cards: [],
    baseWallpaper: null,
    updatedAt: new Date(0).toISOString(),
  };
}

/* ------------------------------------------------------------------ *
 *  Load / migrate / save                                              *
 * ------------------------------------------------------------------ */

interface LegacyState {
  notes?: unknown;
  cards?: unknown;
  version?: number;
  baseWallpaper?: string | null;
  updatedAt?: string;
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

function reviveNote(raw: unknown): Note | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const n = raw as Partial<Note>;
  if (typeof n.text !== 'string') return null;
  return {
    id: typeof n.id === 'string' && n.id ? n.id : newId(),
    text: n.text,
    done: Boolean(n.done),
    createdAt: typeof n.createdAt === 'string' ? n.createdAt : new Date().toISOString(),
    style: normalizeStyle(n.style),
  };
}

function reviveCard(raw: unknown): Card | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const c = raw as Partial<Card>;
  const notes = Array.isArray(c.notes)
    ? c.notes.map(reviveNote).filter((n): n is Note => n !== null)
    : [];
  return {
    id: typeof c.id === 'string' && c.id ? c.id : newId(),
    title: typeof c.title === 'string' ? c.title : null,
    notes,
    x: typeof c.x === 'number' ? clamp01(c.x) : MIGRATED_X,
    y: typeof c.y === 'number' ? clamp01(c.y) : MIGRATED_Y,
    createdAt: typeof c.createdAt === 'string' ? c.createdAt : new Date().toISOString(),
  };
}

/**
 * v1 kept a flat `notes` array and drew it as one card locked to the right
 * edge. Fold that into a single card at roughly where it used to sit, so an
 * upgrade looks like nothing happened rather than like the board was wiped.
 */
function migrate(parsed: LegacyState): BoardState {
  if (Array.isArray(parsed.cards)) {
    const cards = parsed.cards.map(reviveCard).filter((c): c is Card => c !== null);
    return {
      version: STATE_VERSION,
      cards,
      baseWallpaper: parsed.baseWallpaper ?? null,
      updatedAt: parsed.updatedAt ?? new Date(0).toISOString(),
    };
  }

  if (!Array.isArray(parsed.notes)) {
    throw new Error(`${statePath()} is malformed: neither "cards" nor "notes" is an array`);
  }

  const notes = parsed.notes.map(reviveNote).filter((n): n is Note => n !== null);
  const cards: Card[] = notes.length
    ? [{
        id: newId(),
        title: null,
        notes,
        x: MIGRATED_X,
        y: MIGRATED_Y,
        createdAt: new Date().toISOString(),
      }]
    : [];

  return {
    version: STATE_VERSION,
    cards,
    baseWallpaper: parsed.baseWallpaper ?? null,
    updatedAt: parsed.updatedAt ?? new Date(0).toISOString(),
  };
}

export function load(): BoardState {
  const file = statePath();
  if (!fs.existsSync(file)) return emptyState();

  const raw = fs.readFileSync(file, 'utf8');
  const parsed = JSON.parse(raw) as LegacyState;
  const state = migrate(parsed);
  // A v1 file gets fresh card ids on every load until something saves. Persist
  // the migration at once so `board cards` and `board rmcard` see stable ids.
  if (!Array.isArray(parsed.cards)) save(state);
  return state;
}

export function save(state: BoardState): void {
  state.version = STATE_VERSION;
  state.updatedAt = new Date().toISOString();
  // Write-then-rename so a crash mid-write can't leave a truncated board.json.
  const file = statePath();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

/* ------------------------------------------------------------------ *
 *  Lookup                                                             *
 * ------------------------------------------------------------------ */

export interface NoteHit {
  card: Card;
  note: Note;
  index: number;
}

/** Resolve an id prefix to exactly one note, or throw with something actionable. */
function resolveNote(state: BoardState, idPrefix: string): NoteHit {
  const hits: NoteHit[] = [];
  for (const card of state.cards) {
    card.notes.forEach((note, index) => {
      if (note.id.startsWith(idPrefix)) hits.push({ card, note, index });
    });
  }
  if (hits.length === 0) throw new Error(`no note matching id "${idPrefix}"`);
  if (hits.length > 1) {
    throw new Error(`id "${idPrefix}" is ambiguous: ${hits.map((h) => h.note.id).join(', ')}`);
  }
  return hits[0];
}

function resolveCard(state: BoardState, idPrefix: string): Card {
  const hits = state.cards.filter((c) => c.id.startsWith(idPrefix));
  if (hits.length === 0) throw new Error(`no card matching id "${idPrefix}"`);
  if (hits.length > 1) {
    throw new Error(`id "${idPrefix}" is ambiguous: ${hits.map((c) => c.id).join(', ')}`);
  }
  return hits[0];
}

export function allNotes(state: BoardState): Note[] {
  return state.cards.flatMap((c) => c.notes);
}

/**
 * A card with nothing in it is litter - the only way to make one is to drag its
 * last note somewhere else. iOS collapses an emptied folder the same way.
 */
function pruneEmpty(state: BoardState): void {
  state.cards = state.cards.filter((c) => c.notes.length > 0);
}

/**
 * Stagger new cards so a run of them cannot stack into one illegible pile.
 * Slots already taken by a card (within a step of it) are skipped, otherwise
 * the first card added after a migration lands exactly on the migrated one.
 */
function nextPosition(state: BoardState): { x: number; y: number } {
  const step = 0.04;
  const slot = (k: number): { x: number; y: number } =>
    ({ x: clamp01(0.62 + (k % 4) * step), y: clamp01(0.18 + (k % 6) * step) });
  const taken = (p: { x: number; y: number }): boolean =>
    state.cards.some((c) => Math.abs(c.x - p.x) < step && Math.abs(c.y - p.y) < step);

  for (let k = state.cards.length; k < state.cards.length + 24; k++) {
    const p = slot(k);
    if (!taken(p)) return p;
  }
  return slot(state.cards.length);
}

/* ------------------------------------------------------------------ *
 *  Mutations                                                          *
 * ------------------------------------------------------------------ */

export function addCard(text: string, at?: { x: number; y: number }): Card {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('note text is empty');

  const state = load();
  const pos = at ?? nextPosition(state);
  const card: Card = {
    id: newId(),
    title: null,
    notes: [{
      id: newId(),
      text: trimmed,
      done: false,
      createdAt: new Date().toISOString(),
      style: { ...DEFAULT_STYLE },
    }],
    x: clamp01(pos.x),
    y: clamp01(pos.y),
    createdAt: new Date().toISOString(),
  };
  state.cards.push(card);
  save(state);
  return card;
}

/** Append to a specific card, or to the first one, creating a card if none exist. */
export function addNote(text: string, cardIdPrefix?: string): { card: Card; note: Note } {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('note text is empty');

  const state = load();
  if (state.cards.length === 0 && !cardIdPrefix) {
    const card = addCard(trimmed);
    return { card, note: card.notes[0] };
  }

  const card = cardIdPrefix ? resolveCard(state, cardIdPrefix) : state.cards[0];
  const note: Note = {
    id: newId(),
    text: trimmed,
    done: false,
    createdAt: new Date().toISOString(),
    style: { ...DEFAULT_STYLE },
  };
  card.notes.push(note);
  save(state);
  return { card, note };
}

export function toggleNote(idPrefix: string): Note {
  const state = load();
  const { note } = resolveNote(state, idPrefix);
  note.done = !note.done;
  save(state);
  return note;
}

export function removeNote(idPrefix: string): Note {
  const state = load();
  const { card, note } = resolveNote(state, idPrefix);
  card.notes = card.notes.filter((n) => n.id !== note.id);
  pruneEmpty(state);
  save(state);
  return note;
}

export function removeCard(idPrefix: string): Card {
  const state = load();
  const card = resolveCard(state, idPrefix);
  state.cards = state.cards.filter((c) => c.id !== card.id);
  save(state);
  return card;
}

export function clearDone(): number {
  const state = load();
  const before = allNotes(state).length;
  for (const card of state.cards) card.notes = card.notes.filter((n) => !n.done);
  pruneEmpty(state);
  save(state);
  return before - allNotes(state).length;
}

export function moveCard(idPrefix: string, x: number, y: number): Card {
  const state = load();
  const card = resolveCard(state, idPrefix);
  card.x = clamp01(x);
  card.y = clamp01(y);
  save(state);
  return card;
}

/**
 * Move a note to `index` inside `toCardId`. One code path covers two gestures:
 * reordering inside its own card, and dropping onto a different card.
 *
 * The note is spliced OUT before the index is clamped, so dragging a note
 * downward within its own card lands where the gap was shown rather than one
 * row short - the classic off-by-one of every drag-reorder list.
 */
export function moveNote(noteIdPrefix: string, toCardIdPrefix: string, index: number): Note {
  const state = load();
  const { card: from, note } = resolveNote(state, noteIdPrefix);
  const to = resolveCard(state, toCardIdPrefix);

  from.notes = from.notes.filter((n) => n.id !== note.id);
  const at = Math.min(Math.max(0, Math.round(index)), to.notes.length);
  to.notes.splice(at, 0, note);

  pruneEmpty(state);
  save(state);
  return note;
}

/** Pull a note out of its card and give it a card of its own at (x, y). */
export function detachNote(noteIdPrefix: string, x: number, y: number): Card {
  const state = load();
  const { card: from, note } = resolveNote(state, noteIdPrefix);

  from.notes = from.notes.filter((n) => n.id !== note.id);
  const card: Card = {
    id: newId(),
    title: null,
    notes: [note],
    x: clamp01(x),
    y: clamp01(y),
    createdAt: new Date().toISOString(),
  };
  state.cards.push(card);

  pruneEmpty(state);
  save(state);
  return card;
}

export function setNoteStyle(noteIdPrefix: string, style: Partial<NoteStyle>): Note {
  const state = load();
  const { note } = resolveNote(state, noteIdPrefix);
  note.style = normalizeStyle({ ...note.style, ...style });
  save(state);
  return note;
}

export function setBase(imagePath: string): void {
  const state = load();
  state.baseWallpaper = imagePath;
  save(state);
}
