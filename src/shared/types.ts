/* ------------------------------------------------------------------ *
 *  Tints                                                              *
 * ------------------------------------------------------------------ */

/**
 * Per-note colour, stored as a palette KEY rather than a hex string.
 *
 * The key is a promise that the look can be retuned later - warmer greens, a
 * softer red - without rewriting every board.json that already exists. Each
 * entry is a hue/saturation pair; the renderer derives every shade it needs
 * from these plus the note's intensity, so a tint can never be "half applied"
 * with a stale accent colour left behind.
 */
export const TINTS = {
  graphite: { h: 222, s: 10 },
  red: { h: 3, s: 78 },
  orange: { h: 28, s: 88 },
  yellow: { h: 45, s: 90 },
  green: { h: 142, s: 55 },
  mint: { h: 175, s: 60 },
  blue: { h: 211, s: 90 },
  indigo: { h: 245, s: 60 },
  purple: { h: 280, s: 55 },
  pink: { h: 340, s: 75 },
} as const;

export type TintKey = keyof typeof TINTS;

export const TINT_KEYS = Object.keys(TINTS) as TintKey[];

export const DEFAULT_TINT: TintKey = 'graphite';

export interface NoteStyle {
  tint: TintKey;
  /**
   * 0..1. How strongly the tint washes the row - this is the "contrast"
   * control. 0 leaves the row as plain glass; 1 is a saturated slab.
   */
  intensity: number;
}

export const DEFAULT_STYLE: NoteStyle = { tint: DEFAULT_TINT, intensity: 0.32 };

/** A tint key that came from disk is untrusted; fall back rather than throw. */
export function normalizeStyle(s: Partial<NoteStyle> | undefined): NoteStyle {
  const tint = s?.tint && s.tint in TINTS ? s.tint : DEFAULT_TINT;
  const raw = typeof s?.intensity === 'number' ? s.intensity : DEFAULT_STYLE.intensity;
  return { tint, intensity: Math.min(1, Math.max(0, raw)) };
}

/* ------------------------------------------------------------------ *
 *  Board                                                              *
 * ------------------------------------------------------------------ */

export interface Note {
  id: string;
  text: string;
  done: boolean;
  createdAt: string;
  style: NoteStyle;
}

/**
 * A card is the draggable unit. Notes travel with it; pulling a note out of
 * one makes a new card, which is why position lives here and not on Note.
 */
export interface Card {
  id: string;
  title: string | null;
  notes: Note[];
  /**
   * Top-left corner, normalised 0..1 against the wallpaper size.
   *
   * Absolute pixels would send every card off-screen the first time the
   * display resolution changed; a fraction moves them proportionally instead.
   */
  x: number;
  y: number;
  createdAt: string;
}

export const STATE_VERSION = 2;

export interface BoardState {
  version: number;
  cards: Card[];
  /** Base wallpaper the cards are composited onto. Null = current desktop wallpaper. */
  baseWallpaper: string | null;
  updatedAt: string;
}

/* ------------------------------------------------------------------ *
 *  Rendering                                                          *
 * ------------------------------------------------------------------ */

/**
 * Where ONE card sits, in real wallpaper pixels.
 *
 * We render a single card's region in the DOM and composite it onto a
 * full-size canvas, because a browser window can never exceed the monitor's
 * work area (measured: 912 of 960 DIP here) but a canvas has no size limit.
 * Cards are baked one at a time for the same reason - two cards at opposite
 * corners can span more than a window is allowed to be.
 */
export interface Geometry {
  canvasW: number;
  canvasH: number;
  regionX: number;
  regionY: number;
  regionW: number;
  regionH: number;
  cardW: number;
  /**
   * The card's top-left INSIDE the region. v1 got away with a single margin
   * because the card was pinned to the right edge and vertically centred; a
   * card that can be dropped anywhere needs both axes stated, and they stop
   * being equal as soon as the region is clamped against a screen edge.
   */
  cardOffsetX: number;
  cardOffsetY: number;
  /** Ceiling on card height so a long card cannot overflow its own region. */
  cardMaxH: number;
}

/** One card, rendered for baking into the wallpaper. */
export interface WallpaperPayload {
  mode: 'wallpaper';
  card: Card;
  /** file:// URL of the base image. */
  backgroundUrl: string;
  geometry: Geometry;
  /** Footer hint line; empty string hides the footer. */
  footer: string;
}

/** Every card, rendered live over a blurred capture of the desktop. */
export interface OverlayPayload {
  mode: 'overlay';
  cards: Card[];
  /** data: URL of the screen capture we blur behind everything. */
  screenshotUrl: string;
  canvasW: number;
  canvasH: number;
  cardW: number;
  backdrop: BackdropSettings;
  /** Run the guided tutorial on this opening; null for a normal opening. */
  tutorial: { hotkey: string } | null;
}

/**
 * The fullscreen material. Apple specifies its blurs as radius + saturation +
 * a tint layer rather than a single "blur" number, because blur alone washes
 * colour out and the result looks grey and dead.
 */
export interface BackdropSettings {
  /** CSS blur radius in px, applied to the screen capture. */
  blur: number;
  /** CSS saturate() multiplier; >1 puts back the colour blur removes. */
  saturate: number;
  /** 0..1 opacity of the darkening layer over the blurred capture. */
  dim: number;
}

export const DEFAULT_BACKDROP: BackdropSettings = { blur: 42, saturate: 1.7, dim: 0.28 };
