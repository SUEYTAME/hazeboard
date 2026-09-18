import { BrowserWindow, nativeImage } from 'electron';
import * as path from 'path';
import { pathToFileURL } from 'url';
import type { BoardPayload } from '../shared/types';

function boardHtml(): string {
  return path.join(__dirname, '..', 'renderer', 'board.html');
}

export interface RenderTarget {
  /** DPI scale of the display we are rendering for (1.25 for 125%). */
  scaleFactor: number;
}

/**
 * Render the board and return PNG bytes for the FULL wallpaper.
 *
 * Two passes, for a reason that is not obvious:
 *
 *   1. A browser window is hard-clamped to the monitor's work area (screen
 *      minus taskbar), so it can never be as tall as the wallpaper. We size the
 *      window to the card REGION only and capture that. Because the background
 *      image inside is offset to the region's position, backdrop-filter blurs
 *      the genuine wallpaper pixels rather than an approximation.
 *
 *   2. A <canvas> has no such size limit, so we composite the captured region
 *      onto a full-size canvas inside the same page and read back the result.
 *
 * The zoomFactor is what makes one CSS pixel equal one wallpaper pixel: window
 * dimensions are DIPs, so we size to (region / scale) and zoom by (1 / scale).
 */
export async function renderBoardPng(payload: BoardPayload, target: RenderTarget): Promise<Buffer> {
  const g = payload.geometry;
  if (!g) throw new Error('renderBoardPng requires geometry');
  const scale = target.scaleFactor || 1;

  const win = new BrowserWindow({
    width: Math.round(g.regionW / scale),
    height: Math.round(g.regionH / scale),
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
    await win.webContents.setZoomFactor(1 / scale);

    await callPage(win, `window.__renderBoard(${JSON.stringify(payload)})`);

    let region = await win.webContents.capturePage();
    const size = region.getSize();
    if (size.width === 0 || size.height === 0) {
      throw new Error('capturePage returned an empty image');
    }

    // DIP->pixel conversion can hand back a capture a pixel or two larger than
    // requested. The stylesheet lays the card out against an explicit region
    // size, so the surplus is empty margin at the right/bottom and trimming it
    // is safe. A capture SMALLER than requested means real clipping, so refuse.
    if (size.width < g.regionW || size.height < g.regionH) {
      throw new Error(
        `region capture ${size.width}x${size.height} is smaller than the ` +
        `requested ${g.regionW}x${g.regionH}; the card would be clipped`
      );
    }
    if (size.width !== g.regionW || size.height !== g.regionH) {
      region = region.crop({ x: 0, y: 0, width: g.regionW, height: g.regionH });
    }

    const full = await callPage(
      win,
      `window.__compositeBoard(${JSON.stringify(region.toDataURL())})`
    );
    if (typeof full !== 'string' || !full.startsWith('data:image/png')) {
      throw new Error(`composite returned something unexpected: ${String(full).slice(0, 80)}`);
    }

    const image = nativeImage.createFromDataURL(full);
    const finalSize = image.getSize();
    if (finalSize.width !== g.canvasW || finalSize.height !== g.canvasH) {
      throw new Error(
        `composite size ${finalSize.width}x${finalSize.height} != wallpaper ${g.canvasW}x${g.canvasH}`
      );
    }
    return image.toPNG();
  } finally {
    win.destroy();
  }
}

/**
 * Await a promise inside the page and surface its rejection as a real error.
 * executeJavaScript otherwise collapses every failure into the same opaque
 * "Script failed to execute" with no indication of what actually broke.
 */
async function callPage(win: BrowserWindow, expression: string): Promise<unknown> {
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
