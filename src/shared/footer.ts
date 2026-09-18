import type { Card } from './types';

/**
 * The card's footer line. Shared so the baked wallpaper and the live overlay
 * say the same thing; empty string hides the footer.
 */
export function footerFor(card: Card): string {
  const done = card.notes.filter((n) => n.done).length;
  return done > 0 ? `${done} of ${card.notes.length} done` : '';
}
