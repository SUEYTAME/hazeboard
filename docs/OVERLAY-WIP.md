# Overlay redesign - WORK IN PROGRESS

Paused 2026-09-17. **The build is currently broken on purpose** - the data model
was migrated to v2 but the five files that consume it were not. See "Resume here".

## Use the app meanwhile

`dist/` still holds the last good **v1** build, so this works today:

```
npm run board -- list
npm run board -- add "something"
npx electron .                    # tray + Ctrl+Alt+W, the old small editor
```

**Do NOT run `npm start` or `npm run build`** until the migration below is
finished - both run `tsc` first and will fail with the 20 errors listed at the
bottom. `npm run board` does not rebuild, which is why it still works.

The v1 notes are backed up at `%APPDATA%/glassboard/board.json.v1-backup`
(4 notes, 3 done), taken before any migration could run.

## What we are building

Ctrl+Alt+W stops opening a 620x660 window and instead throws a **fullscreen
overlay** over a blurred capture of the live desktop - iOS "jiggle to delete"
applied to the whole screen.

Agreed behaviour:

- **Cards** are the draggable unit. Notes inside a card travel with it.
- **Drag a note out of a card** becomes its own new card.
- **Drag a note within its card** reorders it against its siblings.
- **Drag a note onto a different card** inserts it there. Not explicitly
  requested; chosen because the alternative is spawning a card on top of an
  existing one, which reads as broken.
- **Colour and contrast are per note**, not global.
- **Free positioning** anywhere, stored as 0..1 fractions of screen size so a
  resolution change moves cards proportionally instead of off-screen.

## Verified facts - spikes already run, do not re-litigate

| Question | Answer |
|---|---|
| Can we capture the live screen at full res? | Yes. `desktopCapturer` with `thumbnailSize` set to physical px returned a real 1920x1200 shot including windows and taskbar, in **166ms**. |
| Live blur or frozen capture? | **Frozen capture plus CSS blur.** Windows acrylic gives no control over radius, saturation or contrast, and per-note contrast was explicitly requested. Tradeoff: video behind the overlay will not animate while editing. |
| Can one render pass cover the whole wallpaper? | **No.** Window height is clamped to the work area - measured 912 of 960 DIP - and the clamp applies to `offscreen: true` windows too. Cards must be baked one at a time. |

## Resume here

### Done and on disk

- **`src/shared/types.ts`** - v2 model. `TINTS` palette (10 Apple-ish hues as
  hue/saturation pairs), `NoteStyle {tint, intensity}`, `Note`, `Card {id,
  title, notes, x, y}`, `BoardState {version: 2, cards}`, `Geometry` now
  carrying `cardOffsetX`, `cardOffsetY` and `cardMaxH` instead of one
  `cardMargin`, plus `WallpaperPayload`, `OverlayPayload`, `BackdropSettings`.
- **`src/main/store.ts`** - card-aware store with v1 migration: a flat `notes`
  array is folded into one card at x 0.66, y 0.30, roughly where the old card
  sat. New functions `addCard`, `moveCard`, `moveNote`, `detachNote`,
  `setNoteStyle`, and `pruneEmpty` so an emptied card deletes itself the way an
  iOS folder does.
- **`scripts/wallpaper.ps1`** - unrelated single-monitor JSON bug fixed earlier
  in the session and fully verified. Leave it alone.

### Not started - in dependency order

1. **`src/main/render.ts`** - replace `renderBoardPng` with
   `renderWallpaperPng(cards, backgroundUrl, layout)`. Design already settled:
   - Export `CARD_W = 560` and `SHADOW_ROOM = 96`. Keep `DIP_GRID = 4`.
   - One offscreen window reused across cards. `setZoomFactor(1 / scale)`.
   - Page API: `__initComposite({backgroundUrl, canvasW, canvasH})` draws the
     base with the Fill crop; then per card `__renderCard(payload)`,
     `__measureCard()`, capture, `__drawRegion(dataUrl, x, y)`; finally
     `__finishComposite()` returns the full PNG data URL.
   - **Two passes per card.** Text wrapping means card height cannot be
     predicted from the note count, so pass 1 renders at full height purely to
     measure and pass 2 sizes the window to that and captures.
   - Pin the card inside the canvas before computing its region, so a card
     dropped near an edge is pulled back fully on-screen rather than sliced.
   - `__renderCard` must **wait for `innerWidth` and `innerHeight` to match the
     requested region** before resolving. `setContentSize` returns long before
     the renderer sees the new viewport, and capturing in that gap bakes a card
     laid out against the height of the PREVIOUS card.
2. **`src/main/compose.ts`** - drop `computeGeometry`, which moves into
   render.ts as `geometryFor`. Pass `{canvasW, canvasH, scaleFactor,
   maxRegionH}`. Keep `resolveBase` and the board-a/board-b alternation exactly
   as they are.
3. **`src/renderer/board.ts` and `board.css`** - render ONE card per pass,
   honour `cardOffsetX` and `cardOffsetY`, implement the composite canvas API,
   and apply per-note tints from `TINTS`. Split the card visuals into a shared
   `card.css` so the baked wallpaper and the live overlay cannot drift apart.
   That "one html/css/ts set serves both" property is the reason the current
   design works and it must survive the redesign.
4. **`src/renderer/overlay.html` and `overlay.ts`** - new. Blurred screenshot
   layer using `DEFAULT_BACKDROP` (blur 42px, saturate 1.7, dim 0.28),
   absolutely positioned cards, long-press to enter jiggle mode, pointer-based
   drag with a floating ghost, drop-target hit testing, a per-note tint popover
   with an intensity slider, a composer, and Esc to leave jiggle then Esc again
   to close.
5. **`src/main/preload.ts`** - widen the bridge: `getCards`, `addCard`,
   `addNote(cardId, text)`, `toggleNote`, `removeNote`, `removeCard`,
   `moveCard`, `moveNote`, `detachNote`, `setNoteStyle`, `close`.
6. **`src/main/app.ts`** - replace `createEditor` with the fullscreen overlay.
   Bounds must be `display.bounds`, not `workArea`, so the taskbar is covered.
   Use `alwaysOnTop(true, 'screen-saver')` and capture the screen before
   showing the window.
7. **`src/main/index.ts`** - the CLI still speaks in notes, so `add` appends to
   the first card. Add `cards` and `rmcard` commands.
8. **`scripts/check-editor.js`** - points at the old editor. Retarget it at the
   overlay.

### Open question, deliberately deferred

Baked cards are part of the wallpaper, so the screen capture contains them and
the blur will leave a soft halo around each live card. Three options - decide by
looking at it rather than by theorising:

1. Accept it. A heavy blur may well read as an intentional glow.
2. Swap the wallpaper to the clean base *before* capturing and re-bake on close.
   Always correct, costs a visible flash of roughly 200ms.
3. Patch the baked-card rectangles in the capture using the clean base,
   detecting window occlusion by comparing pixels. Correct and instant, fiddly.

## Current compile errors, expected

20 errors, all one root cause: `app.ts`, `compose.ts`, `index.ts`, `render.ts`
and `renderer/board.ts` still expect `BoardState.notes`, `BoardPayload` and
`Geometry.cardMargin`, which v2 replaced. They disappear as steps 1 to 7 land.
Check with:

```
npx tsc -p tsconfig.json --noEmit
```

## Also worth doing

This project is still **not under version control**. Before the next big change,
run `git init` and commit the working v1 - right now a bad edit has nothing to
fall back to except `dist/`.
