/**
 * la simplification du contour ne fait croiser aucun côté
 * (`open-space-simplify.ts`, relecture du 2026-09-25).
 *
 * Le juge est écrit ici, à part du code : en coordonnées de SOMMETS de grille,
 * entières, deux côtés non consécutifs ne se croisent pas, aucun sommet ne
 * tombe dans l'intérieur d'un côté, aucun côté n'en double un autre — ils ne se
 * touchent qu'en un sommet commun. Sur des masques bruités (encoches, fentes,
 * obstacles d'une cellule), Douglas–Peucker anneau par anneau échoue à ce juge ;
 * la simplification livrée, jamais.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { signedArea, traceRings } from '../src/open-space-contour.js';
import type { XY } from '../src/open-space-grid.js';
import { simplifyRings } from '../src/open-space-simplify.js';

const orient = (a: XY, b: XY, c: XY): number =>
  Math.sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
const same = (p: XY, q: XY): boolean => p.x === q.x && p.y === q.y;
const inside = (p: XY, a: XY, b: XY): boolean =>
  orient(a, b, p) === 0 &&
  !same(p, a) &&
  !same(p, b) &&
  Math.min(a.x, b.x) <= p.x &&
  p.x <= Math.max(a.x, b.x) &&
  Math.min(a.y, b.y) <= p.y &&
  p.y <= Math.max(a.y, b.y);

/**
 * Les passages d'un même sommet qui s'y CROISENT (seconde relecture du
 * 2026-09-25) : les deux directions de l'un (vers le sommet d'avant, vers celui
 * d'après) de part et d'autre de l'angle de l'autre, ou une direction commune.
 * Par les angles (`atan2`), pas par le code testé.
 */
function pinchCrossings(rings: readonly (readonly XY[])[]): number {
  const TAU = 2 * Math.PI;
  const passes = new Map<string, (readonly [number, number])[]>();
  for (const ring of rings) {
    ring.forEach((o, k) => {
      const before = ring[(k - 1 + ring.length) % ring.length]!;
      const after = ring[(k + 1) % ring.length]!;
      const angles = [
        Math.atan2(before.y - o.y, before.x - o.x),
        Math.atan2(after.y - o.y, after.x - o.x),
      ] as const;
      const key = `${o.x},${o.y}`;
      passes.set(key, [...(passes.get(key) ?? []), angles]);
    });
  }
  let count = 0;
  for (const list of passes.values()) {
    for (let u = 0; u < list.length; u += 1) {
      for (let v = u + 1; v < list.length; v += 1) {
        const [a1, a2] = list[u]!;
        const turned = (angle: number): number => (((angle - a1) % TAU) + TAU) % TAU;
        const span = turned(a2);
        const [b1, b2] = list[v]!.map(turned) as [number, number];
        const onRay = [b1, b2].some((b) => b < 1e-12 || Math.abs(b - span) < 1e-12);
        if (onRay || b1 < span !== b2 < span) count += 1;
      }
    }
  }
  return count;
}

/** Le plus grand enroulement, en valeur absolue, sur quatre points par cellule : 1 pour des anneaux simples. */
function maxWinding(rings: readonly (readonly XY[])[], cols: number, rows: number): number {
  let worst = 0;
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < cols; x += 1) {
      for (const [ox, oy] of [
        [1 / 3, 1 / 3],
        [2 / 3, 1 / 3],
        [1 / 3, 2 / 3],
        [2 / 3, 2 / 3],
      ] as const) {
        worst = Math.max(worst, Math.abs(winding(rings, { x: x + ox, y: y + oy })));
      }
    }
  }
  return worst;
}

function winding(rings: readonly (readonly XY[])[], p: XY): number {
  let w = 0;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
      const [a, b] = [ring[j]!, ring[i]!];
      const side = (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y);
      if (a.y <= p.y && b.y > p.y && side > 0) w += 1;
      else if (a.y > p.y && b.y <= p.y && side < 0) w -= 1;
    }
  }
  return w;
}

/** Le nombre de fautes : paires de côtés (croisement, contact intérieur, doublon), côtés nuls, croisements à un sommet commun. */
function faults(rings: readonly (readonly XY[])[]): number {
  const sides = rings.flatMap((ring) =>
    ring.map((a, k) => [a, ring[(k + 1) % ring.length]!] as const),
  );
  let count = sides.filter(([a, b]) => same(a, b)).length;
  for (let i = 0; i < sides.length; i += 1) {
    for (let j = i + 1; j < sides.length; j += 1) {
      const [a, b] = sides[i]!;
      const [c, d] = sides[j]!;
      const crossing =
        orient(a, b, c) * orient(a, b, d) < 0 && orient(c, d, a) * orient(c, d, b) < 0;
      const touching = inside(c, a, b) || inside(d, a, b) || inside(a, c, d) || inside(b, c, d);
      const doubled = (same(a, c) && same(b, d)) || (same(a, d) && same(b, c));
      if (crossing || touching || doubled) count += 1;
    }
  }
  return count + pinchCrossings(rings);
}

/** Un générateur pseudo-aléatoire reproductible (mulberry32). */
function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Un masque bruité : des bandes pleines en biais, trouées et entaillées au hasard. */
function noisyMask(rand: () => number, cols: number, rows: number): Uint8Array {
  const mask = new Uint8Array(cols * rows);
  const slope = 0.3 + rand();
  for (let j = 0; j < rows; j += 1) {
    for (let i = 0; i < cols; i += 1) {
      const band = Math.abs(j - slope * i - rows / 4) < rows / 3;
      mask[j * cols + i] = (band ? rand() < 0.88 : rand() < 0.12) ? 1 : 0;
    }
  }
  return mask;
}

const vertexCount = (rings: readonly (readonly XY[])[]): number =>
  rings.reduce((n, r) => n + r.length, 0);

describe('simplifyRings — aucun côté n’en croise un autre', () => {
  it('sur 300 masques bruités : les anneaux tracés sont valides, et simplifiés ils le restent', () => {
    const rand = random(464);
    let before = 0;
    let after = 0;
    for (let trial = 0; trial < 300; trial += 1) {
      const rings = traceRings(noisyMask(rand, 18, 12), 18, 12);
      expect(faults(rings)).toBe(0);
      const simplified = simplifyRings(rings, 1);
      expect(faults(simplified), `masque ${trial}`).toBe(0);
      expect(maxWinding(simplified, 18, 12), `masque ${trial}`).toBeLessThanOrEqual(1);
      simplified.forEach((ring, r) => {
        expect(ring.length).toBeGreaterThanOrEqual(3);
        // Des sommets d'origine, dans leur ordre.
        const origin = rings[r]!;
        let cursor = 0;
        for (const p of ring) {
          while (cursor < origin.length && !same(origin[cursor]!, p)) cursor += 1;
          expect(cursor).toBeLessThan(origin.length);
        }
      });
      before += vertexCount(rings);
      after += vertexCount(simplified);
    }
    // Et elle simplifie quand même.
    expect(after).toBeLessThan(before * 0.9);
  });

  it('un bord en biais : l’escalier de 60 marches devient une pente, l’aire garde sa valeur à 2 % près', () => {
    const cols = 60;
    const rows = 70;
    const mask = new Uint8Array(cols * rows);
    for (let j = 0; j < rows; j += 1)
      for (let i = 0; i < cols; i += 1) mask[j * cols + i] = j <= i + 8 && j >= i ? 1 : 0;
    const rings = traceRings(mask, cols, rows);
    const simplified = simplifyRings(rings, 1);
    expect(vertexCount(rings)).toBeGreaterThan(200);
    expect(vertexCount(simplified)).toBeLessThanOrEqual(10);
    const area = (rs: readonly (readonly XY[])[]): number =>
      rs.reduce((sum, r) => sum + signedArea(r), 0);
    expect(Math.abs(area(simplified) - area(rings)) / area(rings)).toBeLessThan(0.02);
  });

  it('une fente d’une cellule en diagonale : les deux passages du même anneau par un sommet ne s’y croisent pas (seconde relecture)', () => {
    const fixture = JSON.parse(
      readFileSync(new URL('./fixtures/open-space-pinch.json', import.meta.url), 'utf8'),
    ) as { readonly cols: number; readonly rows: number; readonly mask: readonly string[] };
    const { cols, rows } = fixture;
    const mask = Uint8Array.from(fixture.mask.join(''), (c) => (c === '#' ? 1 : 0));
    const rings = traceRings(mask, cols, rows);
    expect(faults(rings)).toBe(0);
    expect(maxWinding(rings, cols, rows)).toBe(1);
    const simplified = simplifyRings(rings, 1);
    // Douglas–Peucker y faisait se croiser deux passages en (13, 48) et (17, 55) : enroulement 2 en (15,33 ; 52,33).
    expect(faults(simplified)).toBe(0);
    expect(Math.abs(winding(simplified, { x: 15 + 1 / 3, y: 52 + 1 / 3 }))).toBeLessThanOrEqual(1);
    expect(maxWinding(simplified, cols, rows)).toBe(1);
    expect(vertexCount(simplified)).toBeLessThan(vertexCount(rings));
  });

  it('un anneau de quatre sommets ou moins est rendu tel quel', () => {
    const square = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ];
    expect(simplifyRings([square], 1)).toEqual([square]);
  });
});
