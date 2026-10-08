/**
 * S4 — the points ONE candidate's route carries: roundabouts, manoeuvres,
 * narrow runs.
 *
 * Split out of `collect.ts` when touched it (principe 26: a file one
 * works in gets cut where the seam already is). The seam is real — everything
 * here reads a single candidate and knows nothing of the stop, of the other
 * candidates, or of how points dedupe across them.
 */
import type {
  CriticalPoint,
  Fact,
  GeoPoint,
  NarrowGeometry,
  RouteCandidate,
  TurnGeometry,
  Width,
} from '@teneolog/domain';
import { haversineM, type RoadWay } from '@teneolog/topology';

import { makePointRef } from './point-ref.js';
import { detectRoundabouts, type RoundaboutDetectionParams } from './roundabouts.js';
import { detectTurns, type TurnDetectionParams } from './turns.js';

export interface RoutePointsParams {
  readonly turns: TurnDetectionParams;
  readonly roundabouts: RoundaboutDetectionParams;
  readonly narrowMaxFreeM: number;
  readonly chainedWithinM: number;
}

/** Points along one candidate, in the order the route meets them. */
export function routePoints(
  candidate: RouteCandidate,
  corridor: readonly RoadWay[],
  params: RoutePointsParams,
  fetchedAt: string,
): readonly CriticalPoint[] {
  const roundabouts = detectRoundabouts(candidate.polyline, corridor, params.roundabouts, fetchedAt);
  const out: CriticalPoint[] = roundabouts.map((rb) => ({
    ref: makePointRef('ROUNDABOUT', rb.at),
    type: 'ROUNDABOUT',
    at: rb.at,
    geometry: rb.geometry.known
      ? { ...rb.geometry, value: { type: 'ROUNDABOUT', geometry: rb.geometry.value } }
      : rb.geometry,
    evidence: [],
  }));

  // The ring's own curvature reads as a string of turns. A manoeuvre inside a
  // detected roundabout IS the roundabout, so it is suppressed — the reviewer
  // must see one giratoire, not a giratoire plus three "virages serrés" on its
  // ring. This is the ONLY relation between the two types since 
  // nothing promotes turns INTO a roundabout any more.
  const turns = detectTurns(candidate.polyline, corridor, params.turns, fetchedAt).filter(
    (turn) => !roundabouts.some((rb) => haversineM(rb.at, turn.at) <= rb.suppressWithinM),
  );

  // The annotated runs as index ranges on THIS leg's line — built once, so the
  // exit arm below is read along the road driven and not as the crow flies.
  const spans = segmentSpans(candidate);
  let previousJunctionM: number | null = null;
  for (const turn of turns) {
    // R-S: how far back the previous junction turn of THIS leg was, when close
    // enough that the lorry never straightens up between the two.
    const chained =
      turn.kind === 'junction' && previousJunctionM !== null
        ? turn.alongM - previousJunctionM
        : null;
    const chainedWithPreviousM = chained !== null && chained < params.chainedWithinM ? chained : null;
    if (turn.kind === 'junction') previousJunctionM = turn.alongM;
    // The detector works on the routed polyline alone and cannot know how wide
    // the road is; the annotated segments can. Joining them here is what makes
    // the swept-width rule reachable at all — without it every manoeuvre
    // escalated to a human for want of a width, on boulevards included.
    out.push({
      ref: makePointRef('TURN', turn.at),
      type: 'TURN',
      at: turn.at,
      geometry: turn.geometry.known
        ? {
            ...turn.geometry,
            value: {
              type: 'TURN',
              geometry: {
                ...turn.geometry.value,
                chainedWithPreviousM,
                approachWidth: widthAtPoint(candidate, turn.at),
                exitWidth: exitArmWidth(candidate, spans, turn, params.turns.bearingOffsetM),
              },
            },
          }
        : turn.geometry,
      evidence: [],
    });
  }

  out.push(...narrowRuns(candidate, params.narrowMaxFreeM));
  return out;
}

/**
 * Width of the annotated segment nearest a point on the candidate — the
 * carriageway the manoeuvre HAPPENS on, and the one S5 judges it by.
 *
 * Deliberately left as it was. The engine's June rule R-T judges a
 * junction turn on its EXIT street ("the truck commits onto it, rear off-tracks
 * inward", la note de conception interne) with the entry as a
 * modifier, and `evaluators.ts` reads `approachWidth`; moving this lookup to
 * the true approach arm was measured on Thairé and puts the van and the semi
 * back to HUMAN on `TURN@46.0704,-0.9723`. That is a rule change, it belongs to
 * the R-T port with its own A/B (principe 17), not to this one.
 */
function widthAtPoint(candidate: RouteCandidate, at: GeoPoint): Fact<Width> {
  const index = nearestSegmentIndex(candidate, at);
  return (index === null ? undefined : candidate.segments[index])?.width ?? NO_WIDTH;
}

const NO_WIDTH: Fact<Width> = { known: false, why: 'no_data' };

/**
 * L'INDEX du segment que `widthAtPoint` lit — sorti le 2026-09-28 (
 * principe 41) pour que « la rue que le virage nomme » se lise au même endroit
 * que sa largeur, et nulle part ailleurs (principe 23).
 */
export function nearestSegmentIndex(candidate: RouteCandidate, at: GeoPoint): number | null {
  let best: number | null = null;
  let bestDistanceM = Number.POSITIVE_INFINITY;
  candidate.segments.forEach((segment, index) => {
    const distanceM = Math.min(haversineM(segment.from, at), haversineM(segment.to, at));
    if (distanceM < bestDistanceM) {
      bestDistanceM = distanceM;
      best = index;
    }
  });
  return best;
}

/**
 * An annotated segment placed on the leg's polyline: the stretch it covers.
 *
 * Ce bloc — `segmentSpans`, `exitArmWidth`, `nearestIndex`, `walkFrom`,
 * `widthAtIndex` — est exporté pour `test/exit-arm.test.ts` et pour lui seul :
 * l'index.ts du paquet ne le rouvre pas. C'est quatre fonctions de quelques
 * lignes qui décident à quel endroit de la route une largeur est lue, et
 * `routePoints` ne les traverse que par un cas à la fois ; les vérifier aux
 * bornes (index hors ligne, plage vide, marche plus longue que la polyligne)
 * demande de les appeler.
 */
export interface SegmentSpan {
  readonly from: number;
  readonly to: number;
  readonly width: Fact<Width>;
}

/**
 * The annotated segments as index ranges on the candidate's own polyline.
 *
 * `from` and `to` are positions ON that line (S3 snapped them there), so the
 * range is exact — which the old "nearest segment endpoint" rule was not: on a
 * 275 m run it answered with whichever run END happened to be closest, and the
 * docstring's promise ("the one whose from–to span the point") was never kept.
 * The runs do not tile the line — consecutive ones leave the sampling step
 * between them, ~25 % of the length on this corpus — so a lookup must fall back
 * to the nearest range rather than assume it lands inside one.
 */
export function segmentSpans(candidate: RouteCandidate): readonly SegmentSpan[] {
  return candidate.segments.map((segment) => ({
    from: nearestIndex(candidate.polyline, segment.from),
    to: nearestIndex(candidate.polyline, segment.to),
    width: segment.width,
  }));
}

/**
 * THE STREET THE MANOEUVRE LEAVES ONTO, read `bearingOffsetM` past the end of
 * the manoeuvre — where the detector read the exit bearing that defines its
 * angle.
 *
 * Until `exitWidth` was a copy of `approachWidth`: a turn out of a 3 m
 * lane into a 5,2 m street published 3 m twice, and the scene
 * (`packages/scenes/src/scene.ts`, `outgoingWidthM`) drew both arms of one
 * width whatever the junction. Nothing JUDGES this field today, which is why
 * making it true costs no verdict — and it is the field the engine's rule R-T
 * decides on, so the port has its measurement waiting.
 */
export function exitArmWidth(
  candidate: RouteCandidate,
  spans: readonly SegmentSpan[],
  turn: { readonly at: GeoPoint; readonly geometry: Fact<TurnGeometry> },
  bearingOffsetM: number,
): Fact<Width> {
  const arcLengthM = turn.geometry.known ? turn.geometry.value.arcLengthM : 0;
  const index = armSpanIndex(candidate.polyline, spans, { at: turn.at, arcLengthM }, bearingOffsetM, 1);
  return (index === null ? undefined : spans[index])?.width ?? NO_WIDTH;
}

/**
 * L'INDEX de la plage lue sur un BRAS du virage : `step = 1`, la rue de sortie
 * — celle dont `exitArmWidth` rend la largeur ; `step = -1`, la rue d'entrée,
 * lue à la même distance EN AMONT, là où le détecteur lit le cap d'entrée
 * (`turns.ts`, ±`bearingOffsetM` autour de la manœuvre).
 *
 * Sorti le 2026-09-28 (principe 41 : « valider un virage valide la
 * largeur des rues qui y entrent et qui en sortent ») : la couverture d'une rue
 * étroite par un virage se lit sur CES plages, pas sur une seconde règle.
 */
export function armSpanIndex(
  line: readonly GeoPoint[],
  spans: readonly SegmentSpan[],
  turn: { readonly at: GeoPoint; readonly arcLengthM: number },
  bearingOffsetM: number,
  step: -1 | 1,
): number | null {
  const apex = nearestIndex(line, turn.at);
  return spanIndexAt(spans, walkFrom(line, apex, turn.arcLengthM / 2 + bearingOffsetM, step));
}

/** The vertex of the leg's line closest to a point. */
export function nearestIndex(line: readonly GeoPoint[], at: GeoPoint): number {
  let best = 0;
  let bestDistanceM = Number.POSITIVE_INFINITY;
  for (let i = 0; i < line.length; i += 1) {
    const distanceM = haversineM(line[i] as GeoPoint, at);
    if (distanceM < bestDistanceM) {
      bestDistanceM = distanceM;
      best = i;
    }
  }
  return best;
}

/** The vertex reached by walking `distanceM` along the line, or its end. */
export function walkFrom(
  line: readonly GeoPoint[],
  index: number,
  distanceM: number,
  step: -1 | 1,
): number {
  let walked = 0;
  let i = index;
  while (walked < distanceM) {
    const next = i + step;
    const here = line[i];
    const there = line[next];
    if (here === undefined || there === undefined) return i;
    walked += haversineM(here, there);
    i = next;
  }
  return i;
}

/** The width of the run covering an index, or of the nearest one to it. */
export function widthAtIndex(spans: readonly SegmentSpan[], index: number): Fact<Width> {
  const at = spanIndexAt(spans, index);
  return (at === null ? undefined : spans[at])?.width ?? NO_WIDTH;
}

/** The run covering an index, or the nearest one to it — its position in `spans`. */
function spanIndexAt(spans: readonly SegmentSpan[], index: number): number | null {
  let best: number | null = null;
  let bestGap = Number.POSITIVE_INFINITY;
  for (let i = 0; i < spans.length; i += 1) {
    const span = spans[i] as SegmentSpan;
    const low = Math.min(span.from, span.to);
    const high = Math.max(span.from, span.to);
    const gap = index < low ? low - index : index > high ? index - high : 0;
    if (gap < bestGap) {
      bestGap = gap;
      best = i;
    }
    if (bestGap === 0) break;
  }
  return best;
}

/**
 * A run of consecutive annotated segments narrower than the threshold: where
 * its NARROW point stands, and WHICH segments of the leg it spans.
 *
 * Sorti de `narrowRuns` le 2026-09-28 : la couverture d'une rue
 * étroite par un virage validé — ou par la réponse à la première question de
 * l'adresse — doit savoir quels segments la question couvre, et ce découpage
 * ne peut exister qu'une fois (principe 23).
 */
export interface NarrowRun {
  readonly at: GeoPoint;
  /** Indices into `candidate.segments`, in the order the leg drives them. */
  readonly segmentIndices: readonly number[];
  readonly lengthM: number;
  readonly narrowest: Fact<Width>;
}

interface OpenRun {
  at: GeoPoint;
  segmentIndices: number[];
  lengthM: number;
  narrowest: Fact<Width>;
}

/** Consecutive annotated segments narrower than the threshold, fused. */
export function narrowRunsOf(candidate: RouteCandidate, narrowMaxFreeM: number): readonly NarrowRun[] {
  const out: NarrowRun[] = [];
  let run: OpenRun | null = null;
  candidate.segments.forEach((segment, index) => {
    const narrow = segment.width.known && segment.width.value.freeM < narrowMaxFreeM;
    if (!narrow) {
      if (run !== null) out.push(run);
      run = null;
    } else if (run === null) {
      run = { at: segment.from, segmentIndices: [index], lengthM: haversineM(segment.from, segment.to), narrowest: segment.width };
    } else {
      extendRun(run, segment, index);
    }
  });
  if (run !== null) out.push(run);
  return out;
}

function extendRun(run: OpenRun, segment: RouteCandidate['segments'][number], index: number): void {
  run.segmentIndices.push(index);
  run.lengthM += haversineM(segment.from, segment.to);
  if (
    segment.width.known &&
    (!run.narrowest.known || segment.width.value.freeM < run.narrowest.value.freeM)
  ) {
    run.narrowest = segment.width;
  }
}

function narrowRuns(candidate: RouteCandidate, narrowMaxFreeM: number): readonly CriticalPoint[] {
  return narrowRunsOf(candidate, narrowMaxFreeM).map((run) => {
    const geometry: NarrowGeometry = {
      width: run.narrowest,
      lengthM: run.lengthM,
      constriction: null,
    };
    return {
      ref: makePointRef('NARROW', run.at),
      type: 'NARROW',
      at: run.at,
      geometry: {
        known: true,
        value: { type: 'NARROW', geometry },
        provenance:
          run.narrowest.known
            ? run.narrowest.provenance
            : { source: 'osm-overpass', method: 'narrow-run', fetchedAt: '' },
        reliability: run.narrowest.known
          ? run.narrowest.reliability
          : { confidence: 0, basis: 'derived', reasonCodes: [] },
      },
      evidence: [],
    };
  });
}
