/**
 * 3 route du Modèle, 79260 La Crèche, sur le voisinage OSM que S1 a
 * lu (`fixtures/la-creche-route-du-modele.json` : 320 m, le barreau où la prod
 * a conclu l'impasse, relu par Overpass le 2026-09-30 ; le même arrêt de repli
 * que le job d89e4b42 de la prod, Rue Voisine B, 268 m à pied).
 *
 * Décision produit : l'écran de sortie doit MONTRER la marche jusqu'à
 * l'autre point de livraison. Le fil ne portait que ses longueurs ; l'écran
 * refaisait une ligne à partir de la marche arrière (`engineWalkOf`). La
 * ligne est maintenant celle sur laquelle le moteur a compté les mètres.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { haversineM, polylineLengthM } from '../src/geometry.js';
import type { RoadNeighbourhood } from '../src/ports.js';
import { assessTopology } from '../src/topology-assessment.js';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/la-creche-route-du-modele.json', import.meta.url), 'utf8'),
) as { point: { lat: number; lon: number }; deliveryWayId: string; hood: RoadNeighbourhood };

/** La porte : le point de la prod (turnaroundMap.door), la fin de la marche. */
const DOOR = { lat: 46.372455, lon: -0.256067 };
/** L'arrêt de repli de la prod (fallbackStop.stopAt, job d89e4b42). */
const PROD_STOP = { lat: 46.3707484036512, lon: -0.25469261475624396 };
/** L'entrée de l'impasse de la prod (fallbackStop.mouth). */
const PROD_MOUTH = { lat: 46.3707589, lon: -0.2544977 };

// Les réglages de la policy (pipeline.assessment), tels que la prod les lit.
const assessed = assessTopology({
  neighbourhood: fixture.hood,
  surfaces: [],
  deliveryWayId: fixture.deliveryWayId,
  deliveryPoint: fixture.point,
  turnaroundSearchRadiusM: 120,
  maxMouthDepth: 2,
  maxDeviationDeg: 40,
  barrierSnapM: 6,
  measurement: {
    defaultTurningCircleDiameterM: null,
    fallbackCarriagewayWidthM: null,
    loopClosureToleranceM: 3,
    observedAt: '2026-09-30T00:00:00Z',
  },
  fallbackStop: { plainWalkMaxM: 50, portageWalkMaxM: 150, stopOffsetM: 15 },
  reversing: { straightMaxDeflectionDeg: 15 },
});

function walkOf() {
  const fact = assessed.fallbackStop;
  if (fact === undefined || !fact.known) throw new Error('fallback stop not computed');
  return fact.value;
}

describe('La Crèche — la marche de l’arrêt de repli, tracée', () => {
  it('le fixture rejoue la prod : même arrêt, même bouche, 268 m à pied, au-delà des 150 m', () => {
    const stop = walkOf();
    expect(fixture.point).toEqual(DOOR);
    expect(haversineM(stop.stopAt, PROD_STOP)).toBeLessThan(0.1);
    expect(haversineM(stop.mouth, PROD_MOUTH)).toBeLessThan(0.1);
    expect(Math.round(stop.walk.totalM)).toBe(268);
    expect(stop.band).toBe('beyond');
  });

  it('la ligne part de l’arrêt, finit à la porte, et mesure les mètres servis', () => {
    const { walk, stopAt } = walkOf();
    const path = walk.path;
    expect(path).not.toBeNull();
    if (path === null) return;
    expect(haversineM(path[0]!, stopAt)).toBeLessThan(0.1);
    expect(haversineM(path[path.length - 1]!, DOOR)).toBeLessThan(0.1);
    // Une ligne, une mesure (principe 23) : à moins d'un mètre de `totalM`.
    expect(Math.abs(polylineLengthM(path) - walk.totalM)).toBeLessThan(1);
  });

  it('elle passe par l’entrée de l’impasse après les 15 m de la Rue Voisine B, puis suit la marche arrière à rebours', () => {
    const { walk, mouth } = walkOf();
    const path = walk.path!;
    // A : 15 m le long de la rue d'avant, puis la bouche.
    const atMouth = path.findIndex((p) => haversineM(p, mouth) < 0.5);
    expect(atMouth).toBeGreaterThan(0);
    expect(polylineLengthM(path.slice(0, atMouth + 1))).toBeCloseTo(walk.stopToMouthM, 0);
    // B : la chaîne de la marche arrière, sommet pour sommet, dans l'autre sens.
    const reversing = assessed.reversing;
    expect(reversing?.known).toBe(true);
    if (reversing === undefined || !reversing.known) return;
    const back = [...reversing.value.path].reverse();
    expect(path.slice(atMouth, atMouth + back.length)).toEqual(back);
    expect(polylineLengthM(back)).toBeCloseTo(walk.mouthToPointM, 3);
  });
});

describe('la marche sans ligne (principe 14)', () => {
  it('sans chaîne rejouable, la marche garde ses mètres et n’a pas de ligne', async () => {
    const { computeFallbackStop } = await import('../src/fallback-stop.js');
    const fact = computeFallbackStop({
      neighbourhood: fixture.hood,
      deliveryWayId: fixture.deliveryWayId,
      deliveryPoint: fixture.point,
      topologyKind: 'DEAD_END',
      handoff: assessed.handoff,
      handoffPath: null,
      params: { plainWalkMaxM: 50, portageWalkMaxM: 150, stopOffsetM: 15 },
      barriersAlong: () => [],
      fetchedAt: '2026-09-30T00:00:00Z',
    });
    expect(fact.known).toBe(true);
    if (!fact.known) return;
    expect(Math.round(fact.value.walk.totalM)).toBe(268);
    expect(fact.value.walk.path).toBeNull();
  });
});
