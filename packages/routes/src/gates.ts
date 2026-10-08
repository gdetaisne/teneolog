/**
 * S3 — gates: where candidate itineraries enter and leave the neighbourhood.
 *
 * The gates answer E3. A car-optimal router fed one origin produces one
 * car-optimal family of routes, under-sampling the arterial paths a large
 * vehicle would actually take. Gates picked ON the structuring network,
 * spread in azimuth around the stop, force the candidate set to approach
 * from genuinely different directions — diversify the GENERATION, never the
 * filtering.
 *
 * Pure: the caller fetched the wide neighbourhood; this module only chooses
 * points in it.
 *
 * ET UNE ANCRE DOIT ATTEINDRE LE CERCLE. Principe 7 : « l'ancre reste
 * le point à 2 km ; toute l'approche est contrôlée » ; principe 28 : « une
 * jambe qui n'atteint pas le cercle de 2 km n'entre pas en concurrence ». La
 * découverte applique cette règle au bout de ses jambes routées;
 * ici l'ancre EST ce bout, puisque le routeur part d'elle. Même règle, même
 * nombre de policy (`gates.minReachM`), et les voies recalées sont nommées dans
 * `search.shortOfRing` plutôt que tues.
 */
import type {
  ConsideredGateWay,
  GateSearch,
  GateShortOfRing,
  GeoPoint,
  RetainedGate,
} from '@teneolog/domain';
import {
  bearingDeg,
  haversineM,
  isDrivableWay,
  isStructuringHighway,
  type RoadNeighbourhood,
  type RoadWay,
} from '@teneolog/topology';

/** BDTOPO importance at or below this is structuring (lower = more so). */
const STRUCTURING_IMPORTANCE_MAX = 4;

export interface GateSearchInput {
  readonly stop: GeoPoint;
  readonly neighbourhood: RoadNeighbourhood;
  /** How many gates to keep. */
  readonly gateCount: number;
  /** A gate closer than this to the stop is not an approach, it is the stop. */
  readonly minDistanceM: number;
  /**
   * CE QU'UNE ANCRE DOIT ATTEINDRE POUR ENTRER EN CONCURRENCE.
   *
   * Principe 7 : « l'ancre reste le point à 2 km ; toute l'approche est
   * contrôlée » — et principe 28 : « une jambe qui n'atteint pas le cercle de
   * 2 km n'entre pas en concurrence ». La découverte applique cette règle
   * sur le bout de la jambe ROUTÉE; ici l'ancre EST ce bout,
   * puisque le routeur part d'elle, donc la même règle se lit sur le sommet.
   *
   * Elle ne remplace pas `minDistanceM` : celui-là dit ce que l'étude regarde
   * (plus près, c'est la rue de livraison, pas une approche), celle-ci dit ce
   * qui peut concourir. Entre les deux, un sommet est mesuré, listé dans
   * `shortOfRing`, et n'est pas une ancre.
   */
  readonly minReachM: number;
  /**
   * A gate farther than this is not an approach to this address either.
   *
   * The neighbourhood fetch returns whole ways that merely touch the search
   * circle, geometry included, so vertices well beyond it arrive in the pool.
   * Selecting the farthest of those turned a delivery on a boulevard into
   * four-kilometre itineraries looping across the arrondissement, and every
   * corner on them into a question.
   */
  readonly maxDistanceM: number;
}

export interface Gate {
  readonly at: GeoPoint;
  readonly wayId: string;
  readonly azimuthDeg: number;
  readonly distanceM: number;
}

/**
 * The gates, plus everything the selection looked at on its way to them.
 *
 *. The search is a strict by-product: it is written to from the same
 * passes that decide, never read by them. `gates` is bit-for-bit what
 * `findStructuringGates` has always returned.
 */
export interface GateSearchResult {
  readonly gates: readonly Gate[];
  readonly search: GateSearch;
}

export function findStructuringGates(input: GateSearchInput): readonly Gate[] {
  return findStructuringGatesWithSearch(input).gates;
}

/**
 * The same choice, with the grey layer kept.
 *
 * Used by `/explain`, which must be able to show that a boulevard was seen and
 * where it fell — not merely that five other roads won, which it never got the
 * chance to contest.
 */
export function findStructuringGatesWithSearch(input: GateSearchInput): GateSearchResult {
  const rows: Studied[] = [];
  const entries: Entry[] = [];
  const shortOfRing: GateShortOfRing[] = [];

  for (const way of input.neighbourhood.ways) {
    const row = study(way);
    rows.push(row);
    if (!isDrivableWay(way)) {
      row.stage = 'not_drivable';
      continue;
    }
    if (!isStructuringWay(way)) {
      row.stage = 'not_structuring';
      continue;
    }
    const short = measureVertices(input, way, row, entries);
    if (short !== null) shortOfRing.push(short);
  }

  const retained = spreadByAzimuth(entries, input.gateCount);
  return {
    gates: retained.map(({ rank: _rank, ...gate }) => gate),
    search: searchOf(input, rows, retained, shortOfRing),
  };
}

/**
 * Une voie, sommet par sommet : ce qui peut devenir une ancre va dans
 * `entries`, et ce que la portée écarte est rendu en une ligne.
 *
 * Sorti de la sélection pour la même raison que `routeAllRays` l'a
 * été de la découverte : la boucle y touchait la borne de complexité du cliquet
 * (principe 26). La coupure est celle du sujet — ici on mesure une voie, là-bas
 * on parcourt le voisinage.
 *
 * Rendre le sommet le PLUS LOINTAIN sous le seuil, et lui seul : c'est le
 * meilleur que la voie pouvait offrir, donc celui qui dit de combien il s'en
 * est fallu. Les trente-neuf autres sommets du même boulevard n'ajouteraient
 * rien qu'un lecteur veuille lire.
 */
function measureVertices(
  input: GateSearchInput,
  way: RoadWay,
  row: Studied,
  entries: Entry[],
): GateShortOfRing | null {
  let short: GateShortOfRing | null = null;
  for (const vertex of way.geometry) {
    const distanceM = haversineM(input.stop, vertex);
    // Measured over every vertex, in range or not: that is what tells a
    // reader whether a way with nothing in range sat too close or too far.
    if (row.nearestDistanceM === null || distanceM < row.nearestDistanceM) row.nearestDistanceM = distanceM;
    if (row.farthestDistanceM === null || distanceM > row.farthestDistanceM) row.farthestDistanceM = distanceM;
    if (distanceM < input.minDistanceM || distanceM > input.maxDistanceM) continue;
    const azimuthDeg = bearingDeg(input.stop, vertex);
    // mesuré, nommé, et pas une ancre : la jambe qui partirait de là
    // n'atteindrait pas le cercle (principe 7).
    if (distanceM < input.minReachM) {
      if (short === null || distanceM > short.reachM) {
        short = { wayId: way.id, name: way.name, at: vertex, azimuthDeg, reachM: distanceM };
      }
      continue;
    }
    row.inRangeVertexCount += 1;
    entries.push({ gate: { at: vertex, wayId: way.id, azimuthDeg, distanceM }, row });
  }
  // Une voie qui a fourni une ancre possible n'est pas « trop près » : ce qui
  // l'écarterait ensuite est l'azimut ou les places, et cela se dit ailleurs.
  return row.inRangeVertexCount > 0 ? null : short;
}

/**
 * The structuring vocabulary, exported so the discovery picks its
 * origins on exactly the network R0 picks its gates on. Two definitions of
 * "structuring" would make the two rules incomparable, which is the whole
 * point of running them side by side.
 */
export function isStructuringWay(way: RoadWay): boolean {
  if (isStructuringHighway(way.tags['highway'])) return true;
  return way.importance !== null && way.importance <= STRUCTURING_IMPORTANCE_MAX;
}

// ------------------------------------------------------------- the grey log --

/**
 * One `ConsideredGateWay` under construction.
 *
 * Mutable on purpose: a way's fate is only fully known once the selection
 * ends, and rebuilding the row at each stage would be one more place for the
 * log to drift from the decision. Keyed by way IDENTITY, not by `wayId` — two
 * ways may legitimately share an id, and folding them into one row would
 * invent a road nobody fetched.
 */
interface Studied {
  readonly way: RoadWay;
  inRangeVertexCount: number;
  nearestDistanceM: number | null;
  farthestDistanceM: number | null;
  /** The first in-range vertex the selection met — the farthest one. */
  best: Gate | null;
  outcome: ConsideredGateWay['outcome'];
  stage: ConsideredGateWay['stage'];
  conflictsWith: string | null;
}

/** A candidate vertex and the row of the way it came from. */
interface Entry {
  readonly gate: Gate;
  readonly row: Studied;
}

function study(way: RoadWay): Studied {
  return {
    way,
    inRangeVertexCount: 0,
    nearestDistanceM: null,
    farthestDistanceM: null,
    best: null,
    outcome: 'rejected',
    // Structuring and drivable until proven otherwise; a way that produces no
    // candidate at all stops here, which is exactly what that stage means.
    stage: 'no_vertex_in_range',
    conflictsWith: null,
  };
}

/**
 * Greedy farthest-first selection under a minimum angular separation.
 *
 * Not fixed sectors: a sector boundary at 90° puts a due-east gate (geodesic
 * azimuth ≈ 89.9°) in the same bin as due north, and the orthogonal approach
 * loses to a merely farther one. Distance-descending greedy keeps the far
 * gates (a long approach is what crosses the constraints the candidate
 * exists to reveal) and the separation floor keeps them genuinely spread.
 *
 * The rule is untouched; what is new is that the walk no longer stops the
 * moment the slots fill. It runs to the end of the sorted candidates so that
 * every way left out can say WHY — an azimuth already taken, or simply no
 * seat left. That costs one comparison per remaining candidate and decides
 * nothing: past `gateCount`, nothing can be kept any more.
 */
function spreadByAzimuth(entries: readonly Entry[], gateCount: number): readonly RetainedGate[] {
  if (entries.length === 0 || gateCount === 0) {
    // No slot at all: every way that had a candidate was crowded out before
    // the first comparison. Saying `no_vertex_in_range` would be a lie.
    if (gateCount === 0) for (const entry of entries) firstSeen(entry, 'slots_full', null);
    return [];
  }
  const minSeparationDeg = 360 / gateCount / 2;
  const sorted = [...entries].sort(
    (a, b) => b.gate.distanceM - a.gate.distanceM || (a.gate.wayId < b.gate.wayId ? -1 : 1),
  );
  const chosen: RetainedGate[] = [];
  for (const entry of sorted) {
    if (chosen.length >= gateCount) {
      firstSeen(entry, 'slots_full', null);
      continue;
    }
    // `find` where the rule used `every`: same boolean, and it names the gate
    // that stood in the way instead of merely counting one.
    const blocker = chosen.find(
      (held) => angularDiffDeg(held.azimuthDeg, entry.gate.azimuthDeg) < minSeparationDeg,
    );
    if (blocker !== undefined) {
      firstSeen(entry, 'azimuth_conflict', blocker.wayId);
      continue;
    }
    chosen.push({ ...entry.gate, rank: chosen.length + 1 });
    // A way whose best vertex lost on azimuth may still place a later one:
    // retention always overwrites, rejection never does.
    entry.row.best ??= entry.gate;
    entry.row.outcome = 'retained';
    entry.row.stage = 'retained';
    entry.row.conflictsWith = null;
  }
  return chosen.sort((a, b) => a.azimuthDeg - b.azimuthDeg);
}

/**
 * Records why a candidate was not kept — but only for the first candidate its
 * way offered, and only while the way has not been retained on another vertex.
 *
 * The first candidate of a way is its farthest in-range vertex, the one the
 * selection weighed first: its reason is the way's reason. The twentieth
 * vertex of the same boulevard failing on the same azimuth explains nothing
 * more.
 */
function firstSeen(entry: Entry, stage: ConsideredGateWay['stage'], conflictsWith: string | null): void {
  const { row } = entry;
  if (row.best !== null || row.outcome === 'retained') return;
  row.best = entry.gate;
  row.stage = stage;
  row.conflictsWith = conflictsWith;
}

function searchOf(
  input: GateSearchInput,
  rows: readonly Studied[],
  retained: readonly RetainedGate[],
  shortOfRing: readonly GateShortOfRing[],
): GateSearch {
  const considered: ConsideredGateWay[] = rows.map((row) => ({
    wayId: row.way.id,
    name: row.way.name,
    highway: row.way.tags['highway'] ?? null,
    importance: row.way.importance,
    // Referenced, not copied: the neighbourhood owns these points and is
    // discarded with the run.
    geometry: row.way.geometry,
    vertexCount: row.way.geometry.length,
    inRangeVertexCount: row.inRangeVertexCount,
    nearestDistanceM: row.nearestDistanceM,
    farthestDistanceM: row.farthestDistanceM,
    bestCandidate:
      row.best === null
        ? null
        : { at: row.best.at, azimuthDeg: row.best.azimuthDeg, distanceM: row.best.distanceM },
    outcome: row.outcome,
    stage: row.stage,
    conflictsWith: row.conflictsWith,
  }));
  return {
    stop: input.stop,
    searchRadiusM: input.maxDistanceM,
    // LE PLANCHER EFFECTIF, celui que la sélection a appliqué, et non
    // le plus bas des deux seuils.
    //
    // `/explain` écrit « les ancres se cherchent entre X et Y de l'arrêt » avec
    // ce nombre. Y servir 500 m quand aucune ancre ne peut se poser sous
    // 1 800 m dirait à l'opérateur un seuil que le moteur n'applique pas —
    // exactement le genre de chiffre faux qu'un écran ne doit pas porter.
    // `minReachM` juste en dessous dit laquelle des deux règles l'a fixé.
    minDistanceM: Math.max(input.minDistanceM, input.minReachM),
    minReachM: input.minReachM,
    shortOfRing,
    gateCount: input.gateCount,
    // Zero gates means no separation was ever applied; 360/0/2 would publish
    // an Infinity that JSON turns into null.
    minSeparationDeg: input.gateCount === 0 ? 0 : 360 / input.gateCount / 2,
    retained,
    considered,
    // the discovery needs a router and the whole R0 outcome to be
    // measured against; this function is pure and has neither. The pipeline
    // fills it in afterwards, without touching a single gate above.
    discovery: null,
    // l'étage axes demande la BD TOPO, pour la même raison et avec
    // la même conséquence — le pipeline le remplit, cette fonction reste pure.
    axes: null,
    uncontrolledApproaches: [],
  };
}

function angularDiffDeg(a: number, b: number): number {
  const d = Math.abs(((a - b) % 360) + 360) % 360;
  return d > 180 ? 360 - d : d;
}
