import { screen } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as store from './store';
import { renderWallpaperPng, fileUrl } from './render';
import { setWallpaper, currentWallpaper } from './wallpaper';

/**
 * Pick the image the cards get composited onto.
 *
 * The trap this guards against: once we set the wallpaper to our own output,
 * "the current wallpaper" is a hazeboard render. Compositing onto that would
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
      'current wallpaper is already a hazeboard render and no base is remembered.\n' +
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
  cardCount: number;
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
  const canvasW = Math.round(display.size.width * scaleFactor);
  const canvasH = Math.round(display.size.height * scaleFactor);

  const png = await renderWallpaperPng(state.cards, fileUrl(base), {
    canvasW,
    canvasH,
    scaleFactor,
    // The render window cannot exceed the work area, so neither can a region.
    maxRegionH: Math.floor(display.workArea.height * scaleFactor) - 24,
  });

  const target = previewName
    ? path.join(store.outDir(), previewName)
    : nextOutputPath(await currentWallpaper());
  fs.writeFileSync(target, png);

  return {
    imagePath: target,
    widthPx: canvasW,
    heightPx: canvasH,
    cardCount: state.cards.length,
    noteCount: store.allNotes(state).length,
    basePath: base,
  };
}
