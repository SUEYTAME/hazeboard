/**
 * Card geometry shared by the wallpaper bake (main process) and the live
 * overlay (renderer). Both must place a card at exactly the same pixel for a
 * given (x, y) fraction, or the overlay would visibly "snap" when it closes
 * and the baked wallpaper appears underneath it.
 *
 * Everything here is in wallpaper PIXELS. Both pages run at
 * zoomFactor = 1 / scaleFactor, which makes one CSS pixel one wallpaper pixel.
 */

/** Card width. Fixed so text wraps identically in the bake and the overlay. */
export const CARD_W = 560;

/**
 * Margin around the card inside its render region, holding the drop shadow.
 * The shadow in card.css must fit inside this or it gets a hard edge where
 * the region ends.
 */
export const SHADOW_ROOM = 96;

/** How close to a screen edge a card may be pinned. */
export const EDGE_INSET = 24;

/**
 * Windows DPI scales are all multiples of 0.25 (100/125/150/175/200%), so any
 * DIP dimension that is a multiple of 4 converts to an exact integer pixel
 * count. Sizing render windows on that grid removes the half-pixel rounding
 * that otherwise makes a capture disagree with the requested region by 1-3px.
 */
export const DIP_GRID = 4;

export interface Point {
  x: number;
  y: number;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/**
 * Resolve a card's stored fraction to a top-left pixel, pulled fully on-screen.
 *
 * A card dropped with its bottom past the screen edge is moved UP rather than
 * sliced, which is why the card's rendered height is an input: the pin cannot
 * be decided until the text has wrapped.
 */
export function pinCard(fx: number, fy: number, cardH: number, canvasW: number, canvasH: number): Point {
  const maxX = Math.max(EDGE_INSET, canvasW - CARD_W - EDGE_INSET);
  const maxY = Math.max(EDGE_INSET, canvasH - cardH - EDGE_INSET);
  return {
    x: Math.round(clamp(fx * canvasW, EDGE_INSET, maxX)),
    y: Math.round(clamp(fy * canvasH, EDGE_INSET, maxY)),
  };
}
