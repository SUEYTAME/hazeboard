/// <reference lib="dom" />
import type { Geometry, WallpaperPayload } from '../shared/types';
import { buildCard, settled } from './card';

/**
 * The wallpaper bake page. The main process drives it through five calls:
 *
 *   __initComposite  draw the base image into a full-size canvas
 *   __renderCard     lay one card out in the DOM over the real wallpaper pixels
 *   __measureCard    report the card's height (pass 1 of 2)
 *   __drawRegion     paste a captured region onto the canvas
 *   __finishComposite  hand back the whole wallpaper as a PNG
 *
 * A canvas has no size limit, a window does; that is the entire reason the
 * composite happens here instead of in the main process.
 */

interface CompositeInit {
  backgroundUrl: string;
  canvasW: number;
  canvasH: number;
}

let canvas: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;
let currentCard: HTMLElement | null = null;

async function initComposite(init: CompositeInit): Promise<void> {
  const bg = document.getElementById('bg') as HTMLImageElement;
  bg.src = init.backgroundUrl;
  try {
    await bg.decode();
  } catch {
    throw new Error(`background image failed to decode: ${init.backgroundUrl}`);
  }

  const s = document.documentElement.style;
  s.setProperty('--bg-w', `${init.canvasW}px`);
  s.setProperty('--bg-h', `${init.canvasH}px`);

  canvas = document.createElement('canvas');
  canvas.width = init.canvasW;
  canvas.height = init.canvasH;
  ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('could not get a 2d context');

  // Reproduce the crop Windows "Fill" would apply, so what we bake matches
  // what the shell would have shown for this base image.
  const scale = Math.max(init.canvasW / bg.naturalWidth, init.canvasH / bg.naturalHeight);
  const sw = init.canvasW / scale;
  const sh = init.canvasH / scale;
  const sx = (bg.naturalWidth - sw) / 2;
  const sy = (bg.naturalHeight - sh) / 2;
  ctx.drawImage(bg, sx, sy, sw, sh, 0, 0, init.canvasW, init.canvasH);

  await refreshBackdrop();
}

let backdropUrl: string | null = null;

/**
 * Point the DOM background at the composite AS IT STANDS, not at the clean
 * base. A card's captured region includes its shadow room, so pasting a region
 * rendered over the clean base would wipe out any earlier card underneath it.
 * Rendered over the composite instead, overlapping cards stack like objects
 * and a later card's shadow falls on an earlier one.
 */
async function refreshBackdrop(): Promise<void> {
  if (!canvas) throw new Error('refreshBackdrop called before initComposite');
  const blob = await new Promise<Blob | null>((r) => canvas!.toBlob(r, 'image/png'));
  if (!blob) throw new Error('canvas.toBlob returned nothing');
  if (backdropUrl) URL.revokeObjectURL(backdropUrl);
  backdropUrl = URL.createObjectURL(blob);

  const bg = document.getElementById('bg') as HTMLImageElement;
  bg.src = backdropUrl;
  await bg.decode();
}

/**
 * Lay one card out and resolve only once the browser has painted it AT THE
 * REQUESTED VIEWPORT SIZE. setContentSize in the main process returns long
 * before the renderer sees the new size; capturing in that gap would bake a
 * card laid out against the previous card's region.
 */
async function renderCard(payload: WallpaperPayload, viewportSlack: number): Promise<void> {
  const g = payload.geometry;
  applyGeometry(g);

  const stage = document.getElementById('stage')!;
  currentCard = buildCard(payload.card, { mode: 'wallpaper', footer: payload.footer });
  currentCard.style.setProperty('--card-x', `${g.cardOffsetX}px`);
  currentCard.style.setProperty('--card-y', `${g.cardOffsetY}px`);
  currentCard.style.setProperty('--card-w', `${g.cardW}px`);
  currentCard.style.setProperty('--card-max-h', `${g.cardMaxH}px`);
  stage.replaceChildren(currentCard);

  await waitForViewport(g.regionW, g.regionH, viewportSlack);
  await settled();
}

/**
 * The viewport IS the region. The background image is sized to the full
 * wallpaper and shifted by -regionX/-regionY, so the pixels sitting behind the
 * card are the real wallpaper pixels and backdrop-filter blurs the truth.
 */
function applyGeometry(g: Geometry): void {
  const s = document.documentElement.style;
  s.setProperty('--region-w', `${g.regionW}px`);
  s.setProperty('--region-h', `${g.regionH}px`);
  s.setProperty('--bg-left', `${-g.regionX}px`);
  s.setProperty('--bg-top', `${-g.regionY}px`);
}

const VIEWPORT_TIMEOUT_MS = 3000;

/**
 * A frameless window on Windows is a DIP larger than asked for, so the
 * viewport may legitimately exceed the region by a few pixels (the surplus
 * is cropped by the main process). It must never be SMALLER, and it must not
 * be the previous card's much larger region, which the upper bound rejects.
 */
function waitForViewport(w: number, h: number, slack: number): Promise<void> {
  const within = (actual: number, want: number): boolean => actual >= want && actual <= want + slack;
  const matches = (): boolean => within(window.innerWidth, w) && within(window.innerHeight, h);
  if (matches()) return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    let raf = 0;
    const timer = window.setTimeout(() => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener('resize', check);
      reject(new Error(
        `viewport is ${window.innerWidth}x${window.innerHeight}, expected ${w}x${h} ` +
        `after ${VIEWPORT_TIMEOUT_MS}ms`
      ));
    }, VIEWPORT_TIMEOUT_MS);

    const check = (): void => {
      if (!matches()) {
        raf = window.requestAnimationFrame(check);
        return;
      }
      window.clearTimeout(timer);
      window.removeEventListener('resize', check);
      resolve();
    };
    window.addEventListener('resize', check);
    raf = window.requestAnimationFrame(check);
  });
}

function measureCard(): number {
  if (!currentCard) throw new Error('measureCard called before renderCard');
  return currentCard.getBoundingClientRect().height;
}

async function drawRegion(regionPngDataUrl: string, x: number, y: number): Promise<void> {
  if (!ctx) throw new Error('drawRegion called before initComposite');
  const region = new Image();
  region.src = regionPngDataUrl;
  await region.decode();
  ctx.drawImage(region, x, y);
  await refreshBackdrop();
}

function finishComposite(): string {
  if (!canvas) throw new Error('finishComposite called before initComposite');
  return canvas.toDataURL('image/png');
}

const w = window as unknown as Record<string, unknown>;
w.__initComposite = initComposite;
w.__renderCard = renderCard;
w.__measureCard = measureCard;
w.__drawRegion = drawRegion;
w.__finishComposite = finishComposite;
