/**
 * S1 ter — LA MARCHE ARRIÈRE : reculer de l'arrêt jusqu'à la bouche.
 *
 * Ce que le responsable produit a tranché (principe 39, D1 option 3, 2026-09-24) : après un
 * « Non » sur le demi-tour, la marche arrière est une des quatre sorties — « une
 * question, jamais un verdict ; jamais pour un semi ». Ce module ne fait que la
 * MESURE : la longueur, la rectitude, la plus petite largeur déclarée, la rue
 * où le camion ressort. La décision est celle de l'opérateur ; le semi est lu
 * sur le fil, où le camion est connu (cette étape ne connaît pas de camion).
 *
 * LE TRAJET EST CELUI QUE LE HANDOFF A MESURÉ, pas un second. Deux façons de le
 * reconstituer étaient possibles : suivre les prédécesseurs d'un Dijkstra sur le
 * graphe (`reach.ts`), ou reprendre la chaîne que `explore` a parcourue pour la
 * bouche retenue (`HandoffWalk.legs`). La seconde est retenue parce qu'elle est
 * la seule qui ne puisse pas contredire le nombre : `Mouth.distanceFromStopM`
 * EST la somme des tronçons de cette chaîne, alors qu'un plus court chemin
 * pourrait passer par une allée de service que le handoff n'a pas prise, et
 * servir une ligne de 80 m sous une longueur de 108 m — deux formules pour une
 * distance (principe 23). Le garde-fou le dit quand même : une ligne qui ne
 * mesure pas la longueur à 1 m près n'est pas servie (inconnue,
 * `REVERSING_PATH_NOT_RESOLVED`).
 *
 * Le seuil de « ligne droite » (`straightMaxDeflectionDeg`) est un seuil
 * d'AFFICHAGE du mot, pas une règle de faisabilité : aucune source n'en donne
 * une (D5 ; principe 30 : un seuil ne se choisit pas dans le trou d'une adresse).
 *
 * Pur : mêmes entrées, même réponse.
 */
import {
  REVERSING_PATH_NOT_RESOLVED,
  type Fact,
  type GeoPoint,
  type Mouth,
  type ReversingPath,
  type ReversingWidth,
  type SourceId,
  type TerminalTopology,
} from '@teneolog/domain';

import { bearingDeg, bearingDeltaDeg, haversineM, polylineLengthM, withoutDegenerateSegments } from './geometry.js';
import type { HandoffLeg, HandoffWalk } from './handoff.js';
import type { RoadNeighbourhood, RoadWay } from './ports.js';

/** Policy: `pipeline.assessment.reversing`. */
export interface ReversingParams {
  /** At or under this sharpest heading change, the screen may say « ligne droite ». Display only. */
  readonly straightMaxDeflectionDeg: number;
}

export interface ReversingInput {
  readonly neighbourhood: RoadNeighbourhood;
  readonly topologyKind: TerminalTopology['kind'];
  /** The mouth S1 resolved, and the legs it was measured along. */
  readonly handoff: HandoffWalk;
  readonly params: ReversingParams;
  readonly fetchedAt: string;
}

/**
 * How far the laid-back line may differ from the handoff's metres. Not a
 * business number: the two are the same chain, so they agree to the
 * millimetre; a metre of slack absorbs the projection's rounding and nothing
 * else. Beyond it, something else was walked than what was measured.
 */
const PATH_LENGTH_TOLERANCE_M = 1;

const METHOD = 'reversing-along-handoff';

export function computeReversing(input: ReversingInput): Fact<ReversingPath> {
  // A through street has nothing to reverse out of: not applicable, which is
  // not « looked for, none » (principe 14).
  if (input.topologyKind === 'THROUGH') return { known: false, why: 'not_applicable' };
  const { mouth, legs } = input.handoff;
  if (!mouth.known) return { known: false, why: 'no_data' };

  const path = handoffPathOf(input.handoff);
  const from = path?.[0];
  if (path === null || from === undefined) return notResolved(mouth.provenance.source, input.fetchedAt);

  const maxDeflectionDeg = maxDeflectionOf(path);
  const value: ReversingPath = {
    from,
    to: mouth.value.point,
    path,
    lengthM: mouth.value.distanceFromStopM,
    maxDeflectionDeg,
    straight: isStraight(path, maxDeflectionDeg, input.params.straightMaxDeflectionDeg),
    straightMaxDeflectionDeg: input.params.straightMaxDeflectionDeg,
    narrowestWidth: narrowestWidthOf(waysCrossed(legs ?? [], input.neighbourhood), input.fetchedAt),
    exitsOnto: exitsOnto(mouth.value, input.neighbourhood),
    depth: mouth.value.depth,
  };
  return {
    known: true,
    value,
    provenance: { source: mouth.provenance.source, method: METHOD, fetchedAt: input.fetchedAt },
    // The proof that the street it comes out onto goes somewhere is the
    // handoff's, verbatim — as for the fallback stop. Nothing here upgrades it.
    reliability: {
      confidence: mouth.reliability.confidence,
      basis: 'derived',
      reasonCodes: [...mouth.reliability.reasonCodes, 'reversing_along_carriageway_axis'],
    },
  };
}

/**
 * The chain the handoff walked, laid back on the carriageway: from the
 * delivery point's projection on its street to the mouth, EXACTLY the metres
 * of `Mouth.distanceFromStopM`. Null when there is no mouth, no legs, or a
 * line that does not measure the number to `PATH_LENGTH_TOLERANCE_M` — never
 * a line that could contradict it. One reading for the reversing path and for
 * the fallback stop's walk (principe 23).
 */
export function handoffPathOf(walk: HandoffWalk): readonly GeoPoint[] | null {
  const { mouth, legs } = walk;
  if (!mouth.known || legs === null) return null;
  const path = pathOf(legs);
  if (path === null) return null;
  const mismatchM = Math.abs(polylineLengthM(path) - mouth.value.distanceFromStopM);
  return mismatchM > PATH_LENGTH_TOLERANCE_M ? null : path;
}

function notResolved(source: SourceId, fetchedAt: string): Fact<ReversingPath> {
  return { known: false, why: 'no_data', provenance: { source, method: REVERSING_PATH_NOT_RESOLVED, fetchedAt } };
}

/** The legs laid end to end, stop first, repeated joints and zero-length steps dropped. */
function pathOf(legs: readonly HandoffLeg[]): readonly GeoPoint[] | null {
  const out: GeoPoint[] = [];
  for (const leg of legs) {
    const line = sliceLeg(leg);
    if (line === null) return null;
    out.push(...line);
  }
  return out.length === 0 ? null : withoutDegenerateSegments(out);
}

/** The stretch of a leg between its two positions, in the direction walked. */
function sliceLeg(leg: HandoffLeg): GeoPoint[] | null {
  const lo = Math.min(leg.fromAlongM, leg.toAlongM);
  const hi = Math.max(leg.fromAlongM, leg.toAlongM);
  const start = pointAlong(leg, lo);
  const end = pointAlong(leg, hi);
  if (start === null || end === null) return null;
  const inner = leg.points.filter((_, i) => {
    const along = leg.alongM[i];
    return along !== undefined && along > lo && along < hi;
  });
  const line = [start, ...inner, end];
  return leg.fromAlongM <= leg.toAlongM ? line : line.reverse();
}

/** The point `alongM` metres from the chain head, interpolated inside its segment. */
function pointAlong(leg: HandoffLeg, alongM: number): GeoPoint | null {
  for (let i = 0; i < leg.points.length - 1; i += 1) {
    const a = leg.alongM[i];
    const b = leg.alongM[i + 1];
    const p = leg.points[i];
    const q = leg.points[i + 1];
    if (a === undefined || b === undefined || p === undefined || q === undefined) return null;
    if (alongM < a || alongM > b) continue;
    const t = b === a ? 0 : (alongM - a) / (b - a);
    return { lat: p.lat + t * (q.lat - p.lat), lon: p.lon + t * (q.lon - p.lon) };
  }
  return null;
}

/**
 * « Ligne droite », le mot que l'écran dira. Deux conditions, parce qu'une
 * seule ment dans un sens :
 *  - aucun pli plus fort que le seuil (un coude franc n'est pas droit) ;
 *  - et la corde (bout à bout) au moins `cos(seuil)` fois la longueur : dix
 *    plis de 9° font un quart de tour sans qu'aucun ne dépasse 15°, et leur
 *    corde n'est plus que 0,90 fois la longueur — ce n'est pas droit. Un seul
 *    pli de 15° au milieu garde une corde de 0,99 : droit.
 * Le même seuil d'affichage pour les deux, pas un second nombre.
 */
function isStraight(path: readonly GeoPoint[], maxDeflectionDeg: number, thresholdDeg: number): boolean {
  if (maxDeflectionDeg > thresholdDeg) return false;
  const first = path[0];
  const last = path[path.length - 1];
  const lengthM = polylineLengthM(path);
  if (first === undefined || last === undefined || lengthM === 0) return true;
  return haversineM(first, last) / lengthM >= Math.cos((thresholdDeg * Math.PI) / 180);
}

/**
 * The sharpest heading change between two successive segments, degrees.
 * Degenerate segments are already gone (`withoutDegenerateSegments`): a
 * repeated vertex reads as due north and would fabricate a turn.
 */
function maxDeflectionOf(path: readonly GeoPoint[]): number {
  let max = 0;
  let previous: number | null = null;
  for (let i = 1; i < path.length; i += 1) {
    const a = path[i - 1];
    const b = path[i];
    if (a === undefined || b === undefined) continue;
    const heading = bearingDeg(a, b);
    if (previous !== null) max = Math.max(max, bearingDeltaDeg(previous, heading));
    previous = heading;
  }
  return max;
}

function segmentKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** Which way draws each segment of the graph, keyed by its two nodes. */
function waysBySegment(hood: RoadNeighbourhood): ReadonlyMap<string, RoadWay> {
  const out = new Map<string, RoadWay>();
  for (const way of hood.ways) {
    for (let k = 0; k < way.nodeIds.length - 1; k += 1) {
      const a = way.nodeIds[k];
      const b = way.nodeIds[k + 1];
      if (a !== undefined && b !== undefined) out.set(segmentKey(a, b), way);
    }
  }
  return out;
}

/** The ways the path actually runs on: a segment counts when a positive stretch of it is walked. */
function waysCrossed(legs: readonly HandoffLeg[], hood: RoadNeighbourhood): readonly RoadWay[] {
  const bySegment = waysBySegment(hood);
  const crossed = new Map<string, RoadWay>();
  for (const leg of legs) {
    const lo = Math.min(leg.fromAlongM, leg.toAlongM);
    const hi = Math.max(leg.fromAlongM, leg.toAlongM);
    for (let k = 0; k < leg.nodeIds.length - 1; k += 1) {
      const way = walkedSegmentWay(leg, k, lo, hi, bySegment);
      if (way !== undefined) crossed.set(way.id, way);
    }
  }
  return [...crossed.values()];
}

function walkedSegmentWay(
  leg: HandoffLeg,
  k: number,
  lo: number,
  hi: number,
  bySegment: ReadonlyMap<string, RoadWay>,
): RoadWay | undefined {
  const a = leg.alongM[k];
  const b = leg.alongM[k + 1];
  const n = leg.nodeIds[k];
  const m = leg.nodeIds[k + 1];
  if (a === undefined || b === undefined || n === undefined || m === undefined) return undefined;
  if (b <= lo || a >= hi) return undefined;
  return bySegment.get(segmentKey(n, m));
}

/**
 * The narrowest width a crossed way DECLARES, with who declared it. Unknown
 * when none does — never a 0, never the street's class (principe 14).
 *
 * The confidence is in the reading — the source does state this number, as a
 * barrier tag read in S1 is stated (confidence 1, `declared`); how far a
 * declared width is worth as the physical road is S2's discount
 * (`declaredWidthConfidence`), not decided again here, because this fact
 * decides nothing: a declared width may absolve, never condemn (principe 5).
 * A grafted width keeps the source that stated it, the same
 * reading as `declaredWidth` of `@teneolog/constraints`.
 */
function narrowestWidthOf(ways: readonly RoadWay[], fetchedAt: string): Fact<ReversingWidth> {
  let narrowest: { readonly way: RoadWay; readonly widthM: number } | null = null;
  for (const way of [...ways].sort((x, y) => (x.id < y.id ? -1 : 1))) {
    const widthM = way.declaredWidthM;
    if (widthM === null) continue;
    if (narrowest === null || widthM < narrowest.widthM) narrowest = { way, widthM };
  }
  if (narrowest === null) return { known: false, why: 'no_data' };
  const grafted = narrowest.way.attributed?.declaredWidthM;
  return {
    known: true,
    value: { widthM: narrowest.widthM, segmentId: narrowest.way.id },
    provenance: {
      source: grafted?.source ?? narrowest.way.source,
      method: 'reversing-narrowest-declared-width',
      fetchedAt,
    },
    reliability: {
      confidence: 1,
      basis: 'declared',
      reasonCodes: grafted === undefined ? ['declared_width'] : ['declared_width', 'declared_width_grafted'],
    },
  };
}

function exitsOnto(mouth: Mouth, hood: RoadNeighbourhood): string | null {
  return hood.ways.find((w) => w.id === mouth.parentSegmentId)?.name ?? null;
}
