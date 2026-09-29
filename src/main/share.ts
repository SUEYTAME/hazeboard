import {
  normalizeStyle, normalizeCardStyle,
  type Card, type CardStyle, type NoteStyle,
} from '../shared/types';

/**
 * The .hazeboard file: panels (with their notes) that someone can send to
 * someone else. Importing ADDS the panels; it never edits existing ones.
 *
 * Deliberately NOT board.json. No ids (the importer mints fresh ones, so two
 * imports of one file cannot collide), no dates, and no baseWallpaper - a
 * file path from somebody else's machine has no business on this one.
 *
 * Kept free of Electron so scripts/check-share.js can test it with plain node.
 */

export const SHARE_EXT = 'hazeboard';
export const SHARE_FORMAT = 'hazeboard-panels';
export const SHARE_VERSION = 1;

/** A file anyone can send you is untrusted: everything below is a hard limit. */
export const MAX_FILE_BYTES = 256 * 1024;
export const MAX_PANELS = 20;
export const MAX_NOTES_PER_PANEL = 50;
export const MAX_NOTE_CHARS = 500;
export const MAX_TITLE_CHARS = 40;

export interface SharedNote {
  text: string;
  done: boolean;
  style: NoteStyle;
}

export interface SharedPanel {
  title: string | null;
  /** Top-left, 0..1 of the screen, same as Card. */
  x: number;
  y: number;
  style: CardStyle;
  notes: SharedNote[];
}

export interface SharedFile {
  format: typeof SHARE_FORMAT;
  version: number;
  panels: SharedPanel[];
}

/** A problem with a file, worded for the person who double-clicked it. */
export class ShareError extends Error {}

export function toShared(cards: Card[]): SharedFile {
  return {
    format: SHARE_FORMAT,
    version: SHARE_VERSION,
    panels: cards.map((c) => ({
      title: c.title,
      x: c.x,
      y: c.y,
      style: { ...c.style },
      notes: c.notes.map((n) => ({ text: n.text, done: n.done, style: { ...n.style } })),
    })),
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function position(v: unknown, which: string, panel: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new ShareError(`Panel ${panel} has no valid ${which} position.`);
  }
  return Math.min(1, Math.max(0, v));
}

function parseNote(raw: unknown, panel: number, index: number): SharedNote {
  if (!isObject(raw) || typeof raw.text !== 'string') {
    throw new ShareError(`Note ${index} on panel ${panel} has no text.`);
  }
  const text = raw.text.trim();
  if (!text) throw new ShareError(`Note ${index} on panel ${panel} is empty.`);
  if (text.length > MAX_NOTE_CHARS) {
    throw new ShareError(`Note ${index} on panel ${panel} is longer than ${MAX_NOTE_CHARS} characters.`);
  }
  return {
    text,
    done: raw.done === true,
    style: normalizeStyle(isObject(raw.style) ? (raw.style as Partial<NoteStyle>) : undefined),
  };
}

function parsePanel(raw: unknown, panel: number): SharedPanel {
  if (!isObject(raw)) throw new ShareError(`Panel ${panel} is not readable.`);

  let title: string | null = null;
  if (raw.title !== null && raw.title !== undefined) {
    if (typeof raw.title !== 'string') throw new ShareError(`Panel ${panel} has an unreadable name.`);
    const t = raw.title.trim();
    if (t.length > MAX_TITLE_CHARS) {
      throw new ShareError(`Panel ${panel}'s name is longer than ${MAX_TITLE_CHARS} characters.`);
    }
    title = t || null;
  }

  if (!Array.isArray(raw.notes) || raw.notes.length === 0) {
    throw new ShareError(`Panel ${panel} has no notes.`);
  }
  if (raw.notes.length > MAX_NOTES_PER_PANEL) {
    throw new ShareError(`Panel ${panel} has more than ${MAX_NOTES_PER_PANEL} notes.`);
  }

  return {
    title,
    x: position(raw.x, 'x', panel),
    y: position(raw.y, 'y', panel),
    style: normalizeCardStyle(isObject(raw.style) ? (raw.style as Partial<CardStyle>) : undefined),
    notes: raw.notes.map((n, i) => parseNote(n, panel, i + 1)),
  };
}

/**
 * Validate a file's text. Throws ShareError rather than importing part of a
 * bad file: a half-imported board is harder to notice than a clear refusal.
 * Colours and glass are sanitised (unknown tint -> default) because that is
 * cosmetic; structure and text are refused because that is content.
 */
export function parseShared(text: string): SharedPanel[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ShareError('This file could not be read. It may be damaged, or not a Hazeboard file.');
  }
  if (!isObject(data) || data.format !== SHARE_FORMAT) {
    throw new ShareError('This is not a Hazeboard panels file.');
  }
  if (typeof data.version !== 'number' || !Number.isInteger(data.version) || data.version < 1) {
    throw new ShareError('This Hazeboard file has no valid version.');
  }
  if (data.version > SHARE_VERSION) {
    throw new ShareError('This file was made by a newer version of Hazeboard. Update Hazeboard to open it.');
  }
  if (!Array.isArray(data.panels) || data.panels.length === 0) {
    throw new ShareError('This file has no panels in it.');
  }
  if (data.panels.length > MAX_PANELS) {
    throw new ShareError(`This file has more than ${MAX_PANELS} panels.`);
  }
  return data.panels.map((p, i) => parsePanel(p, i + 1));
}

/** "Groceries" -> "Groceries.hazeboard"; anything Windows forbids is dropped. */
export function shareFileName(base: string): string {
  const clean = base.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').trim().replace(/[. ]+$/, '');
  return `${clean || 'Hazeboard panels'}.${SHARE_EXT}`;
}

/**
 * The .hazeboard path in a command line, if any. Windows passes the file as a
 * plain argument; Chromium's own switches start with "--" and are skipped.
 */
export function findShareFile(args: readonly string[]): string | null {
  const hit = args.find((a) => !a.startsWith('--') && a.toLowerCase().endsWith(`.${SHARE_EXT}`));
  return hit ?? null;
}
