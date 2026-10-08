/**
 * l'ordre de départ des corridors, et le tronc commun.
 *
 * Deux modules purs, deux questions. Le tri (`leg-priority.ts`) doit mettre
 * devant ce qui paraît le plus certain — moins de virages serrés, puis plus
 * structurant, puis moins de réseau local, puis plus court — et ne jamais
 * perdre une jambe en route. Le tronc (`common-trunk.ts`) doit rendre ce que
 * TOUTES les jambes partagent, et rien quand elles ne partagent rien.
 */
import { describe, expect, it } from 'vitest';
import type { GeoPoint } from '@teneolog/domain';
import type { RoadNeighbourhood, RoadWay } from '@teneolog/topology';

import { commonTrunkOf } from '../src/common-trunk.js';
import { countSharpTurns, orderLegsByCertainty, type LegShape } from '../src/leg-priority.js';

const O: GeoPoint = { lat: 47.0, lon: 1.0 };
const M_PER_DEG_LAT = 111_320;

function at(northM: number, eastM = 0): GeoPoint {
  return {
    lat: O.lat + northM / M_PER_DEG_LAT,
    lon: O.lon + eastM / (M_PER_DEG_LAT * Math.cos((O.lat * Math.PI) / 180)),
  };
}

function way(id: string, geometry: readonly GeoPoint[], highway: string): RoadWay {
  return {
    id,
    source: 'osm-overpass',
    nodeIds: geometry.map((_, i) => `${id}:${i}`),
    geometry,
    name: id,
    importance: null,
    declaredWidthM: null,
    laneCount: null,
    oneWay: 'no',
    isPrivate: false,
    limits: { maxWeightT: null, maxHeightM: null, maxWidthM: null, maxLengthM: null },
    tags: { highway },
  };
}

/**
 * Le voisinage structurant : une primaire au nord, une tertiaire à l'est.
 * Les deux commencent à 400 m du point — comme le voisinage réel de R0, qui
 * ne renvoie que ce qui est structurant.
 */
function neighbourhood(): RoadNeighbourhood {
  return {
    centre: at(0),
    radiusM: 2_000,
    ways: [
      way('primaire', [at(400, -300), at(2_000, -300)], 'primary'),
      way('tertiaire', [at(-300, 400), at(-300, 2_000)], 'tertiary'),
    ],
    nodes: [],
  };
}

/** Une jambe entrante droite depuis `from` jusqu'au point de livraison. */
function straightLeg(id: string, from: GeoPoint, stepM = 25): LegShape {
  const line: GeoPoint[] = [];
  const steps = 80;
  for (let i = steps; i >= 0; i -= 1) {
    line.push({
      lat: at(0).lat + ((from.lat - at(0).lat) * i) / steps,
      lon: at(0).lon + ((from.lon - at(0).lon) * i) / steps,
    });
  }
  void stepM;
  return { id, direction: 'in', polyline: line };
}

const ORDER_PARAMS = { minTurnDeg: 60, minSegmentM: 20, snapM: 25, batchSize: 4 } as const;

describe('les virages serrés d’un tracé', () => {
  it('une ligne droite n’en a aucun', () => {
    const line = [at(0), at(100), at(200), at(300)];
    expect(countSharpTurns(line, 20, 60)).toBe(0);
  });

  it('un angle droit en vaut un', () => {
    const line = [at(0), at(100), at(100, 100)];
    expect(countSharpTurns(line, 20, 60)).toBe(1);
  });

  it('trois angles droits en valent trois', () => {
    const line = [at(0), at(100), at(100, 100), at(200, 100), at(200, 200)];
    expect(countSharpTurns(line, 20, 60)).toBe(3);
  });

  it('les micro-sommets d’OSRM ne comptent pas comme des virages', () => {
    // Une ligne droite dessinée avec des sommets tous les 3 m et un bruit
    // latéral d'un mètre : le cap d'un sommet au suivant part dans tous les
    // sens, celui d'un tronçon de 20 m ne bouge pas.
    const line: GeoPoint[] = [];
    for (let m = 0; m <= 300; m += 3) line.push(at(m, m % 6 === 0 ? 1 : -1));
    expect(countSharpTurns(line, 20, 60)).toBe(0);
  });
});

describe('l’ordre de certitude', () => {
  it('moins de virages serrés d’abord', () => {
    const droite = straightLeg('droite', at(2_000, -300));
    const tordue: LegShape = {
      id: 'tordue',
      direction: 'in',
      // La même origine, mais en lacets : quatre angles droits.
      polyline: [at(2_000, -300), at(1_000, -300), at(1_000, 300), at(400, 300), at(400, -300), at(0)],
    };
    const order = orderLegsByCertainty({
      legs: [tordue, droite],
      neighbourhood: neighbourhood(),
      ...ORDER_PARAMS,
    });
    expect(order.map((leg) => leg.id)).toEqual(['droite', 'tordue']);
    expect(order[0]?.sharpTurns).toBe(0);
    expect(order[1]?.sharpTurns).toBeGreaterThan(0);
  });

  it('à virages égaux, la plus structurante passe devant', () => {
    const order = orderLegsByCertainty({
      legs: [straightLeg('depuis-tertiaire', at(-300, 2_000)), straightLeg('depuis-primaire', at(2_000, -300))],
      neighbourhood: neighbourhood(),
      ...ORDER_PARAMS,
    });
    expect(order.map((leg) => leg.id)).toEqual(['depuis-primaire', 'depuis-tertiaire']);
    expect(order[0]?.highwayRank).toBe(2); // primary
    expect(order[1]?.highwayRank).toBe(4); // tertiary
  });

  it('une origine hors de tout réseau structurant est la moins certaine', () => {
    const perdue = straightLeg('perdue', at(-2_000, -2_000));
    const order = orderLegsByCertainty({
      legs: [perdue, straightLeg('depuis-primaire', at(2_000, -300))],
      neighbourhood: neighbourhood(),
      ...ORDER_PARAMS,
    });
    expect(order.map((leg) => leg.id)).toEqual(['depuis-primaire', 'perdue']);
    expect(order[1]?.highwayRank).toBe(9);
    // Rien de structurant nulle part sur elle : tout son tracé est du local.
    expect(order[1]?.offStructuringM).toBeGreaterThan(2_000);
  });

  it('les lots suivent l’ordre, et le rang est dense', () => {
    const legs = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) =>
      straightLeg(`leg-${i}`, at(2_000 - i, -300)),
    );
    const order = orderLegsByCertainty({ legs, neighbourhood: neighbourhood(), ...ORDER_PARAMS });
    expect(order.map((leg) => leg.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(order.map((leg) => leg.batch)).toEqual([1, 1, 1, 1, 2, 2, 2, 2, 3]);
  });

  it('aucune jambe ne se perd dans le tri', () => {
    const legs = [
      straightLeg('a', at(2_000, -300)),
      straightLeg('b', at(-300, 2_000)),
      straightLeg('c', at(-2_000, -2_000)),
    ];
    const order = orderLegsByCertainty({ legs, neighbourhood: neighbourhood(), ...ORDER_PARAMS });
    expect([...order.map((leg) => leg.id)].sort()).toEqual(['a', 'b', 'c']);
  });

  it('deux jambes strictement identiques se départagent par leur nom — l’ordre est rejouable', () => {
    const legs = [straightLeg('zz', at(2_000, -300)), straightLeg('aa', at(2_000, -300))];
    const once = orderLegsByCertainty({ legs, neighbourhood: neighbourhood(), ...ORDER_PARAMS });
    const twice = orderLegsByCertainty({
      legs: [...legs].reverse(),
      neighbourhood: neighbourhood(),
      ...ORDER_PARAMS,
    });
    expect(once.map((l) => l.id)).toEqual(['aa', 'zz']);
    expect(twice.map((l) => l.id)).toEqual(['aa', 'zz']);
  });
});

describe('le tronc commun', () => {
  const TRUNK = { toleranceM: 15, stepM: 10, maxLengthM: 2_000 } as const;

  it('deux jambes qui arrivent par la même rue partagent cette rue', () => {
    // Les deux montent la même colonne sur 300 m, puis divergent.
    const shared = [at(300), at(200), at(100), at(0)];
    const a = { direction: 'in' as const, polyline: [at(1_300, 0), at(300), ...shared.slice(1)] };
    const b = { direction: 'in' as const, polyline: [at(300, 1_000), at(300), ...shared.slice(1)] };
    const trunk = commonTrunkOf({ stop: at(0), legs: [a, b], ...TRUNK });
    expect(trunk.lengthM).toBeGreaterThan(280);
    expect(trunk.lengthM).toBeLessThan(320);
    expect(trunk.legsCompared).toBe(2);
  });

  it('une rue traversante abordée des deux côtés n’a pas de tronc commun', () => {
    const nord = { direction: 'in' as const, polyline: [at(1_000), at(0)] };
    const sud = { direction: 'in' as const, polyline: [at(-1_000), at(0)] };
    const trunk = commonTrunkOf({ stop: at(0), legs: [nord, sud], ...TRUNK });
    expect(trunk.lengthM).toBe(0);
    expect(trunk.polyline).toEqual([]);
  });

  it('une entrante et une sortante par la même rue partagent la rue', () => {
    const entrante = { direction: 'in' as const, polyline: [at(1_000), at(200), at(0)] };
    const sortante = { direction: 'out' as const, polyline: [at(0), at(200), at(900, 400)] };
    const trunk = commonTrunkOf({ stop: at(0), legs: [entrante, sortante], ...TRUNK });
    expect(trunk.lengthM).toBeGreaterThan(180);
  });

  it('le tronc ne dépasse jamais la plus courte des jambes', () => {
    const longue = { direction: 'in' as const, polyline: [at(2_000), at(0)] };
    const courte = { direction: 'in' as const, polyline: [at(120), at(0)] };
    const trunk = commonTrunkOf({ stop: at(0), legs: [longue, courte], ...TRUNK });
    expect(trunk.lengthM).toBeLessThanOrEqual(120);
  });

  it('une seule jambe : tout ce qu’elle fait est commun, jusqu’au plafond', () => {
    const seule = { direction: 'in' as const, polyline: [at(500), at(0)] };
    const trunk = commonTrunkOf({ stop: at(0), legs: [seule], ...TRUNK });
    expect(trunk.lengthM).toBeGreaterThan(480);
    expect(trunk.legsCompared).toBe(1);
  });

  it('aucune jambe : rien de commun, et rien qui casse', () => {
    expect(commonTrunkOf({ stop: at(0), legs: [], ...TRUNK })).toEqual({
      polyline: [],
      lengthM: 0,
      legsCompared: 0,
    });
  });
});
