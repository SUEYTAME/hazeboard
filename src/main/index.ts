import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as store from './store';
import { composeAndApply, composeToFile } from './compose';
import { listMonitors } from './wallpaper';
import { startApp, setAutostart, autostartEnabled } from './app';

function argv(): string[] {
  // packaged: [exe, ...args]   dev: [electron, appPath, ...args]
  return process.argv.slice(app.isPackaged ? 1 : 2);
}

const USAGE = `
glassboard - a whiteboard baked into your desktop wallpaper

  board add <text>       add a note to the first card and refresh the wallpaper
  board list             list every card and its notes, with ids
  board cards            list cards with their positions
  board done <id>        toggle a note done/undone
  board rm <id>          delete a note (an emptied card disappears)
  board rmcard <id>      delete a whole card
  board clear            delete all completed notes
  board base <path>      set the wallpaper image the card sits on
  board base --show      show the remembered base image
  board refresh          re-render and re-apply the wallpaper
  board preview          render to a PNG without touching the desktop
  board monitors         list monitors as Windows sees them
  board ui               run the tray app (also the default with no args)
  board autostart on|off start the tray app at login (notes show regardless)

ids may be shortened as long as they stay unambiguous.
`.trim();

function printBoard(): void {
  const state = store.load();
  if (state.cards.length === 0) {
    console.log('(board is empty)');
    return;
  }
  state.cards.forEach((card, i) => {
    if (i > 0) console.log('');
    console.log(`  card ${card.id}${card.title ? `  ${card.title}` : ''}`);
    for (const n of card.notes) {
      console.log(`    ${n.done ? '[x]' : '[ ]'} ${n.id}  ${n.text}`);
    }
  });
  const notes = store.allNotes(state);
  const open = notes.filter((n) => !n.done).length;
  console.log(`\n  ${open} open, ${notes.length} total, ${state.cards.length} card(s)`);
}

function printCards(): void {
  const { cards } = store.load();
  if (cards.length === 0) {
    console.log('(board is empty)');
    return;
  }
  for (const c of cards) {
    const pos = `x ${c.x.toFixed(2)}  y ${c.y.toFixed(2)}`;
    console.log(`  ${c.id}  ${pos}  ${c.notes.length} note(s)${c.title ? `  ${c.title}` : ''}`);
  }
}

async function refresh(): Promise<void> {
  const r = await composeAndApply();
  console.log(
    `wallpaper updated: ${r.widthPx}x${r.heightPx}, ${r.cardCount} card(s), ${r.noteCount} note(s)\n` +
    `  base:   ${r.basePath}\n` +
    `  output: ${r.imagePath}`
  );
}

async function runCommand(args: string[]): Promise<void> {
  const [cmd, ...rest] = args;

  switch (cmd) {
    case 'add': {
      const text = rest.join(' ');
      const { card, note } = store.addNote(text);
      console.log(`added ${note.id} to card ${card.id}: ${note.text}`);
      await refresh();
      break;
    }
    case 'list':
      printBoard();
      break;
    case 'cards':
      printCards();
      break;
    case 'rmcard': {
      if (!rest[0]) throw new Error('usage: board rmcard <id>');
      const c = store.removeCard(rest[0]);
      console.log(`removed card ${c.id} (${c.notes.length} note(s))`);
      await refresh();
      break;
    }

    case 'done': {
      if (!rest[0]) throw new Error('usage: board done <id>');
      const n = store.toggleNote(rest[0]);
      console.log(`${n.done ? 'completed' : 'reopened'} ${n.id}: ${n.text}`);
      await refresh();
      break;
    }
    case 'rm': {
      if (!rest[0]) throw new Error('usage: board rm <id>');
      const n = store.removeNote(rest[0]);
      console.log(`removed ${n.id}: ${n.text}`);
      await refresh();
      break;
    }
    case 'clear': {
      const n = store.clearDone();
      console.log(`removed ${n} completed note(s)`);
      await refresh();
      break;
    }
    case 'base': {
      const state = store.load();
      if (!rest[0] || rest[0] === '--show') {
        console.log(state.baseWallpaper ?? '(none remembered yet)');
        break;
      }
      const p = path.resolve(rest.join(' '));
      if (!fs.existsSync(p)) throw new Error(`no such file: ${p}`);
      state.baseWallpaper = p;
      store.save(state);
      console.log(`base wallpaper set: ${p}`);
      await refresh();
      break;
    }
    case 'autostart': {
      const arg = rest[0];
      if (arg === 'on' || arg === 'off') setAutostart(arg === 'on');
      else if (arg) throw new Error("usage: board autostart on|off");
      console.log(`autostart is ${autostartEnabled() ? 'ON' : 'OFF'}`);
      console.log('(notes appear at login either way - they are the wallpaper)');
      break;
    }

    case 'refresh':
      await refresh();
      break;

    case 'preview': {
      const r = await composeToFile('preview.png');
      console.log(`rendered ${r.widthPx}x${r.heightPx} -> ${r.imagePath}`);
      console.log('(desktop wallpaper NOT changed)');
      break;
    }

    case 'monitors': {
      for (const m of await listMonitors()) {
        console.log(`  [${m.index}] ${m.width}x${m.height}${m.primary ? '  (primary)' : ''}`);
      }
      break;
    }
    case 'help':
    case '--help':
    case '-h':
      console.log(USAGE);
      break;

    default:
      console.log(`unknown command: ${cmd}
`);
      console.log(USAGE);
      break;
  }
}

/**
 * app.exit() is immediate and can truncate buffered stdout on Windows, so give
 * the pipe a chance to drain first.
 */
function exitWhenFlushed(code: number): void {
  const done = (): void => app.exit(code);
  if (process.stdout.write('')) done();
  else process.stdout.once('drain', done);
}

// A CLI run alongside the resident tray app would otherwise fight over one
// Chromium cache directory and spray "Unable to create cache" on stderr.
// Give short-lived CLI instances their own session dir.
if (argv()[0] && argv()[0] !== 'ui') {
  app.setPath('sessionData', path.join(app.getPath('userData'), 'cli-session'));
}

app.whenReady().then(async () => {
  const args = argv();
  const cmd = args[0];

  // No command means "be the app": tray, hotkey, editor. Everything else is a
  // one-shot CLI invocation that exits when it is done.
  if (!cmd || cmd === 'ui') {
    startApp();
    return;
  }

  try {
    await runCommand(args);
    exitWhenFlushed(0);
  } catch (err) {
    console.error(`\nerror: ${(err as Error).message}\n`);
    exitWhenFlushed(1);
  }
});

/**
 * Deliberately NOT wired to app.exit().
 *
 * The renderer destroys its offscreen window inside a finally block, which
 * fires window-all-closed while composeAndApply is still awaiting. Quitting
 * here killed the process before the wallpaper was ever set - and, being a
 * race, it appeared to work about half the time. The CLI owns the lifecycle.
 */
app.on('window-all-closed', () => { /* keep running until runCommand says so */ });
