import { BrowserWindow, nativeImage } from 'electron';
import * as path from 'path';
import { pathToFileURL } from 'url';
import type { Card, Geometry, WallpaperPayload } from '../shared/types';
import { CARD_W, SHADOW_ROOM, DIP_GRID, pinCard } from '../shared/layout';
import { footerFor } from '../shared/footer';

export { CARD_W, SHADOW_ROOM, DIP_GRID };

function boardHtml(): string {
  return path.join(__dirname, '..', 'renderer', 'board.html');
}

export interface Layout {
  /** Wallpaper size in physical pixels. */
  canvasW: number;
  canvasH: number;
  /** DPI scale of the display we are rendering for (1.25 for 125%). */
  scaleFactor: number;
  /**
   * Tallest region a render window can be, in physical pixels. A browser
   * window is hard-clamped to the monitor's work area (measured: 912 of 960
   * DIP), and the clamp applies to offscreen windows too.
   */
  maxRegionH: number;
}

/* ------------------------------------------------------------------ *
 *  Geometry                                                           *
 * ------------------------------------------------------------------ */

function alignUp(physicalPx: number, scale: number): number {
  const dip = Math.max(DIP_GRID, Math.ceil(physicalPx / scale / DIP_GRID) * DIP_GRID);
  return Math.round(dip * scale);
}

function alignDown(physicalPx: number, scale: number): number {
  const dip = Math.max(DIP_GRID, Math.floor(physicalPx / scale / DIP_GRID) * DIP_GRID);
  return Math.round(dip * scale);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/**
 * Where one card's render region sits on the wallpaper.
 *
 * `cardH` null is the MEASURING pass: the region is as tall as a window is
 * allowed to be and the card sits at a fixed offset, purely so the page can
 * report how tall the wrapped text made it. With `cardH` known, the region is
 * shrink-wrapped around the card plus its shadow room and pinned inside the
 * canvas.
 */
export function geometryFor(layout: Layout, card: Card, cardH: number | null): Geometry {
  const { canvasW, canvasH, scaleFactor: scale } = layout;

  const regionW = Math.min(alignUp(CARD_W + SHADOW_ROOM * 2, scale), alignDown(canvasW, scale));
  const maxH = Math.min(alignDown(layout.maxRegionH, scale), alignDown(canvasH, scale));
  if (regionW < CARD_W) {
    throw new Error(`wallpaper ${canvasW}px is narrower than a ${CARD_W}px card`);
  }
  if (maxH <= SHADOW_ROOM * 2) {
    throw new Error(`max region height ${maxH}px leaves no room for a card`);
  }

  if (cardH === null) {
    const cardOffsetX = Math.max(0, Math.floor((regionW - CARD_W) / 2));
    return {
      canvasW, canvasH,
      regionX: 0, regionY: 0, regionW, regionH: maxH,
      cardW: CARD_W,
      cardOffsetX, cardOffsetY: SHADOW_ROOM,
      cardMaxH: maxH - SHADOW_ROOM * 2,
    };
  }

  const { x: cx, y: cy } = pinCard(card.x, card.y, cardH, canvasW, canvasH);
  const regionH = Math.min(alignUp(cardH + SHADOW_ROOM * 2, scale), maxH);
  const regionX = clamp(cx - SHADOW_ROOM, 0, canvasW - regionW);
  const regionY = clamp(cy - SHADOW_ROOM, 0, canvasH - regionH);
  const cardOffsetX = cx - regionX;
  const cardOffsetY = cy - regionY;

  if (cardOffsetY + cardH > regionH) {
    throw new Error(
      `card ${card.id} (${cardH}px at y=${cy}) does not fit its ${regionH}px region ` +
      `starting at ${regionY}`
    );
  }

  return {
    canvasW, canvasH,
    regionX, regionY, regionW, regionH,
    cardW: CARD_W,
    cardOffsetX, cardOffsetY,
    cardMaxH: cardH,
  };
}

/* ------------------------------------------------------------------ *
 *  Bake                                                               *
 * ------------------------------------------------------------------ */

function payloadFor(card: Card, backgroundUrl: string, geometry: Geometry): WallpaperPayload {
  return { mode: 'wallpaper', card, backgroundUrl, geometry, footer: footerFor(card) };
}

/**
 * Render every card onto the base image and return PNG bytes for the FULL
 * wallpaper.
 *
 * One offscreen window is reused for all cards. The page keeps a full-size
 * canvas (a canvas has no window-size limit) with the base drawn in; each card
 * is laid out in the DOM over the real wallpaper pixels behind it - so
 * backdrop-filter blurs the truth - captured, and drawn onto that canvas.
 *
 * Two passes per card: text wrapping means the height cannot be predicted
 * from the note count, so pass 1 renders in a full-height window purely to
 * measure, and pass 2 sizes the window to that height and captures.
 */
export async function renderWallpaperPng(cards: Card[], backgroundUrl: string, layout: Layout): Promise<Buffer> {
  const scale = layout.scaleFactor || 1;
  const probe: Card = cards[0] ?? { id: '', title: null, notes: [], x: 0, y: 0, createdAt: '' };
  const measuring = geometryFor(layout, probe, null);
  // A frameless window on Windows comes out 1 DIP larger than the content
  // size asked for (measured: 604x892 requested, 605x893 reported, viewport
  // ceil(605 * 1.25) = 757px). The page accepts a viewport up to this much
  // larger than the region; the surplus is empty margin that gets cropped.
  const viewportSlack = Math.ceil(2 * scale) + 1;

  const win = new BrowserWindow({
    width: Math.round(measuring.regionW / scale),
    height: Math.round(measuring.regionH / scale),
    useContentSize: true,
    show: false,
    frame: false,
    skipTaskbar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      offscreen: true,
    },
  });

  try {
    await win.loadFile(boardHtml());
    // Window dimensions are DIPs; zooming by 1/scale makes one CSS pixel equal
    // one wallpaper pixel, so the page can reason in wallpaper pixels only.
    await win.webContents.setZoomFactor(1 / scale);

    await callPage(win, `window.__initComposite(${JSON.stringify({
      backgroundUrl, canvasW: layout.canvasW, canvasH: layout.canvasH,
    })})`);

    for (const card of cards) {
      // Pass 1: measure.
      const g1 = geometryFor(layout, card, null);
      setViewport(win, g1, scale);
      await callPage(win, `window.__renderCard(${JSON.stringify(payloadFor(card, backgroundUrl, g1))}, ${viewportSlack})`);
      const measured = await callPage(win, 'window.__measureCard()');
      if (typeof measured !== 'number' || !Number.isFinite(measured) || measured <= 0) {
        throw new Error(`measureCard returned ${String(measured)} for card ${card.id}`);
      }
      const cardH = Math.min(Math.ceil(measured), g1.cardMaxH);

      // Pass 2: shrink-wrap, render, capture.
      const g2 = geometryFor(layout, card, cardH);
      setViewport(win, g2, scale);
      await callPage(win, `window.__renderCard(${JSON.stringify(payloadFor(card, backgroundUrl, g2))}, ${viewportSlack})`);

      let region = await win.webContents.capturePage();
      const size = region.getSize();
      if (size.width === 0 || size.height === 0) {
        throw new Error(`capturePage returned an empty image for card ${card.id}`);
      }
      // DIP->pixel conversion can hand back a capture a pixel or two larger
      // than requested; the surplus is empty margin and trimming it is safe.
      // A capture SMALLER than requested means real clipping, so refuse.
      if (size.width < g2.regionW || size.height < g2.regionH) {
        throw new Error(
          `region capture ${size.width}x${size.height} is smaller than the requested ` +
          `${g2.regionW}x${g2.regionH}; card ${card.id} would be clipped`
        );
      }
      if (size.width !== g2.regionW || size.height !== g2.regionH) {
        region = region.crop({ x: 0, y: 0, width: g2.regionW, height: g2.regionH });
      }

      await callPage(
        win,
        `window.__drawRegion(${JSON.stringify(region.toDataURL())}, ${g2.regionX}, ${g2.regionY})`
      );
    }

    const full = await callPage(win, 'window.__finishComposite()');
    if (typeof full !== 'string' || !full.startsWith('data:image/png')) {
      throw new Error(`composite returned something unexpected: ${String(full).slice(0, 80)}`);
    }

    const image = nativeImage.createFromDataURL(full);
    const finalSize = image.getSize();
    if (finalSize.width !== layout.canvasW || finalSize.height !== layout.canvasH) {
      throw new Error(
        `composite size ${finalSize.width}x${finalSize.height} != wallpaper ${layout.canvasW}x${layout.canvasH}`
      );
    }
    return image.toPNG();
  } finally {
    win.destroy();
  }
}

/**
 * Resize the render window to the region. This returns long before the
 * renderer sees the new viewport; `__renderCard` in the page waits for
 * innerWidth/innerHeight to actually match before it resolves, otherwise a
 * capture in that gap bakes a card laid out against the PREVIOUS card's height.
 */
function setViewport(win: BrowserWindow, g: Geometry, scale: number): void {
  const w = Math.round(g.regionW / scale);
  const h = Math.round(g.regionH / scale);
  const [cw, ch] = win.getContentSize();
  if (cw !== w || ch !== h) win.setContentSize(w, h);
}

/**
 * Await a promise inside the page and surface its rejection as a real error.
 * executeJavaScript otherwise collapses every failure into the same opaque
 * "Script failed to execute" with no indication of what actually broke.
 */
export async function callPage(win: BrowserWindow, expression: string): Promise<unknown> {
  const wrapped = `
    (async () => {
      try { return { ok: true, value: await (${expression}) }; }
      catch (e) { return { ok: false, message: (e && e.message) || String(e), stack: e && e.stack }; }
    })()
  `;
  const result = (await win.webContents.executeJavaScript(wrapped)) as
    | { ok: true; value: unknown }
    | { ok: false; message: string; stack?: string };

  if (!result.ok) {
    throw new Error(`renderer: ${result.message}${result.stack ? `\n${result.stack}` : ''}`);
  }
  return result.value;
}

export function fileUrl(p: string): string {
  return pathToFileURL(p).href;
}
