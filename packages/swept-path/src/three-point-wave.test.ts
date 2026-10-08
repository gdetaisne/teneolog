/**
 * Le passage d'un niveau par un point qui tourne (`three-point-wave.ts`), là où il est le
 * plus fragile : AU DÉPART. Un mouvement qui repart de la pose de contact du précédent a son coin
 * exactement sur le niveau. S'il le franchit en partant, c'est un contact à τ = 0 ; s'il revient vers
 * l'intérieur, ce n'en est pas un. Avant la seconde relecture, l'arrondi mettait la racine à −1e-15
 * rad une fois sur deux, repliée à 2π − ε : hors du mouvement, pas vue.
 */
import { describe, expect, it } from 'vitest';

import { crossingRad, valueAt, type Wave } from './three-point-wave.js';

describe('crossingRad, un point déjà sur le niveau au départ', () => {
  it('qui le franchit en partant : contact à τ = 0 ; qui revient vers l’intérieur : pas de contact au départ', () => {
    let outward = 0;
    let inward = 0;
    for (let step = -60; step <= 60; step += 1) {
      const psi0 = step * 0.05;
      if (Math.abs(psi0) < 0.1) continue; // tangent au niveau : ni franchi, ni quitté
      for (const k of [1, -1]) {
        for (const base of [-4.15, 0, 7.3]) {
          const f: Wave = { base, rho: 12.7, psi0, k };
          const level = valueAt(f, 0);
          // f′(0) = −ρ·k·sin ψ0 : le sens dans lequel le point part.
          const goesUp = -k * Math.sin(psi0) > 0;
          for (const rising of [true, false]) {
            const tau = crossingRad(f, level, rising);
            const label = `ψ0 ${psi0.toFixed(2)}, k ${k}, base ${base}, ${rising ? 'en montant' : 'en descendant'}`;
            if (rising === goesUp) {
              outward += 1;
              expect(tau, label).toBeLessThanOrEqual(1e-9);
            } else {
              inward += 1;
              expect(tau, label).toBeGreaterThan(0.1);
            }
          }
        }
      }
    }
    expect(outward).toBeGreaterThan(300);
    expect(inward).toBeGreaterThan(300);
  });

  it('ailleurs, la racine est celle du niveau, dans le bon sens', () => {
    const f: Wave = { base: 1, rho: 2, psi0: 0.3, k: -1 };
    for (const [level, rising] of [[2.5, true], [2.5, false], [-0.5, false], [0, true]] as const) {
      const tau = crossingRad(f, level, rising);
      expect(valueAt(f, tau)).toBeCloseTo(level, 12);
      const slope = valueAt(f, tau + 1e-6) - valueAt(f, tau - 1e-6);
      expect(slope > 0, `${level} ${rising}`).toBe(rising);
    }
    expect(crossingRad(f, 3.5, true)).toBe(Number.POSITIVE_INFINITY);
  });
});
