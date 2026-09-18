import { screen } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as store from './store';
import { renderBoardPng, fileUrl } from './render';
import { setWallpaper, currentWallpaper } from './wallpaper';
import type { BoardPayload, Geometry } from '../shared/types';

/**
 * Pick the image the card gets composited onto.
 *
 * The trap this guards against: once we set the wallpaper to our own output,
 * "the current wallpaper" is a glassboard render. Compositing onto that would
 * stack a second card on top of the first, and every refresh would stack another.
 * So the first time we run we snapshot the user's real wallpaper and remember it.
 */
async function resolveBase(): Promise<string> {
  const state = store.load();
  const ours = store.outDir().toLowerCase();

  if (state.baseWallpaper) {
    if (!fs.existsSync(state.baseWallpaper)) {
      throw new Error(
        `base wallpaper is missing: ${state.baseWallpaper}\n` +
        `set a new one with:  npm run board -- base "C:\path\to\image.jpg"`
      );
    }
    return state.baseWallpaper;
  }

  const current = await currentWallpaper();
  if (!current || !fs.existsSync(current)) {
    throw new Error(
      'could not read your current desktop wallpaper.\n' +
      'set a base explicitly:  npm run board -- base "C:\path\to\image.jpg"'
    );
  }
  if (path.dirname(current).toLowerCase().startsWith(ours)) {
    throw new Error(
      'current wallpaper is already a glassboard render and no base is remembered.\n' +
      'set a base explicitly:  npm run board -- base "C:\path\to\image.jpg"'
    );
  }

  state.baseWallpaper = current;
  store.save(state);
  return current;
}

/** Alternate output filenames: Windows caches the wallpaper and will happily
 *  ignore a rewrite of the same path, leaving your desktop showing stale notes. */
function nextOutputPath(previous: string | null): string {
  const dir = store.outDir();
  const usingA = previous !== null && path.basename(previous).toLowerCase() === 'board-a.png';
  return path.join(dir, usingA ? 'board-b.png' : 'board-a.png');
}

export interface ComposeResult {
  imagePath: string;
  widthPx: number;
  heightPx: number;
  noteCount: number;
  basePath: string;
}

export async function composeAndApply(): Promise<ComposeResult> {
  const result = await composeToFile();
  await setWallpaper(result.imagePath, true);
  return result;
}

/** Render and write the PNG, but leave the desktop alone. */
export async function composeToFile(previewName?: string): Promise<ComposeResult> {
  const state = store.load();
  const base = await resolveBase();

  const display = screen.getPrimaryDisplay();
  const scaleFactor = display.scaleFactor || 1;
  const widthPx = Math.round(display.size.width * scaleFactor);
  const heightPx = Math.round(display.size.height * scaleFactor);

  const geometry = computeGeometry(display, widthPx, heightPx, scaleFactor);

  const open = state.notes.filter((n) => !n.done).length;
  const payload: BoardPayload = {
    mode: 'wallpaper',
    notes: state.notes,
    backgroundUrl: fileUrl(base),
    footer: state.notes.length > 0
      ? `${open} open · ${state.notes.length} total`
      : '',
    geometry,
  };

  const png = await renderBoardPng(payload, { scaleFactor });

  const target = previewName
    ? path.join(store.outDir(), previewName)
    : nextOutputPath(await currentWallpaper());
  fs.writeFileSync(target, png);

  return { imagePath: target, widthPx, heightPx, noteCount: state.notes.length, basePath: base };
}

/** Card width in wallpaper pixels, and the gap that holds its drop shadow. */
const CARD_W = 560;
const SHADOW_ROOM = 96;
/** Distance from the right edge of the screen to the right edge of the card.
 *  Right side on purpose: desktop icons live on the left. */
const RIGHT_INSET = 96;

/**
 * Windows DPI scales are all multiples of 0.25 (100/125/150/175/200%), so any
 * DIP dimension that is a multiple of 4 converts to an exact integer pixel
 * count. Sizing the render window on that grid removes the half-pixel rounding
 * that otherwise makes the capture disagree with the requested region by 1-3px.
 */
const DIP_GRID = 4;

function alignToGrid(physicalPx: number, scale: number): { physical: number; dip: number } {
  const dip = Math.max(DIP_GRID, Math.floor(physicalPx / scale / DIP_GRID) * DIP_GRID);
  return { physical: Math.round(dip * scale), dip };
}

function computeGeometry(
  display: Electron.Display,
  canvasW: number,
  canvasH: number,
  scaleFactor: number
): Geometry {
  const cardLeft = canvasW - RIGHT_INSET - CARD_W;

  // The render window cannot exceed the work area, so neither can the region.
  const maxRegionH = Math.floor(display.workArea.height * scaleFactor) - 24;
  const wantH = Math.min(canvasH, Math.max(320, maxRegionH));
  const wantW = Math.min(canvasW, CARD_W + SHADOW_ROOM * 2);

  const { physical: regionW } = alignToGrid(wantW, scaleFactor);
  const { physical: regionH } = alignToGrid(wantH, scaleFactor);

  // Anchor the region to the right edge, then derive the card's offset inside
  // it, so the card lands at its intended absolute position regardless of how
  // much the grid alignment shaved off.
  const regionX = Math.max(0, canvasW - regionW);
  const regionY = Math.round((canvasH - regionH) / 2);

  return {
    canvasW, canvasH,
    regionX, regionY, regionW, regionH,
    cardW: CARD_W,
    cardMargin: Math.max(0, cardLeft - regionX),
  };
}
