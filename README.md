# glassboard

A whiteboard that lives in your Windows desktop wallpaper. Notes you write are
composited into the wallpaper image itself, so they are simply *there* when you
log in — no process has to be running for you to see them.

![the card sits on the right, where desktop icons aren't](docs/example.png)

## How it works

There are three places you could put something that looks like it's on the
wallpaper. glassboard uses the first:

1. **Baked into the wallpaper image** — render the notes onto a copy of your
   wallpaper and set that as the desktop background. Zero runtime cost, survives
   reboot/sleep/Show Desktop, visible the instant you log in.
2. A window parented into `WorkerW` (the Wallpaper Engine trick) — live and
   interactive, but needs a resident process and undocumented APIs.
3. An always-on-bottom borderless window — easy, but Show Desktop exposes it.

The glass is real, not faked: the card region is rendered in a browser with
`backdrop-filter` over the actual wallpaper pixels, so the blur samples the
truth.

## Usage

```
npm install
npm run build
```

Drive it from the command line:

```
npm run board -- add "call the bank"
npm run board -- list
npm run board -- done 4f98        # ids may be shortened
npm run board -- rm 4f98
npm run board -- clear            # drop completed notes
npm run board -- base "C:/Users/you/Pictures/wallpaper.jpg"
npm run board -- refresh
npm run board -- preview          # render a PNG without touching the desktop
```

…or run it as an app:

```
npm start
```

That puts a tray icon in the notification area. Click it (or press
**Ctrl+Alt+W**) to open the board. Click a note to tick it off; **hold** a note
for half a second to enter edit mode, where each note grows a delete badge and
the rows wiggle, iOS-style. Esc leaves edit mode; Esc again closes the board.
The wallpaper is re-baked when the board closes.

```
npm run board -- autostart on
```

Starts the tray app at login. Only needed for the tray and hotkey — your notes
appear at login either way, because they *are* the wallpaper.

## Things worth knowing

Each of these cost real debugging time and is easy to trip over again:

- **`IDesktopWallpaper::SetWallpaper` refuses any image under `AppData`**
  (Roaming *and* Local), failing with a flatly misleading `0x80070002`
  "file not found" for a file that is definitely there. Generated wallpapers go
  to `Pictures/Glassboard` for this reason — note that Electron's default
  `userData` directory is under AppData, so the obvious choice is the one place
  that silently cannot work.
- **Windows caches the wallpaper**, so rewriting the same path can leave the
  desktop showing stale notes. Output alternates between `board-a.png` and
  `board-b.png`.
- **A browser window is clamped to the monitor's work area** (screen minus
  taskbar), so it can never be as tall as the wallpaper. Only the card *region*
  is rendered in the DOM; a `<canvas>`, which has no size limit, composites it
  onto the full-size image.
- **Per-monitor wallpapers need COM.** The old `SystemParametersInfo` call sets
  one image for every screen, which would put a cropped copy of your card on
  the second monitor. `scripts/wallpaper.ps1` uses `IDesktopWallpaper` instead.
- **PowerShell can't call `IDesktopWallpaper` directly** — it dispatches through
  IDispatch, which this IUnknown-only interface doesn't implement. All COM calls
  happen inside the embedded C#.
- **`devicePixelRatio` is not necessarily the display scale factor.** Window
  APIs take DIPs, `getBoundingClientRect` returns CSS pixels, and the two only
  agree when those numbers match. Window sizing converts through physical pixels.
- **Destroying the render window fires `window-all-closed`.** Wiring that to
  `app.exit()` kills the process mid-await, so the wallpaper never gets set —
  and because it's a race, it appears to work about half the time.

## Layout

```
src/main/       Electron main: CLI, tray, editor window, compositor
src/renderer/   The card. ONE html/css/ts set serves both the baked
                wallpaper and the live editor, so they cannot drift apart.
src/shared/     Types shared across the boundary
scripts/        PowerShell COM bridge, icon generator, editor check
```

`scripts/check-editor.js` boots the editor offscreen, drives it into edit mode
and screenshots it — useful for checking layout without clicking anything.
