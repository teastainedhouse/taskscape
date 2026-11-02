// avatar.js — the header's pixel monogram: the first letter of the signed-in
// person's name, drawn from a 5x7 bitmap font as SVG rects over the theme's
// starfield, "T" when the name starts with anything the font lacks. The
// starfield, meteor, drift and the reduced-motion kill switch are all CSS
// on the link itself (`.avatar`); this module only draws the letter.

import { svg } from './dom.js';

/** 5 columns by 7 rows; "#" is a lit pixel. */
const FONT = {
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  B: ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
  C: ['.####', '#....', '#....', '#....', '#....', '#....', '.####'],
  D: ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  F: ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
  G: ['.####', '#....', '#....', '#.###', '#...#', '#...#', '.####'],
  H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  I: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '#####'],
  J: ['....#', '....#', '....#', '....#', '#...#', '#...#', '.###.'],
  K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  M: ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'],
  N: ['#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#', '#...#'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  Q: ['.###.', '#...#', '#...#', '#...#', '#.#.#', '#..#.', '.##.#'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  V: ['#...#', '#...#', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
  W: ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '##.##', '#...#'],
  X: ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
  Y: ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
  Z: ['#####', '....#', '...#.', '..#..', '.#...', '#....', '#####'],
  0: ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'],
  1: ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  2: ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  3: ['#####', '...#.', '..#..', '...#.', '....#', '#...#', '.###.'],
  4: ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  5: ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  6: ['..##.', '.#...', '#....', '####.', '#...#', '#...#', '.###.'],
  7: ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  8: ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  9: ['.###.', '#...#', '#...#', '.####', '....#', '...#.', '.##..'],
};

/** Letters that do not decompose to a base letter the font has. */
const FOLD = { \u00d8: 'O', \u0141: 'L', \u00c6: 'A', \u0152: 'O', \u0110: 'D', \u00d0: 'D', \u00de: 'T', \u1e9e: 'S', \u0166: 'T', \u0126: 'H' };

/**
 * The letter the avatar shows for a name: the first letter or digit the font
 * has, uppercased and stripped of accents (so a name in quotes or brackets
 * still gets its letter); else "T".
 * @param {string|null|undefined} name
 */
export function initialFor(name) {
  const folded = String(name ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
  for (const ch of folded) {
    const c = FOLD[ch] ?? ch;
    if (Object.hasOwn(FONT, c)) return c;
  }
  return 'T';
}

/**
 * The letter as a 12x12 pixel SVG: a black copy one pixel down and right, then the white letter.
 * @param {string} letter  a key of FONT
 */
export function letterSvg(letter) {
  const glyph = Object.hasOwn(FONT, letter) ? FONT[letter] : FONT.T;
  const root = svg('svg', { viewBox: '0 0 12 12', width: '24', height: '24', 'shape-rendering': 'crispEdges', 'aria-hidden': 'true', focusable: 'false' });
  for (const [dx, dy, fill] of [[1, 1, '#000000'], [0, 0, '#ffffff']]) {
    glyph.forEach((row, y) => {
      for (let x = 0; x < row.length; x++) {
        if (row[x] === '#') root.appendChild(svg('rect', { x: String(x + 3 + dx), y: String(y + 2 + dy), width: '1', height: '1', fill }));
      }
    });
  }
  return root;
}

/**
 * Fill the header's profile link with the person's initial.
 * @param {HTMLElement|null} link  `<a class="avatar" href="profile.html">`
 * @param {{name?: string}} me
 */
export function mountAvatar(link, me) {
  if (!link) return;
  const letter = initialFor(me?.name);
  link.replaceChildren(letterSvg(letter));
  link.setAttribute('aria-label', 'Your profile');
  link.title = 'Your profile';
}
