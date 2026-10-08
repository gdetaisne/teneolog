/**
 * les primitives de la grille de l'espace public : le contour
 * (anneaux orientés, coins qui se touchent, trous) et l'érosion de
 * l'ouverture. Sur de petites grilles écrites à la main. La simplification :
 * `open-space-simplify.test.ts`.
 */
import { describe, expect, it } from 'vitest';

import { signedArea, traceRings } from '../src/open-space-contour.js';
import { erodeSquare, grow } from '../src/open-space-grid.js';

/** Une grille depuis des lignes de texte, la PREMIÈRE ligne en bas (j = 0), `#` = 1. */
function grid(...lines: string[]): {
  readonly mask: Uint8Array;
  readonly cols: number;
  readonly rows: number;
} {
  const cols = lines[0]!.length;
  const mask = new Uint8Array(cols * lines.length);
  lines.forEach((line, j) => [...line].forEach((c, i) => (mask[j * cols + i] = c === '#' ? 1 : 0)));
  return { mask, cols, rows: lines.length };
}

describe('traceRings — la zone à gauche, un anneau par bord', () => {
  it('une cellule : un carré dans le sens trigonométrique, aire +1', () => {
    const { mask, cols, rows } = grid('#');
    const rings = traceRings(mask, cols, rows);
    expect(rings).toEqual([
      [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: 1 },
        { x: 0, y: 1 },
      ],
    ]);
    expect(signedArea(rings[0]!)).toBe(1);
  });

  it('deux cellules qui ne se touchent que par un coin : deux anneaux, jamais un huit', () => {
    const { mask, cols, rows } = grid('#.', '.#');
    const rings = traceRings(mask, cols, rows);
    expect(rings).toHaveLength(2);
    for (const ring of rings) {
      expect(ring).toHaveLength(4);
      expect(signedArea(ring)).toBe(1);
    }
  });

  it('un anneau percé : l’extérieur (+9) et le trou dans l’autre sens (−1)', () => {
    const { mask, cols, rows } = grid('###', '#.#', '###');
    const areas = traceRings(mask, cols, rows)
      .map(signedArea)
      .sort((a, b) => a - b);
    expect(areas).toEqual([-1, 9]);
  });

  it('seulement les coins : une bande droite de 5 cellules a 4 sommets', () => {
    const { mask, cols, rows } = grid('#####');
    expect(traceRings(mask, cols, rows)[0]).toHaveLength(4);
  });
});

describe('l’ouverture — érosion carrée puis croissance bornée', () => {
  it('érosion de rayon 1 : une bande de 1 cellule disparaît, une bande de 3 garde son milieu', () => {
    const thin = grid('.......', '#######', '.......');
    expect(erodeSquare(thin.mask, thin.cols, thin.rows, 1).includes(1)).toBe(false);
    const band = grid('.......', '#######', '#######', '#######', '.......');
    const core = erodeSquare(band.mask, band.cols, band.rows, 1);
    expect([...core.slice(2 * band.cols, 3 * band.cols)]).toEqual([0, 1, 1, 1, 1, 1, 0]);
    expect(core.reduce((a, b) => a + b, 0)).toBe(5);
  });

  it('croissance 4-voisins : ne passe pas un coin ; 8-voisins bornée : s’arrête à la profondeur', () => {
    const { mask, cols, rows } = grid('#.', '.#');
    const seed = new Uint8Array(4);
    seed[0] = 1;
    expect([...grow(seed, mask, { cols, rows }, { neighbours: 4, depth: Infinity })]).toEqual([
      1, 0, 0, 0,
    ]);
    expect([...grow(seed, mask, { cols, rows }, { neighbours: 8, depth: 1 })]).toEqual([
      1, 0, 0, 1,
    ]);
    const line = grid('#####');
    const start = new Uint8Array(5);
    start[0] = 1;
    expect([...grow(start, line.mask, { cols: 5, rows: 1 }, { neighbours: 8, depth: 2 })]).toEqual([
      1, 1, 1, 0, 0,
    ]);
  });
});
