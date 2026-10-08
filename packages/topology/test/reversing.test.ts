/**
 * la marche arrière : le trajet que le handoff a mesuré, et rien
 * d'autre ; sa longueur est la sienne ; sa rectitude, sa plus petite largeur
 * déclarée et la rue où il ressort ; et ce qui n'est pas une réponse.
 *
 * Ce que les tests prouvent, contre quoi ils pourraient échouer :
 *  - la ligne servie mesure `handoff.distanceFromStopM` à 1 m près, sur une
 *    impasse droite (Sèvremoine), coudée et imbriquée — une ligne reconstruite
 *    par un autre chemin (Dijkstra, vol d'oiseau) échouerait sur la coudée ;
 *  - la déviation se lit sur les tronçons du trajet seulement : le coude à 90°
 *    est vu, un pli de 10° reste une ligne droite au seuil de 15° ;
 *  - la largeur est celle des voies PARCOURUES : une voie plus étroite au-delà
 *    de l'arrêt, côté bout fermé, ne compte pas.
 */
import { describe, expect, it } from 'vitest';
import { REVERSING_PATH_NOT_RESOLVED, type GeoPoint } from '@teneolog/domain';

import { haversineM, polylineLengthM } from '../src/geometry.js';
import { resolveHandoffWalk } from '../src/handoff.js';
import type { RoadNeighbourhood, RoadWay } from '../src/ports.js';
import { computeReversing, type ReversingInput } from '../src/reversing.js';
import { assessTopology } from '../src/topology-assessment.js';
import { at, sevremoine, neighbourhood, way } from './fixtures.js';

const O: GeoPoint = { lat: 47.125714, lon: -0.946111 };
const PARAMS = { straightMaxDeflectionDeg: 15 };
const FETCHED_AT = '2026-09-24T10:00:00Z';

function sevremoineHood(): RoadNeighbourhood {
  const [allee, parent, other, stub] = sevremoine(O) as [RoadWay, RoadWay, RoadWay, RoadWay];
  return neighbourhood(O, 120, [allee, { ...parent, name: 'Rue Voisine MA' }, other, stub]);
}

function input(hood: RoadNeighbourhood, deliveryWayId: string, overrides: Partial<ReversingInput> = {}): ReversingInput {
  return {
    neighbourhood: hood,
    topologyKind: 'DEAD_END',
    handoff: resolveHandoffWalk({
      neighbourhood: hood,
      deliveryWayId,
      deliveryPoint: O,
      maxDepth: 2,
      maxDeviationDeg: 40,
      fetchedAt: FETCHED_AT,
    }),
    params: PARAMS,
    fetchedAt: FETCHED_AT,
    ...overrides,
  };
}

function measured(i: ReversingInput) {
  const fact = computeReversing(i);
  if (!fact.known) throw new Error(`expected a reversing path, got ${fact.why}`);
  const mouth = i.handoff.mouth;
  if (!mouth.known) throw new Error('expected a mouth');
  return { value: fact.value, fact, mouth: mouth.value };
}

/** An L-shaped impasse: 30 m east then 40 m north to the mouth — 70 m by road, 50 m as the crow flies. */
function bentHood(): RoadNeighbourhood {
  const impasse = way('impasse', ['tip', 'corner', 'mouth'], [O, at(O, 0, 30), at(O, 40, 30)]);
  const parent = way('parent', ['p1', 'mouth', 'p2'], [at(O, 40, -10), at(O, 40, 30), at(O, 40, 70)], {
    name: 'Rue Haute',
  });
  const cross = way('cross', ['c1', 'p1', 'c2'], [at(O, 80, -10), at(O, 40, -10), at(O, 0, -10)]);
  return neighbourhood(O, 120, [impasse, parent, cross]);
}

/**
 * A5 of the handoff: the impasse opens onto a pocket, closed at its far end,
 * that a through street crosses mid-length — the mouth is one street deep.
 */
function nestedHood(): RoadNeighbourhood {
  const inner = way('inner', ['j1', 'tip'], [at(O, 0, -10), at(O, 0, 25)]);
  const pocket = way('pocket', ['pocket-tip', 'j2', 'j1'], [at(O, 70, -10), at(O, 35, -10), at(O, 0, -10)]);
  const through = way('through', ['t1', 'j2', 't2'], [at(O, 35, -60), at(O, 35, -10), at(O, 35, 40)], {
    name: 'Rue Traversante',
  });
  const crossT = way('cross-t', ['x1', 't1', 'x2'], [at(O, 70, -60), at(O, 35, -60), at(O, 0, -60)]);
  return neighbourhood(O, 120, [inner, pocket, through, crossT]);
}

describe('computeReversing — le trajet est celui que le handoff a mesuré', () => {
  it('Sèvremoine : 20 m, de la projection du point à la bouche, en ligne droite, sur Rue Voisine MA', () => {
    const { value, fact, mouth } = measured(input(sevremoineHood(), 'allee'));
    expect(value.lengthM).toBe(mouth.distanceFromStopM);
    expect(value.lengthM).toBeCloseTo(20, 0);
    expect(Math.abs(polylineLengthM(value.path) - value.lengthM)).toBeLessThanOrEqual(1);
    expect(haversineM(value.from, O)).toBeLessThan(0.5);
    expect(value.to).toEqual(mouth.point);
    expect(value.path[value.path.length - 1]).toEqual(mouth.point);
    expect(value.maxDeflectionDeg).toBeLessThan(1);
    expect(value.straight).toBe(true);
    expect(value.straightMaxDeflectionDeg).toBe(15);
    expect(value.exitsOnto).toBe('Rue Voisine MA');
    expect(value.depth).toBe(0);
    // The only way walked is the allée (3 m, declared by OSM): the stub
    // at `j` and the parent are not on the path.
    expect(value.narrowestWidth).toMatchObject({
      known: true,
      value: { widthM: 3, segmentId: 'allee' },
      provenance: { source: 'osm-overpass' },
      reliability: { basis: 'declared', reasonCodes: ['declared_width'] },
    });
    // The handoff's proof travels verbatim: the Rue Voisine MA only leaves
    // the fetch here, so 0,5 — nothing upgrades it.
    expect(fact.reliability.confidence).toBe(0.5);
    expect(fact.reliability.reasonCodes).toEqual(
      expect.arrayContaining([
        'mouth_at_delivery_street_junction',
        'parent_continuity_beyond_fetch',
        'reversing_along_carriageway_axis',
      ]),
    );
  });

  it('impasse coudée : 70 m le long de la voie (pas 50 à vol d’oiseau), le coude à 90° est vu', () => {
    const { value, mouth } = measured(input(bentHood(), 'impasse'));
    expect(value.lengthM).toBe(mouth.distanceFromStopM);
    expect(value.lengthM).toBeCloseTo(70, 0);
    expect(Math.abs(polylineLengthM(value.path) - value.lengthM)).toBeLessThanOrEqual(1);
    expect(value.path).toContainEqual(at(O, 0, 30));
    expect(value.maxDeflectionDeg).toBeGreaterThan(89);
    expect(value.maxDeflectionDeg).toBeLessThan(91);
    expect(value.straight).toBe(false);
    expect(value.exitsOnto).toBe('Rue Haute');
    // No way on the path declares a width: an unknown, said as such — never a 0.
    expect(value.narrowestWidth).toEqual({ known: false, why: 'no_data' });
  });

  it('impasse imbriquée (profondeur 1) : le trajet passe par la poche jusqu’à la traversante', () => {
    const { value, mouth } = measured(input(nestedHood(), 'inner'));
    expect(mouth.depth).toBe(1);
    expect(value.depth).toBe(1);
    expect(value.lengthM).toBe(mouth.distanceFromStopM);
    expect(value.lengthM).toBeCloseTo(45, 0);
    expect(Math.abs(polylineLengthM(value.path) - value.lengthM)).toBeLessThanOrEqual(1);
    // Through the pocket's junction, then north to the through street — the
    // joint between the two legs is not repeated.
    expect(value.path).toEqual([expect.anything(), at(O, 0, -10), at(O, 35, -10)]);
    expect(value.maxDeflectionDeg).toBeGreaterThan(89);
    expect(value.exitsOnto).toBe('Rue Traversante');
  });

  it('un pli de 10° reste une « ligne droite » au seuil de 15°, et ne l’est plus au seuil de 5°', () => {
    // 30 m due west, then 30 m 10° north of west, to the parent.
    const kink = at(O, 0, -30);
    const mouthAt = at(O, 30 * Math.sin((10 * Math.PI) / 180), -30 - 30 * Math.cos((10 * Math.PI) / 180));
    const allee = way('allee', ['tip', 'k', 'mouth'], [at(O, 0, 20), kink, mouthAt]);
    const parent = way('parent', ['p1', 'mouth', 'p2'], [
      { lat: mouthAt.lat + 0.002, lon: mouthAt.lon },
      mouthAt,
      { lat: mouthAt.lat - 0.002, lon: mouthAt.lon },
    ]);
    const hood = neighbourhood(O, 120, [allee, parent]);
    const at15 = measured(input(hood, 'allee')).value;
    expect(at15.maxDeflectionDeg).toBeGreaterThan(9);
    expect(at15.maxDeflectionDeg).toBeLessThan(11);
    expect(at15.straight).toBe(true);
    expect(measured(input(hood, 'allee', { params: { straightMaxDeflectionDeg: 5 } })).value.straight).toBe(false);
  });

  it('dix plis de 9° qui font un quart de tour ne sont pas une « ligne droite », même si aucun ne dépasse 15°', () => {
    // An arc of 90° drawn as ten 9° plies, 12 m each, from the tip to the mouth.
    const pts: GeoPoint[] = [O];
    let north = 0;
    let east = 0;
    for (let k = 0; k < 10; k += 1) {
      // Math angle of the segment: 180° is due west, 90° due north; 9° per ply.
      const theta = ((175.5 - 9 * k) * Math.PI) / 180;
      east += 12 * Math.cos(theta);
      north += 12 * Math.sin(theta);
      pts.push(at(O, north, east));
    }
    const ids = pts.map((_, k) => (k === 0 ? 'tip' : k === pts.length - 1 ? 'mouth' : `a${k}`));
    const mouthAt = pts[pts.length - 1]!;
    const allee = way('allee', ids, pts);
    const parent = way('parent', ['p1', 'mouth', 'p2'], [
      { lat: mouthAt.lat, lon: mouthAt.lon - 0.003 },
      mouthAt,
      { lat: mouthAt.lat, lon: mouthAt.lon + 0.003 },
    ]);
    const hood = neighbourhood(O, 200, [allee, parent]);
    const arc = measured(input(hood, 'allee')).value;
    expect(arc.maxDeflectionDeg).toBeLessThan(10);
    expect(haversineM(arc.path[0]!, arc.path[arc.path.length - 1]!) / arc.lengthM).toBeLessThan(0.95);
    expect(arc.straight).toBe(false);
  });

  it('la largeur est celle des voies parcourues : l’étroite au-delà de l’arrêt ne compte pas, la greffée garde sa source', () => {
    // One street, three ways in a straight line: `beyond` (2,5 m) toward the
    // closed tip, `here` (4 m) where the point sits, `out` (3,2 m, grafted
    // from the BD TOPO) to the parent.
    const beyond = way('beyond', ['tip', 'x'], [at(O, 0, 40), at(O, 0, 10)], { declaredWidthM: 2.5 });
    const here = way('here', ['x', 'y'], [at(O, 0, 10), at(O, 0, -20)], { declaredWidthM: 4 });
    const out: RoadWay = {
      ...way('out', ['y', 'mouth'], [at(O, 0, -20), at(O, 0, -50)], { declaredWidthM: 3.2 }),
      attributed: { declaredWidthM: { source: 'bdtopo-postgis', donorWayId: 'bd-1', offsetM: 0.6, coverage: 0.9 } },
    };
    const parent = way('parent', ['p1', 'mouth', 'p2'], [at(O, 200, -50), at(O, 0, -50), at(O, -200, -50)]);
    const hood = neighbourhood(O, 120, [beyond, here, out, parent]);
    const { value } = measured(input(hood, 'here'));
    expect(value.lengthM).toBeCloseTo(50, 0);
    expect(value.narrowestWidth).toMatchObject({
      known: true,
      value: { widthM: 3.2, segmentId: 'out' },
      provenance: { source: 'bdtopo-postgis' },
      reliability: { basis: 'declared', reasonCodes: ['declared_width', 'declared_width_grafted'] },
    });
  });
});

describe('computeReversing — ce qui n’est pas une réponse', () => {
  it('rue traversante : non applicable, pas « cherché, rien »', () => {
    expect(computeReversing(input(sevremoineHood(), 'allee', { topologyKind: 'THROUGH' }))).toEqual({
      known: false,
      why: 'not_applicable',
    });
  });

  it('sans bouche : inconnu no_data, sans provenance inventée', () => {
    const none = computeReversing(
      input(sevremoineHood(), 'allee', { handoff: { mouth: { known: false, why: 'no_data' }, legs: null, street: null } }),
    );
    expect(none).toEqual({ known: false, why: 'no_data' });
  });

  it('une bouche sans trajet, ou un trajet qui ne mesure pas la longueur : inconnu, et la raison est nommée', () => {
    const base = input(sevremoineHood(), 'allee');
    if (!base.handoff.mouth.known) throw new Error('expected a mouth');
    const noLegs = computeReversing({ ...base, handoff: { ...base.handoff, legs: null } });
    expect(noLegs).toMatchObject({ known: false, why: 'no_data', provenance: { method: REVERSING_PATH_NOT_RESOLVED } });

    // Five metres more than the chain walked: the line would lie about the number.
    const longer = {
      ...base.handoff.mouth,
      value: { ...base.handoff.mouth.value, distanceFromStopM: base.handoff.mouth.value.distanceFromStopM + 5 },
    };
    const mismatch = computeReversing({ ...base, handoff: { ...base.handoff, mouth: longer } });
    expect(mismatch).toMatchObject({ known: false, provenance: { method: REVERSING_PATH_NOT_RESOLVED } });
  });
});

describe('assessTopology — le bloc de policy décide seul de la présence du champ', () => {
  const assessment = (reversing?: { straightMaxDeflectionDeg: number }) =>
    assessTopology({
      neighbourhood: sevremoineHood(),
      surfaces: [],
      deliveryWayId: 'allee',
      deliveryPoint: O,
      turnaroundSearchRadiusM: 120,
      maxMouthDepth: 2,
      maxDeviationDeg: 40,
      barrierSnapM: 6,
      measurement: {
        defaultTurningCircleDiameterM: null,
        fallbackCarriagewayWidthM: null,
        loopClosureToleranceM: 3,
        observedAt: FETCHED_AT,
      },
      ...(reversing === undefined ? {} : { reversing }),
    });

  it('sans le bloc : pas de champ, et le reste est identique', () => {
    const before = assessment();
    const after = assessment(PARAMS);
    expect('reversing' in before).toBe(false);
    const { reversing, ...rest } = after;
    expect(rest).toEqual(before);
    expect(reversing?.known).toBe(true);
    if (reversing?.known !== true || !before.handoff.known) return;
    expect(reversing.value.lengthM).toBe(before.handoff.value.distanceFromStopM);
  });
});
