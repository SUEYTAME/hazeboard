/// <reference lib="dom" />
import { TINTS, type Card, type Note, type NoteStyle } from '../shared/types';

/**
 * The card DOM, shared by the wallpaper bake and the live overlay.
 *
 * ONE builder serves both so the baked pixels and the live pixels cannot
 * drift apart. The overlay asks for its extra affordances (delete badges,
 * tint buttons, a composer) through `opts`; the bake never sees them.
 */
export interface CardOptions {
  mode: 'wallpaper' | 'overlay';
  footer: string;
}

export function buildCard(card: Card, opts: CardOptions): HTMLElement {
  const el = document.createElement('section');
  el.className = 'card';
  el.dataset.id = card.id;

  const header = document.createElement('header');
  const brand = document.createElement('span');
  brand.className = 'brand';
  brand.textContent = card.title ?? 'HAZEBOARD';
  const date = document.createElement('span');
  date.className = 'date';
  date.textContent = new Date().toLocaleDateString(undefined, {
    weekday: 'short', day: 'numeric', month: 'short',
  });
  header.append(brand, date);
  if (opts.mode === 'overlay') {
    header.appendChild(removeButton(`Delete panel${card.title ? `: ${card.title}` : ''}`, 'card-remove'));
  }

  const list = document.createElement('ul');
  list.className = 'notes';
  for (const note of card.notes) list.appendChild(noteRow(note, opts.mode));

  const empty = document.createElement('p');
  empty.className = 'empty';
  empty.textContent = 'Nothing on the board.';

  const foot = document.createElement('footer');
  foot.className = 'foot';
  foot.textContent = opts.footer;

  el.append(header, list, empty, foot);
  el.classList.toggle('is-empty', card.notes.length === 0);

  if (opts.mode === 'overlay') {
    const composer = document.createElement('div');
    composer.className = 'composer';
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Add to this panel...';
    input.autocomplete = 'off';
    input.spellcheck = false;
    composer.appendChild(input);
    el.appendChild(composer);
  }

  return el;
}

export function noteRow(note: Note, mode: CardOptions['mode']): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'note';
  li.dataset.id = note.id;
  if (note.done) li.classList.add('done');
  applyNoteStyle(li, note.style);

  const mark = document.createElement('span');
  mark.className = 'mark';

  const text = document.createElement('span');
  text.className = 'text';
  text.textContent = note.text;

  li.append(mark, text);

  if (mode === 'overlay') {
    const tint = document.createElement('button');
    tint.className = 'tint';
    tint.type = 'button';
    tint.setAttribute('aria-label', `Colour of note: ${note.text}`);
    li.append(tint, removeButton(`Delete note: ${note.text}`, 'remove'));
  }
  return li;
}

/**
 * Per-note colour as three custom properties. Every shade in card.css derives
 * from these, so a tint can never be half-applied with a stale accent left
 * behind, and the overlay can restyle a row in place without rebuilding it.
 */
export function applyNoteStyle(el: HTMLElement, style: NoteStyle): void {
  const tint = TINTS[style.tint];
  el.style.setProperty('--th', String(tint.h));
  el.style.setProperty('--ts', `${tint.s}%`);
  el.style.setProperty('--ta', String(style.intensity));
}

function removeButton(label: string, className: string): HTMLButtonElement {
  const del = document.createElement('button');
  del.className = className;
  del.type = 'button';
  del.setAttribute('aria-label', label);
  del.textContent = '×';
  return del;
}

/** Wait for fonts and two frames of layout, so a capture never races paint. */
export async function settled(): Promise<void> {
  await document.fonts.ready;
  await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
}
