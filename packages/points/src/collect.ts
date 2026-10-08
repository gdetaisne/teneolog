/**
 * S4 — the assembled point set for one analysis.
 *
 * Detectors run per candidate; points dedupe by their location-keyed ref, so
 * the same corner reached by three candidates is ONE point with one identity
 * — the property that lets a single human judgement cover every itinerary
 * that passes there, and later runs find it again (architecture §3.3).
 *
 * A registry, not a switch (architecture §5): adding a point type is one
 * detector added here plus its evaluator in S5, nothing touching the others.
 */
import type {
  CriticalPoint,
  Fact,
  GeoPoint,
  PointGeometry,
  PointRef,
  RouteCandidate,
  StopConstraints,
  TerminalTopology,
} from '@teneolog/domain';
import { haversineM } from '@teneolog/topology';
import type { RoadWay } from '@teneolog/topology';

import { makePointRef } from './point-ref.js';
import type { RoundaboutDetectionParams } from './roundabouts.js';
import { routePoints } from './route-points.js';
import type { TurnDetectionParams } from './turns.js';

export interface CollectPointsParams {
  readonly turns: TurnDetectionParams;
  readonly roundabouts: RoundaboutDetectionParams;
  /** Free width strictly below this makes a run of segments a NARROW point. */
  readonly narrowMaxFreeM: number;
  /**
   * Same-type points closer than this are one place. Identity is arbitrated
   * by METRIC distance, not by coordinate truncation: rounding to grid cells
   * puts two apexes 1 m apart on either side of a cell boundary under two
   * refs, and the same corner collects two judgements (seen live, Poitiers).
   */
  readonly dedupeWithinM: number;
  /**
   * Two junction turns closer than this chain: there is no room to straighten
   * up between them (rule R-S, juin 2026). Published as a fact on the second
   * one for the ranking to weigh — never a penalty here.
   */
  readonly chainedWithinM: number;
}

export interface CollectPointsInput {
  readonly candidates: readonly RouteCandidate[];
  /** Corridor ways per candidate id — the same ground S3 annotated against. */
  readonly corridors: ReadonlyMap<string, readonly RoadWay[]>;
  readonly stop: StopConstraints;
  readonly topology: TerminalTopology;
  readonly fetchedAt: string;
  /**
   * VV1-06 / whether the terminal node was proven interior to the
   * last topology fetch radius. Absent defaults to `true` for backward
   * compatibility; the pipeline always passes the real value.
   * When false, the TURNAROUND evaluator (S5) may not publish NO.
   */
  readonly terminalNodeInterior?: boolean;
  /**
   * Where the mapper named a turnaround, when the diameter is still unknown.
   * Without it the point stays at the stop — the 3 m circle in front of the
   * house (Sèvremoine).
   */
  readonly turnaroundAt?: GeoPoint | undefined;
}

export interface CollectedPoints {
  /**
   * Every place found, once each.
   *
   * `geometry` here is the FIRST finder's measurement, kept for the readers
   * that answer "what is this place" without naming a leg (S4 checks, the
   * phase-2 trunk, the run snapshot). It is NOT what a leg drives: the same
   * corner is 57° out of a 3,0 m street on one leg and 98° out of a 5,2 m one
   * on another (Thairé). Anything judging a manoeuvre reads
   * `geometryByCandidate`.
   */
  readonly points: readonly CriticalPoint[];
  /** Which points lie on which candidate — S5's join. */
  readonly byCandidate: ReadonlyMap<string, readonly PointRef[]>;
  /**
   * The geometry each leg MEASURED at each place it carries — angle, kind,
   * radius, approach and exit widths, chaining — read off that leg's own
   * polyline and its own annotated segments.
   *
   * The identity is shared and the geometry is not, and both halves matter.
   * Sharing the identity is what lets one human answer cover every itinerary
   * through the corner (architecture §3.3) and outlive the run. Sharing the
   * GEOMETRY, which `points[]` alone forced, published one leg's manoeuvre as
   * every leg's: at Thairé the grey leg arrived first, so the blue leg's real
   * difficulty (98° into 5,2 m, 0,1 m short) was hidden behind the grey's 57°,
   * the grey carried a doubt that was not its own, and two verdicts moved on
   * nothing but the order of a list.
   *
   * Complete by construction: every ref in `byCandidate[id]` has an entry
   * here, stop-level points included.
   */
  readonly geometryByCandidate: ReadonlyMap<string, ReadonlyMap<PointRef, Fact<PointGeometry>>>;
}

export function collectCriticalPoints(
  input: CollectPointsInput,
  params: CollectPointsParams,
): CollectedPoints {
  const byRef = new Map<PointRef, CriticalPoint>();
  const byCandidate = new Map<string, PointRef[]>();
  const geometryByCandidate = new Map<string, Map<PointRef, Fact<PointGeometry>>>();
  // Every candidate gets an entry up front: the stop-level points
  // (DESTINATION, TURNAROUND) concern all of them, including a candidate
  // whose route detectors found nothing at all.
  for (const candidate of input.candidates) {
    byCandidate.set(candidate.id, []);
    geometryByCandidate.set(candidate.id, new Map());
  }
  const add = (candidateId: string, point: CriticalPoint): void => {
    // The IDENTITY is shared — first finder wins. The existing point within the
    // dedupe radius, same type, IS this point: one place, one reference, one
    // human answer for every itinerary through it (architecture §3.3).
    const ref = sharedPointRef(byRef.values(), point, params.dedupeWithinM);
    if (!byRef.has(ref)) byRef.set(ref, point);
    const refs = byCandidate.get(candidateId);
    if (refs !== undefined && !refs.includes(ref)) refs.push(ref);
    // The GEOMETRY is not shared: this leg keeps what this leg measured. Twice
    // on one leg is still first-wins — a leg drives a place once, and the
    // second detection is the same manoeuvre rounded differently.
    const geometries = geometryByCandidate.get(candidateId);
    if (geometries !== undefined && !geometries.has(ref)) geometries.set(ref, point.geometry);
  };

  for (const candidate of input.candidates) {
    const corridor = input.corridors.get(candidate.id) ?? [];
    for (const point of routePoints(candidate, corridor, params, input.fetchedAt)) {
      add(candidate.id, point);
    }
  }

  for (const point of stopPoints(input)) {
    byRef.set(point.ref, point);
    addToEveryCandidate(byCandidate, geometryByCandidate, point);
  }

  return { points: [...byRef.values()], byCandidate, geometryByCandidate };
}

/**
 * THE REF A LEG'S OWN POINT TAKES IN THE RELEVÉ — the first point already
 * collected of the same type within `dedupeWithinM`, in the order they were
 * collected, or its own ref.
 *
 * Sorti de `collectCriticalPoints` le 2026-09-28 : relire une
 * relation d'une jambe (quelle rue étroite est sur le bras de quel virage)
 * demande de retrouver le ref que S4 a donné à SA rue étroite, et la règle de
 * dédoublonnage n'existe qu'ici (principe 23). Rejouée sur `collected.points`
 * (ordre d'insertion), elle rend le même ref que pendant la collecte : un point
 * plus tardif ne peut pas précéder celui qu'il a rejoint.
 */
export function sharedPointRef(
  collected: Iterable<CriticalPoint>,
  point: { readonly ref: PointRef; readonly type: CriticalPoint['type']; readonly at: GeoPoint },
  dedupeWithinM: number,
): PointRef {
  for (const existing of collected) {
    if (existing.type === point.type && haversineM(existing.at, point.at) <= dedupeWithinM) {
      return existing.ref;
    }
  }
  return point.ref;
}

/**
 * The points the STOP carries, whatever route reaches it: the destination and,
 * on a dead end, the turnaround.
 *
 * Split out of `collectCriticalPoints` when gave every leg its own
 * geometry (principe 26: cut where the seam already is). The seam is the same
 * one `wire-ids.ts` names — these two are leg-INDEPENDENT, measured once at the
 * stop and not off anyone's polyline, which is why the judgement key drops the
 * leg for them and why they land identically on every candidate.
 */
function stopPoints(input: CollectPointsInput): readonly CriticalPoint[] {
  // The destination is a critical point like any other (the engine's unified
  // container decision, kept): its geometry is the stop's measured width.
  const destination: CriticalPoint = {
    ref: makePointRef('DESTINATION', input.stop.at),
    type: 'DESTINATION',
    at: input.stop.at,
    geometry: {
      known: true,
      value: {
        type: 'DESTINATION',
        width: input.stop.width,
        // les barrières de la rue de livraison suivent
        // l'arrêt : c'est par ce point, accroché à TOUTES les jambes, qu'une
        // rue fermée atteint un verdict. Recopiées, jamais mesurées ici ; une
        // absence reste une absence (principe 14).
        ...(input.stop.barriers === undefined ? {} : { barriers: input.stop.barriers }),
      },
      provenance: { source: 'ign-ortho', method: 'stop-constraints', fetchedAt: input.fetchedAt },
      reliability: {
        confidence: input.stop.width.known ? input.stop.width.reliability.confidence : 0,
        basis: 'derived',
        reasonCodes: [],
      },
    },
    evidence: [],
  };
  // A terminal stop's turnaround is a point too: the most frequent deciding
  // factor in the field corpus, previously unable to be shown, reviewed or
  // named as the reason a run failed.
  if (input.topology.kind === 'THROUGH') return [destination];

  const t = input.topology.turnaround;
  const at = t.known ? t.value.centre : (input.turnaroundAt ?? input.stop.at);
  return [
    destination,
    {
      ref: makePointRef('TURNAROUND', at),
      type: 'TURNAROUND',
      at,
      geometry: t.known
        ? {
            ...t,
            value: {
              type: 'TURNAROUND',
              geometry: {
                surface: {
                  usableDiameterM: t.value.usableDiameterM,
                  areaM2: null,
                  polygon: null,
                  occupancy: 'unassessed',
                },
                requiresReversingM: 0,
                beyondStop: false,
                distanceFromStopM: haversineM(input.stop.at, at),
                provenTopology: input.terminalNodeInterior ?? true,
              },
            },
          }
        : t,
      evidence: [],
    },
  ];
}

/**
 * A stop-level point belongs to every leg — identity AND geometry, since it was
 * measured at the stop and not off any leg's polyline.
 */
function addToEveryCandidate(
  byCandidate: ReadonlyMap<string, PointRef[]>,
  geometryByCandidate: ReadonlyMap<string, Map<PointRef, Fact<PointGeometry>>>,
  point: CriticalPoint,
): void {
  for (const [candidateId, refs] of byCandidate) {
    if (!refs.includes(point.ref)) refs.push(point.ref);
    geometryByCandidate.get(candidateId)?.set(point.ref, point.geometry);
  }
}
