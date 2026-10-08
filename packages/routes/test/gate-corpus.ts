/**
 * Le corpus de voisinages partagé par les tests de S3.
 *
 * Il vivait dans `gate-search.test.ts`, qui en est le premier lecteur ; il en
 * sort parce que la découverte silencieuse doit se mesurer sur
 * EXACTEMENT les mêmes deux mille mondes. Un deuxième générateur, même copié
 * à l'identique, aurait dérivé au premier ajustement, et le test d'or aurait
 * cessé de comparer ce qu'il croit comparer.
 *
 * La graine ne change pas : `rng(314)` rend les deux mille mêmes mondes qu'au
 * premier jour, et c'est la seule raison d'etre d'une graine fixe.
 */
import type { GeoPoint } from '@teneolog/domain';
import type { RoadNeighbourhood, RoadWay } from '@teneolog/topology';

import type { GateSearchInput } from '../src/gates.js';

export const O: GeoPoint = { lat: 47.0, lon: 1.0 };
const M_PER_DEG_LAT = 111_320;

export function at(base: GeoPoint, northM: number, eastM: number): GeoPoint {
  return {
    lat: base.lat + northM / M_PER_DEG_LAT,
    lon: base.lon + eastM / (M_PER_DEG_LAT * Math.cos((base.lat * Math.PI) / 180)),
  };
}

export function way(id: string, geometry: readonly GeoPoint[], overrides: Partial<RoadWay> = {}): RoadWay {
  return {
    id,
    source: 'osm-overpass',
    nodeIds: geometry.map((_, i) => `${id}:${i}`),
    geometry,
    name: null,
    importance: null,
    declaredWidthM: null,
    laneCount: null,
    oneWay: 'no',
    isPrivate: false,
    limits: { maxWeightT: null, maxHeightM: null, maxWidthM: null, maxLengthM: null },
    tags: { highway: 'residential' },
    ...overrides,
  };
}

export function hood(ways: readonly RoadWay[]): RoadNeighbourhood {
  return { centre: O, radiusM: 2_000, ways, nodes: [] };
}

export function input(ways: readonly RoadWay[], overrides: Partial<GateSearchInput> = {}): GateSearchInput {
  return {
    stop: O,
    neighbourhood: hood(ways),
    gateCount: 5,
    minDistanceM: 500,
    // zéro par défaut : ces cas mesurent la SÉLECTION (azimut,
    // places, classe), et un plancher de portée y écarterait des sommets
    // synthétiques pour une raison qui n'est pas celle qu'ils testent. Le cas
    // de la portée le pose lui-même, comme ceux de la découverte.
    minReachM: 0,
    maxDistanceM: 2_000,
    ...overrides,
  };
}

// ------------------------------------------------------------------- fixtures --

/** The three shapes `routes.test.ts` pins the rule with, plus the grey ones. */
export function corpus(): readonly { readonly name: string; readonly input: GateSearchInput }[] {
  const north = way('north', [at(O, 800, 0), at(O, 1_200, 0)], { tags: { highway: 'primary' } });
  const south = way('south', [at(O, -800, 0), at(O, -1_200, 0)], { tags: { highway: 'primary' } });
  const east = way('east', [at(O, 0, 500), at(O, 0, 700)], { tags: { highway: 'secondary' } });
  const residential = way('res', [at(O, 900, 0), at(O, 1_100, 0)]);
  const tooClose = way('close', [at(O, 100, 0), at(O, 200, 0)], { tags: { highway: 'primary' } });
  const tooFar = way('far', [at(O, 3_000, 0), at(O, 3_400, 0)], { tags: { highway: 'trunk' } });
  const footway = way('foot', [at(O, 700, 0), at(O, 900, 0)], { tags: { highway: 'footway' } });
  const departementale = way('d10', [at(O, 900, 0), at(O, 1_300, 0)], {
    source: 'bdtopo-postgis',
    importance: 3,
    tags: {},
  });
  // Two parallel arterials 10° apart: the second one can only lose on azimuth.
  const twinA = way('twin-a', [at(O, 1_400, 0), at(O, 1_800, 0)], { tags: { highway: 'primary' } });
  const twinB = way('twin-b', [at(O, 1_380, 240), at(O, 1_770, 310)], {
    tags: { highway: 'primary' },
  });

  return [
    { name: 'trois artères bien réparties', input: input([north, south, east], { gateCount: 4, minDistanceM: 300 }) },
    { name: 'rien de structurant en portée', input: input([residential, tooClose], { gateCount: 4, minDistanceM: 300 }) },
    { name: 'une départementale BDTOPO sans tag highway', input: input([departementale], { gateCount: 4, minDistanceM: 300 }) },
    { name: 'toutes les étapes à la fois', input: input([north, south, east, residential, tooClose, tooFar, footway, twinA, twinB]) },
    { name: 'deux artères à 10° : conflit d’azimut certain', input: input([twinA, twinB]) },
    { name: 'un voisinage vide', input: input([]) },
    { name: 'zéro ancre demandée', input: input([north, south], { gateCount: 0 }) },
    { name: 'une seule ancre demandée', input: input([north, south, east], { gateCount: 1 }) },
  ];
}

// ------------------------------------------ two thousand generated neighbourhoods --

/** mulberry32 — the same seed gives the same two thousand worlds, every run. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CLASSES: readonly (string | undefined)[] = [
  'motorway', 'trunk', 'primary', 'primary_link', 'secondary', 'tertiary', 'unclassified',
  'residential', 'living_street', 'service', 'track', 'footway', 'path', 'cycleway', undefined,
];

/**
 * A neighbourhood of random polylines around the stop.
 *
 * Vertices are drawn near the 500–2 000 m band on purpose: that is where the
 * comparator's tie-breaks and the azimuth floor actually bite. Flat random
 * points over the whole disc would mostly test the range filter.
 */
function randomInput(random: () => number, index: number): GateSearchInput {
  const wayCount = 1 + Math.floor(random() * 7);
  const ways: RoadWay[] = [];
  for (let w = 0; w < wayCount; w += 1) {
    const vertexCount = 2 + Math.floor(random() * 11);
    let azimuth = random() * 360;
    let distance = 200 + random() * 2_400;
    const geometry: GeoPoint[] = [];
    for (let v = 0; v < vertexCount; v += 1) {
      azimuth += (random() - 0.5) * 40;
      distance += (random() - 0.5) * 400;
      const rad = (azimuth * Math.PI) / 180;
      geometry.push(at(O, Math.cos(rad) * distance, Math.sin(rad) * distance));
      // One vertex in twenty is an exact duplicate of the previous one: equal
      // distances are precisely what the comparator's second term decides.
      if (random() < 0.05 && geometry.length > 0) geometry.push(geometry[geometry.length - 1] as GeoPoint);
    }
    const highway = CLASSES[Math.floor(random() * CLASSES.length)];
    ways.push(
      way(`w${index}-${w}`, geometry, {
        name: random() < 0.7 ? `Voie ${w}` : null,
        importance: random() < 0.3 ? 1 + Math.floor(random() * 5) : null,
        tags: highway === undefined ? {} : { highway },
      }),
    );
  }
  return input(ways, { gateCount: 1 + Math.floor(random() * 6) });
}

export function randomCorpus(count: number): readonly GateSearchInput[] {
  const random = rng(314);
  return Array.from({ length: count }, (_, i) => randomInput(random, i));
}

export const RANDOM = randomCorpus(2_000);

