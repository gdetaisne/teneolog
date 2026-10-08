/**
 * S3 — the agnostic legal annotation of one routed polyline.
 *
 * The routed geometry is sampled, each sample snapped to the nearest corridor
 * way, consecutive samples on the same way fused into one segment, and every
 * segment stamped with its POSITION in the journey and its merged legal
 * bands. Position is what makes E1 expressible: `access=destination` is
 * lawful on the terminal approach and unlawful as transit, and the tag alone
 * cannot say which — the position can.
 *
 * Truck-agnostic by construction: segments carry bands, never verdicts. The
 * per-truck comparison is S5's pure job, which is what keeps the largest-
 * truck question linear.
 */
import { mergeLegalBands } from '@teneolog/constraints';
import type {
  GeoPoint,
  RouteSegmentConstraint,
  SegmentPosition,
  UnreadStretch,
} from '@teneolog/domain';
import { closestPointOnPolyline, haversineM, isDrivableWay, type RoadWay } from '@teneolog/topology';

export interface AnnotateInput {
  readonly polyline: readonly GeoPoint[];
  readonly corridor: readonly RoadWay[];
  /** Sampling step along the route. */
  readonly sampleStepM: number;
  /** A sample farther than this from every corridor way is unmatched. */
  readonly snapM: number;
  /** The stretch nearest the destination that counts as terminal approach. */
  readonly approachWindowM: number;
  /**
   * Carriageway width credited per marked lane where no width is declared.
   *
   * Declared widths are almost absent in town — under 1% of drivable ways in a
   * dense French city carry one — while lane counts are an order of magnitude
   * more common. A deliberately low value per lane keeps the estimate on the
   * cautious side of the truth.
   */
  readonly laneWidthM: number;
  readonly direction: 'in' | 'out';
  readonly fetchedAt: string;
}

/**
 * Result of annotating one routed polyline against its corridor.
 * The `coverage` field counts matched vs. total sampled points so callers can
 * detect a half-mute corridor without inspecting each segment individually.
 */
export interface AnnotateResult {
  readonly segments: readonly RouteSegmentConstraint[];
  /** How many route-sample points fell within snapM of a drivable way out of total sampled. */
  readonly coverage: { readonly sampled: number; readonly matched: number };
  /**
   * LES TRONÇONS NON LUS, dans l'ordre du
   * parcours.
   *
   * `coverage` disait COMBIEN d'échantillons manquaient ; elle ne disait pas
   * OÙ. Un doute de corridor n'avait donc pas de lieu, donc pas de question
   * possible pour l'opérateur — il restait un HUMAIN que rien ne pouvait lever.
   * Vide quand tout a été lu.
   */
  readonly unread: readonly UnreadStretch[];
}

/** Une suite d'échantillons consécutifs tombés sur la MÊME voie. */
interface Run {
  way: RoadWay;
  from: GeoPoint;
  to: GeoPoint;
  fromAlongM: number;
  toAlongM: number;
}

/**
 * Les voies appariées, UNE par échantillon et en une seule passe.
 *
 * Sortie de `annotateRoute` pour que les tronçons LUS et les tronçons
 * NON LUS se dérivent de la même liste : deux parcours, ce seraient deux
 * vérités sur la même route — et `nearestDrivableWay` balaye tout le corridor,
 * donc on ne le paie pas deux fois.
 */
function matchSamples(
  input: AnnotateInput,
  samples: readonly Sample[],
): readonly (RoadWay | null)[] {
  return samples.map((sample) => nearestDrivableWay(sample.point, input.corridor, input.snapM));
}

function runsOf(samples: readonly Sample[], matches: readonly (RoadWay | null)[]): readonly Run[] {
  const runs: Run[] = [];
  samples.forEach((sample, i) => {
    const way = matches[i] ?? null;
    if (way === null) return; // unmatched stretch: no way to annotate against
    const last = runs[runs.length - 1];
    if (last !== undefined && last.way.id === way.id) {
      last.to = sample.point;
      last.toAlongM = sample.alongM;
    } else {
      runs.push({ way, from: sample.point, to: sample.point, fromAlongM: sample.alongM, toAlongM: sample.alongM });
    }
  });
  return runs;
}

/**
 * les suites d'échantillons qu'aucune voie roulable n'a réclamées.
 *
 * Une sentinelle au-delà du dernier échantillon (`i === samples.length`) ferme
 * le tronçon en cours : sans elle, un trou qui finit la jambe se perdrait — et
 * c'est le cas le plus fréquent, la tuile manquante étant souvent celle du
 * bout.
 */
function unreadStretchesOf(
  samples: readonly Sample[],
  matches: readonly (RoadWay | null)[],
): readonly UnreadStretch[] {
  const out: UnreadStretch[] = [];
  let start: number | null = null;
  for (let i = 0; i <= samples.length; i += 1) {
    if (i < samples.length && (matches[i] ?? null) === null) {
      if (start === null) start = i;
      continue;
    }
    if (start === null) continue;
    out.push(stretchOf(samples, matches, start, i - 1));
    start = null;
  }
  return out;
}

/**
 * `at` est l'échantillon du MILIEU, jamais la moyenne des deux bouts : sur une
 * courbe, le milieu de la corde tombe à côté de la route, et c'est ce point-là
 * que la carte de la question montre.
 */
function stretchOf(
  samples: readonly Sample[],
  matches: readonly (RoadWay | null)[],
  first: number,
  last: number,
): UnreadStretch {
  const from = samples[first] as Sample;
  const to = samples[last] as Sample;
  const middle = samples[first + Math.floor((last - first) / 2)] as Sample;
  return {
    from: from.point,
    to: to.point,
    at: middle.point,
    fromAlongM: from.alongM,
    toAlongM: to.alongM,
    afterSegmentId: matches[first - 1]?.id ?? null,
    beforeSegmentId: matches[last + 1]?.id ?? null,
  };
}

export function annotateRoute(input: AnnotateInput): AnnotateResult {
  const samples = samplePolyline(input.polyline, input.sampleStepM);
  const totalM = samples.length === 0 ? 0 : (samples[samples.length - 1]?.alongM ?? 0);

  const matches = matchSamples(input, samples);
  const runs = runsOf(samples, matches);
  const matched = matches.reduce<number>((count, way) => (way === null ? count : count + 1), 0);

  const segments: readonly RouteSegmentConstraint[] = runs.map((run) => ({
    segmentId: run.way.id,
    from: run.from,
    to: run.to,
    position: positionOf(run, totalM, input),
    // The class of road and how far the route stays on it. Both are read off
    // what the run already knows — no second pass, no second snap — and neither
    // is a verdict: S5 compares them, S3 only records them.
    highway: run.way.tags['highway'] ?? null,
    lengthM: run.toAlongM - run.fromAlongM,
    legal: mergeLegalBands({ descriptions: [run.way], fetchedAt: input.fetchedAt }),
    // The along-route width joins when the corridor scan gains D10 sampling;
    // until then the declared attribute leads and the lane count stands in.
    width: wayWidthFact(run.way, run.from, input.laneWidthM, input.fetchedAt),
  }));

  return {
    segments,
    coverage: { sampled: samples.length, matched },
    unread: unreadStretchesOf(samples, matches),
  };
}

/**
 * Width of a route segment, from the best attribute the road carries.
 *
 * Exported so the anchor by width reads a road's width with the
 * SAME ladder the corridor annotation uses — declared first, lane count
 * second, silence third. Two ladders would be two widths for one road.
 *
 * A declared width is used as given. Failing that, the marked lane count is a
 * usable floor: it is far more widely tagged than width, and `lanes × a
 * conservative metre-per-lane` understates a real carriageway far more often
 * than it overstates one. Neither is `measured`, which is what lets downstream
 * rules accept them to clear a manoeuvre while refusing to condemn one on them.
 */
export function wayWidthFact(
  way: RoadWay,
  at: GeoPoint,
  laneWidthM: number,
  fetchedAt: string,
): RouteSegmentConstraint['width'] {
  // A grafted width keeps the source that actually stated it. The way itself
  // stays OSM — it is still OSM that drew the road — but the number is the
  // BD TOPO's, and the proof has to say so.
  const grafted = way.attributed?.declaredWidthM;

  const widthOf = (
    metres: number,
    method: string,
    basis: 'declared' | 'derived',
    reasonCodes: readonly string[],
    source = way.source,
  ): RouteSegmentConstraint['width'] => ({
    known: true,
    value: { freeM: metres, structuralM: metres, measuredAt: at, offsetFromAnchorM: 0 },
    provenance: { source, method, fetchedAt },
    reliability: { confidence: 0.55, basis, reasonCodes: [...reasonCodes] },
  });

  if (way.declaredWidthM !== null) {
    return widthOf(
      way.declaredWidthM,
      'declared-width',
      'declared',
      grafted === undefined ? ['declared_width'] : ['declared_width', 'declared_width_grafted'],
      grafted?.source ?? way.source,
    );
  }
  if (way.laneCount !== null && way.laneCount > 0) {
    return widthOf(way.laneCount * laneWidthM, 'lane-count-width', 'derived', ['width_from_lane_count']);
  }
  return { known: false, why: 'no_data' };
}

/**
 * Which part of the journey a run belongs to. On an inbound leg the terminal
 * approach is the LAST `approachWindowM`; on an outbound leg it is the FIRST
 * (the initial egress enjoys the same local-service right).
 *
 * Judged on the run's FAR end: the whole run must fit inside the window. A
 * 500 m stretch whose last 50 m happen to touch the window is not the
 * terminal approach — grading it by its near end would launder a transit
 * shortcut into local service, the exact abuse E1 exists to name.
 */
function positionOf(
  run: { fromAlongM: number; toAlongM: number },
  totalM: number,
  input: Pick<AnnotateInput, 'approachWindowM' | 'direction'>,
): SegmentPosition {
  const farEndFromDestinationM = input.direction === 'in' ? totalM - run.fromAlongM : run.toAlongM;
  if (farEndFromDestinationM <= input.approachWindowM) {
    return input.direction === 'in' ? 'approach' : 'egress';
  }
  return 'transit';
}

/** One sample of a routed line, with how far along it stands. */
export interface Sample {
  readonly point: GeoPoint;
  readonly alongM: number;
}

export function samplePolyline(polyline: readonly GeoPoint[], stepM: number): readonly Sample[] {
  const out: Sample[] = [];
  let travelled = 0;
  let nextAt = 0;
  for (let i = 0; i < polyline.length - 1; i += 1) {
    const a = polyline[i];
    const b = polyline[i + 1];
    if (a === undefined || b === undefined) continue;
    const legM = haversineM(a, b);
    if (legM === 0) continue;
    while (nextAt <= travelled + legM) {
      const t = (nextAt - travelled) / legM;
      out.push({
        point: { lat: a.lat + t * (b.lat - a.lat), lon: a.lon + t * (b.lon - a.lon) },
        alongM: nextAt,
      });
      nextAt += stepM;
    }
    travelled += legM;
  }
  const last = polyline[polyline.length - 1];
  if (last !== undefined) out.push({ point: last, alongM: travelled });
  return out;
}

/**
 * Nearest DRIVABLE corridor way.
 *
 * The corridor query is unfiltered, and in a dense city three quarters of what
 * comes back is footway, cycleway or steps — often closer to the routed axis
 * than the carriageway itself. Snapping to those took a lorry's legal bands,
 * and now its width, off a pavement.
 */
export function nearestDrivableWay(
  point: GeoPoint,
  corridor: readonly RoadWay[],
  snapM: number,
): RoadWay | null {
  let best: RoadWay | null = null;
  let bestD = snapM;
  for (const way of corridor) {
    if (!isDrivableWay(way)) continue;
    const closest = closestPointOnPolyline(way.geometry, point);
    if (closest !== null && closest.distanceM < bestD) {
      bestD = closest.distanceM;
      best = way;
    }
  }
  return best;
}
