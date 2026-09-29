// Checks the .hazeboard file format: round trip, every refusal, sanitising.
// share.ts has no Electron dependency, so this runs with plain node:
//
//   npm run build && node scripts/check-share.js
//
// Exits 1 on any failed check.
const path = require('path');

const share = require(path.join(__dirname, '..', 'dist', 'main', 'share.js'));
const { parseShared, toShared, shareFileName, findShareFile, ShareError, MAX_PANELS, MAX_NOTE_CHARS } = share;

const failures = [];
const check = (cond, msg) => {
  if (!cond) failures.push(msg);
  console.log(`${cond ? ' ok ' : 'FAIL'}  ${msg}`);
};
/** The ShareError message a bad file produces, or null if it was accepted. */
const refusal = (text) => {
  try {
    parseShared(text);
    return null;
  } catch (err) {
    if (!(err instanceof ShareError)) throw err;
    return err.message;
  }
};

const note = (text, extra = {}) => ({ text, done: false, style: { tint: 'graphite', intensity: 0.32 }, ...extra });
const panel = (extra = {}) => ({ title: 'Groceries', x: 0.6, y: 0.2, style: { tint: 'blue', glass: 0.9 }, notes: [note('Coffee')], ...extra });
const file = (panels, extra = {}) => JSON.stringify({ format: 'hazeboard-panels', version: 1, panels, ...extra });

// 1. Round trip: what toShared writes, parseShared reads back unchanged.
const cards = [{
  id: 'abc', title: 'Groceries', x: 0.6, y: 0.2, createdAt: '2026-01-01T00:00:00.000Z',
  style: { tint: 'blue', glass: 0.9 },
  notes: [{ id: 'n1', text: 'Coffee', done: true, createdAt: '2026-01-01T00:00:00.000Z', style: { tint: 'green', intensity: 0.5 } }],
}];
const written = JSON.stringify(toShared(cards));
const back = parseShared(written);
check(back.length === 1 && back[0].title === 'Groceries' && back[0].style.tint === 'blue' && back[0].style.glass === 0.9,
  'round trip keeps the panel name, colour and glass');
check(back[0].notes[0].text === 'Coffee' && back[0].notes[0].done === true && back[0].notes[0].style.tint === 'green',
  'round trip keeps the note text, done state and colour');
check(!written.includes('"id"') && !written.includes('createdAt') && !written.includes('baseWallpaper'),
  'the file carries no ids, dates or wallpaper path');

// 2. Every refusal, with a message a person can act on.
const cases = [
  ['not json', 'this is not json', /could not be read/],
  ['wrong format', JSON.stringify({ format: 'something-else', version: 1, panels: [panel()] }), /not a Hazeboard panels file/],
  ['newer version', file([panel()], { version: 2 }), /newer version of Hazeboard/],
  ['no version', JSON.stringify({ format: 'hazeboard-panels', panels: [panel()] }), /no valid version/],
  ['no panels', file([]), /no panels/],
  ['too many panels', file(Array.from({ length: MAX_PANELS + 1 }, () => panel())), /more than 20 panels/],
  ['panel without notes', file([panel({ notes: [] })]), /Panel 1 has no notes/],
  ['empty note', file([panel({ notes: [note('   ')] })]), /Note 1 on panel 1 is empty/],
  ['note too long', file([panel({ notes: [note('x'.repeat(MAX_NOTE_CHARS + 1))] })]), /longer than 500 characters/],
  ['name too long', file([panel({ title: 'x'.repeat(41) })]), /name is longer than 40/],
  ['missing position', file([panel({ x: 'left' })]), /no valid x position/],
  ['second panel bad', file([panel(), panel({ notes: [{ done: true }] })]), /Note 1 on panel 2 has no text/],
];
for (const [name, text, expected] of cases) {
  const msg = refusal(text);
  check(msg !== null && expected.test(msg), `refuses ${name}${msg ? ` ("${msg}")` : ' (was accepted!)'}`);
}

// 3. Cosmetic problems are cleaned, not refused.
const [clean] = parseShared(file([panel({
  x: 7, y: -3, title: '  Padded  ',
  style: { tint: 'neon', glass: 5 },
  notes: [note('  Trim me  ', { style: { tint: 'nope', intensity: 9 }, extra: 'dropped' })],
  somethingElse: true,
})]));
check(clean.x === 1 && clean.y === 0, 'positions off the screen are pulled back onto it');
check(clean.style.tint === null && clean.style.glass === 1, 'an unknown panel colour becomes no colour; glass is capped');
check(clean.notes[0].style.tint === 'graphite' && clean.notes[0].style.intensity === 1, 'an unknown note colour becomes the default');
check(clean.title === 'Padded' && clean.notes[0].text === 'Trim me', 'names and notes are trimmed');
check(!('extra' in clean.notes[0]) && !('somethingElse' in clean), 'unknown fields in the file are dropped');

// 4. File names and command lines.
check(shareFileName('Groceries') === 'Groceries.hazeboard', 'file name from a panel name');
check(shareFileName('a/b:c*?') === 'abc.hazeboard', 'characters Windows forbids are removed');
check(shareFileName('   ') === 'Hazeboard panels.hazeboard', 'a blank name falls back to a generic one');
check(findShareFile(['C:\\app\\Hazeboard.exe', '--allow-file-access', 'C:\\Users\\me\\Study week.HAZEBOARD']) === 'C:\\Users\\me\\Study week.HAZEBOARD',
  'the double-clicked file is found in the command line');
check(findShareFile(['C:\\app\\Hazeboard.exe', '--flag=x.hazeboard']) === null, 'switches are not mistaken for files');

console.log(`${failures.length} failure(s)`);
process.exit(failures.length ? 1 : 0);
