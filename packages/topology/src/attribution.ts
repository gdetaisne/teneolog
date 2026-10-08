/**
 * Grafting an attribute one source knows onto the way another source drew.
 *
 * OSM draws the graph — it carries the street furniture, the names and the
 * access tags. What it almost never carries is a width. Measured around
 * Thairé (17290) on 2026-09-10, radius 900 m: **0 of 139** drivable OSM ways
 * declare one, and 4 declare a lane count. The BD TOPO describes the same
 * roads and declares a width on **252 of 298** stretches — the 46 silent ones
 * being 24 footpaths, 12 tracks and 10 gravel roads, none of which a 19-tonne
 * lorry drives on. Paris 11e says the same thing: 29 of 611 against 913 of
 * 1099.
 *
 * So the graph stays OSM and only the missing attribute is borrowed. This
 * module is the borrowing, and nothing else: pure, no I/O, metres and degrees.
 *
 * THE MATCH IS AXIS TO AXIS, NEVER POINT TO POINT. A point snap cannot tell
 * "the same street drawn two metres off" from "the perpendicular street that
 * crosses at zero metres". Sampling one way along its length, projecting each
 * sample onto the other's SEGMENTS, filtering on heading and then requiring a
 * majority of samples to agree is what separates them. It is also what makes
 * a two-vertex village street work: the axis passes 1 m away where the
 * nearest vertex is 60 m away, and only a projection sees that.
 *
 * AND THE JUDGEMENT STOPS WHERE THE DONOR WAS ASKED. The primary source hands
 * back whole ways as soon as one node touches the area — Overpass `around` —
 * while the donor is only asked inside it. Judged over its full length, a
 * 583 m tertiary road entering a 160 m neighbourhood by one end has 13 % of
 * its samples where a donor could possibly answer, and stays mute for a reason
 * that has nothing to do with the match. Thairé, 2026-09-10, 160 m: 27 of 56
 * ways mute, among them Rue Voisine 17 (11 % of its vertices inside), Rue
 * Voisine 49 (13 %) and Rue Voisine 24 (17 %), all described by the BD
 * TOPO. In a route corridor it is worse: the side street of every turn leaves
 * the margin by construction, and that is precisely the width the turn needs.
 */
import type { GeoPoint, SourceId } from '@teneolog/domain';

import { isDrivableWay } from './continuity.js';
import { bearingDeg, bearingDeltaDeg, haversineM } from './geometry.js';
import type { RoadWay } from './ports.js';

/**
 * Where a grafted attribute came from, and how well the two axes agreed.
 *
 * `offsetM` and `coverage` are kept so a bad match can be audited AFTER the
 * fact rather than argued about. was cut precisely because the engine
 * knew its own measurement was poor and nothing carried that doubt to the
 * screen; a graft must not repeat it.
 */
export interface GraftedAttribute {
  readonly source: SourceId;
  /** Id of the donor stretch the value was taken from. */
  readonly donorWayId: string;
  /** Median lateral gap between the two axes over the winning samples, metres. */
  readonly offsetM: number;
  /** Share of the primary way's samples in the donor's extent that any donor won, [0, 1]. */
  readonly coverage: number;
}

/** Per-attribute provenance for the values a way did not state itself. */
export interface WayAttribution {
  readonly declaredWidthM?: GraftedAttribute;
}

/**
 * Tolerances of the match. Every one of them is a policy number, not a
 * constant: `config/policy.example.json`, block `roadAttributes`.
 */
export interface GraftOptions {
  /** Step along the primary way, metres. */
  readonly sampleStepM: number;
  /** A sample farther than this from a donor segment cannot be its match. */
  readonly lateralToleranceM: number;
  /** Heading disagreement allowed, after folding into [0, 90]. */
  readonly bearingToleranceDeg: number;
  /** Below this share of matched samples, the graft does not happen at all. */
  readonly minCoverage: number;
}

/**
 * Where the donor was actually asked — a circle for a neighbourhood, a
 * corridor for a route. Samples of the primary way outside it are not counted
 * at all: they can neither vote nor dilute. Omitted, the whole way is judged.
 */
export type DonorExtent = (point: GeoPoint) => boolean;

/** The extent of a neighbourhood fetch: everything within `radiusM` of `centre`. */
export function circleExtent(centre: GeoPoint, radiusM: number): DonorExtent {
  return (point) => haversineM(centre, point) <= radiusM;
}

/**
 * The extent of a corridor fetch: everything within `marginM` of `polyline`.
 *
 * Indexed, because a route polyline can carry two thousand vertices and a
 * corridor thousands of ways: projecting every sample onto every segment would
 * cost more than the donor query it is meant to qualify.
 */
export function corridorExtent(polyline: readonly GeoPoint[], marginM: number): DonorExtent {
  if (polyline.length < 2) return () => false;
  const index = buildSegmentIndex([polyline], marginM);
  return (point) => {
    for (const ref of index.near(point)) {
      const a = polyline[ref.segment];
      const b = polyline[ref.segment + 1];
      if (a === undefined || b === undefined) continue;
      if (projectOnSegment(a, b, point).distanceM <= marginM) return true;
    }
    return false;
  };
}

/**
 * Below this many samples in view, a way is judged whole instead — as if no
 * extent were given. A stub of one or two samples cannot carry a majority: a
 * single sample sitting on a junction would decide alone. Judging the whole
 * way is what happened before the extent existed, and the donor's stretches
 * often run past the area anyway, so this never grafts less than before.
 */
const MIN_SAMPLES_IN_VIEW = 3;

/**
 * Fill `declaredWidthM` on the primary ways that do not state one, from the
 * donor ways that do.
 *
 * Four rules, each of which exists because of a way it could go wrong:
 *
 * 1. **A way that states its own width is never touched.** The primary source
 *    is the graph; borrowing is for silence, not for arbitration. Overriding
 *    a stated value is a different decision, and it is not this one.
 * 2. **Among the donors that won samples, the NARROWEST width wins.** A donor
 *    network is cut at every junction and every attribute change, so one OSM
 *    street routinely matches two to five stretches. Taking the narrowest is
 *    the same rule the domain already applies to a declared ring width
 *    (`roundabouts.ts`) and to a merged legal limit — and it is the only
 *    direction that is safe for a lorry.
 * 3. **A doubtful match is silence, not a weak value.** Below `minCoverage`
 *    nothing is grafted and no reason code is emitted. A width that is
 *    probably the next street along is worse than no width, because the rest
 *    of the engine has no way to argue with it.
 * 4. **Only the part of a way inside `extent` is judged.** Coverage is a share
 *    of the samples the donor could have answered, not of the whole way; a
 *    street the primary returned whole is not penalised for leaving the area.
 *    A way with fewer than three samples in view is judged whole, as before.
 *
 * Returns the same array when nothing was grafted, and the same way objects
 * for every way left untouched — callers may compare by identity.
 */
export function graftDeclaredWidth(
  primary: readonly RoadWay[],
  donors: readonly RoadWay[],
  options: GraftOptions,
  extent?: DonorExtent,
): readonly RoadWay[] {
  const usable = donors.filter((d) => d.declaredWidthM !== null && d.geometry.length >= 2);
  if (usable.length === 0) return primary;

  const index = buildSegmentIndex(usable.map((d) => d.geometry), options.lateralToleranceM);
  let grafted = 0;

  const out = primary.map((way) => {
    if (way.declaredWidthM !== null) return way;
    if (!isDrivableWay(way)) return way;
    const match = matchAxis(way, usable, index, options, extent);
    if (match === null) return way;
    grafted += 1;
    return {
      ...way,
      declaredWidthM: match.widthM,
      attributed: {
        ...way.attributed,
        declaredWidthM: {
          source: match.donor.source,
          donorWayId: match.donor.id,
          offsetM: match.offsetM,
          coverage: match.coverage,
        },
      },
    };
  });

  return grafted === 0 ? primary : out;
}

interface Match {
  readonly donor: RoadWay;
  readonly widthM: number;
  readonly offsetM: number;
  readonly coverage: number;
}

/**
 * One sample, one vote, cast for the nearest donor segment that also agrees on
 * heading. Votes are not weighted by distance: weighting would let a single
 * sample sitting on top of a junction outvote ten aligned ones.
 */
function matchAxis(
  way: RoadWay,
  donors: readonly RoadWay[],
  index: SegmentIndex,
  options: GraftOptions,
  extent: DonorExtent | undefined,
): Match | null {
  const along = sampleAlong(way.geometry, options.sampleStepM);
  if (along.length === 0) return null;
  const inView = extent === undefined ? along : along.filter((s) => extent(s.point));
  const samples = inView.length >= Math.min(MIN_SAMPLES_IN_VIEW, along.length) ? inView : along;

  const offsetsByDonor = new Map<number, number[]>();
  let won = 0;

  for (const sample of samples) {
    let bestD = options.lateralToleranceM;
    let bestDonor: number | null = null;
    for (const ref of index.near(sample.point)) {
      const donor = donors[ref.donor];
      if (donor === undefined) continue;
      const a = donor.geometry[ref.segment];
      const b = donor.geometry[ref.segment + 1];
      if (a === undefined || b === undefined) continue;
      const projected = projectOnSegment(a, b, sample.point);
      if (projected.distanceM >= bestD) continue;
      // Two sources digitise the same street in opposite directions about half
      // the time, which is why the BD TOPO has a "Sens inverse" value at all.
      // Folding into [0, 90] compares axes, not directions of travel.
      const folded = foldTo90(bearingDeltaDeg(sample.bearingDeg, bearingDeg(a, b)));
      if (folded > options.bearingToleranceDeg) continue;
      bestD = projected.distanceM;
      bestDonor = ref.donor;
    }
    if (bestDonor === null) continue;
    won += 1;
    const seen = offsetsByDonor.get(bestDonor);
    if (seen === undefined) offsetsByDonor.set(bestDonor, [bestD]);
    else seen.push(bestD);
  }

  const coverage = won / samples.length;
  if (coverage < options.minCoverage) return null;

  let best: Match | null = null;
  for (const [donorIndex, offsets] of offsetsByDonor) {
    const donor = donors[donorIndex];
    const widthM = donor?.declaredWidthM;
    if (donor === undefined || widthM === undefined || widthM === null) continue;
    if (best === null || widthM < best.widthM) {
      best = { donor, widthM, offsetM: median(offsets), coverage };
    }
  }
  return best;
}

interface Sample {
  readonly point: GeoPoint;
  /** Heading of the segment carrying the sample. */
  readonly bearingDeg: number;
}

/** Points every `stepM` along a polyline, plus its last vertex. */
function sampleAlong(polyline: readonly GeoPoint[], stepM: number): readonly Sample[] {
  const out: Sample[] = [];
  let travelled = 0;
  let nextAt = 0;
  for (let i = 0; i < polyline.length - 1; i += 1) {
    const a = polyline[i];
    const b = polyline[i + 1];
    if (a === undefined || b === undefined) continue;
    const legM = haversineM(a, b);
    if (legM === 0) continue;
    const heading = bearingDeg(a, b);
    while (nextAt <= travelled + legM) {
      const t = (nextAt - travelled) / legM;
      out.push({
        point: { lat: a.lat + t * (b.lat - a.lat), lon: a.lon + t * (b.lon - a.lon) },
        bearingDeg: heading,
      });
      nextAt += stepM;
    }
    travelled += legM;
  }
  const lastA = polyline[polyline.length - 2];
  const lastB = polyline[polyline.length - 1];
  if (lastA !== undefined && lastB !== undefined && haversineM(lastA, lastB) > 0) {
    out.push({ point: lastB, bearingDeg: bearingDeg(lastA, lastB) });
  }
  return out;
}

/** Folds a [0, 180] heading difference into [0, 90]: an axis has no sense. */
function foldTo90(deltaDeg: number): number {
  return deltaDeg > 90 ? 180 - deltaDeg : deltaDeg;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length === 0) return 0;
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/** Distance from `p` to the segment `a`–`b`, local equirectangular projection. */
function projectOnSegment(a: GeoPoint, b: GeoPoint, p: GeoPoint): { distanceM: number } {
  const scale = Math.cos((p.lat * Math.PI) / 180);
  const ax = a.lon * scale;
  const ay = a.lat;
  const dx = b.lon * scale - ax;
  const dy = b.lat - ay;
  const lenSq = dx * dx + dy * dy;
  const t =
    lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((p.lon * scale - ax) * dx + (p.lat - ay) * dy) / lenSq));
  return { distanceM: haversineM({ lat: a.lat + t * dy, lon: a.lon + t * (b.lon - a.lon) }, p) };
}

interface SegmentRef {
  /** Index of the polyline in the list the index was built from. */
  readonly donor: number;
  readonly segment: number;
}

/**
 * A grid over donor SEGMENTS, not donor vertices.
 *
 * Indexing vertices is the trap: a straight stretch drawn with two vertices
 * 120 m apart would be invisible to every sample in between, which is exactly
 * the shape of a village street. Each segment is therefore registered in every
 * cell its bounding box touches, already grown by the lateral tolerance, so a
 * sample only has to look in its own cell and its eight neighbours.
 */
interface SegmentIndex {
  near(point: GeoPoint): readonly SegmentRef[];
}

const M_PER_DEG_LAT = 111_320;

function buildSegmentIndex(
  polylines: readonly (readonly GeoPoint[])[],
  toleranceM: number,
): SegmentIndex {
  const cellM = Math.max(20, toleranceM * 2);
  const anchorLat = polylines[0]?.[0]?.lat ?? 0;
  const lonScale = Math.max(0.05, Math.cos((anchorLat * Math.PI) / 180));
  const latStep = cellM / M_PER_DEG_LAT;
  const lonStep = cellM / (M_PER_DEG_LAT * lonScale);
  const grid = new Map<string, SegmentRef[]>();

  const key = (row: number, col: number): string => `${row}:${col}`;
  const rowOf = (lat: number): number => Math.floor(lat / latStep);
  const colOf = (lon: number): number => Math.floor(lon / lonStep);

  polylines.forEach((polyline, donorIndex) => {
    for (let s = 0; s < polyline.length - 1; s += 1) {
      const a = polyline[s];
      const b = polyline[s + 1];
      if (a === undefined || b === undefined) continue;
      const padLat = toleranceM / M_PER_DEG_LAT;
      const padLon = toleranceM / (M_PER_DEG_LAT * lonScale);
      const r0 = rowOf(Math.min(a.lat, b.lat) - padLat);
      const r1 = rowOf(Math.max(a.lat, b.lat) + padLat);
      const c0 = colOf(Math.min(a.lon, b.lon) - padLon);
      const c1 = colOf(Math.max(a.lon, b.lon) + padLon);
      for (let r = r0; r <= r1; r += 1) {
        for (let c = c0; c <= c1; c += 1) {
          const cell = grid.get(key(r, c));
          if (cell === undefined) grid.set(key(r, c), [{ donor: donorIndex, segment: s }]);
          else cell.push({ donor: donorIndex, segment: s });
        }
      }
    }
  });

  return {
    near(point: GeoPoint): readonly SegmentRef[] {
      const row = rowOf(point.lat);
      const col = colOf(point.lon);
      const out: SegmentRef[] = [];
      for (let r = row - 1; r <= row + 1; r += 1) {
        for (let c = col - 1; c <= col + 1; c += 1) {
          const cell = grid.get(key(r, c));
          if (cell !== undefined) out.push(...cell);
        }
      }
      return out;
    },
  };
}
