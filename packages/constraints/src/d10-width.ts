/**
 * S2 — the D10 measured width, projected into the domain's `Width` fact.
 *
 * The frozen core does the measuring; this module does two things only:
 * anchor the window on the STOP (the engine's window search optimised for a
 * clean stretch and landed 44 m from the door on a corpus case — here the
 * caller passes the stop projected onto the axis as the stitch anchor, and
 * the residual offset is reported, never hidden), and translate the core's
 * result into a fact that carries its own reliability.
 *
 * Boundary note: the frozen core speaks `{lat, lng}`; the domain bans `lng`.
 * The conversion lives here, at the seam, and nowhere else.
 */
import type { Fact, GeoPoint, Width } from '@teneolog/domain';
import { haversineM } from '@teneolog/topology';
import {
  measureStitchedRoadWidthWithoutYolo,
  type RgbImageData,
  type TileGeoContext,
} from '@teneolog/road-width';

export interface D10StopWidthInput {
  readonly stitched: RgbImageData;
  readonly frame: Pick<TileGeoContext, 'latA' | 'lngA' | 'dx2Px' | 'dy2Px' | 'dx3Px' | 'dy3Px'>;
  readonly pxPerM: number;
  readonly bearingDeg: number;
  /** The delivery street's geometry, WGS84 — becomes the core's road axis. */
  readonly streetGeometry: readonly GeoPoint[];
  /** The stop itself, for the reported window offset. */
  readonly anchor: GeoPoint;
  readonly fetchedAt: string;
  /** Capture vintage of the orthophoto when the WMS states one; null otherwise. */
  readonly imageryDate: string | null;
}

export interface D10StopWidthDetailed {
  readonly width: Fact<Width>;
  /** The lateral profile the D10 audit canvas renders — straight off the core. */
  readonly offsetsM: readonly number[];
  readonly roadMatchProfile: readonly number[];
  readonly confidence: number;
  readonly reasonCodes: readonly string[];
}

/** Same measurement, plus the profile arrays the destination visual ships. */
export function measureD10StopWidthDetailed(input: D10StopWidthInput): D10StopWidthDetailed {
  const consolidated = runCore(input);
  return {
    width: toFact(consolidated, input),
    offsetsM: consolidated.profileResult.offsetsM,
    roadMatchProfile: consolidated.profileResult.roadMatchProfile,
    confidence: consolidated.confidence,
    reasonCodes: consolidated.reasonCodes,
  };
}

export function measureD10StopWidth(input: D10StopWidthInput): Fact<Width> {
  return toFact(runCore(input), input);
}

function runCore(input: D10StopWidthInput) {
  return measureStitchedRoadWidthWithoutYolo({
    stitched: input.stitched,
    tile: {
      latA: input.frame.latA,
      lngA: input.frame.lngA,
      dx2Px: input.frame.dx2Px,
      dy2Px: input.frame.dy2Px,
      dx3Px: input.frame.dx3Px,
      dy3Px: input.frame.dy3Px,
      roadPolylines: [input.streetGeometry.map((p) => ({ lat: p.lat, lng: p.lon }))],
    },
    bearingDeg: input.bearingDeg,
    pxPerM: input.pxPerM,
    gtWidthM: null,
  });
}

function toFact(
  consolidated: ReturnType<typeof runCore>,
  input: D10StopWidthInput,
): Fact<Width> {
  if (consolidated.widthM === null) {
    return {
      known: false,
      why: 'not_visible',
      provenance: { source: 'ign-ortho', method: 'd10-stitched', fetchedAt: input.fetchedAt },
    };
  }

  const windowCentre: GeoPoint = { lat: input.frame.latA, lon: input.frame.lngA };
  const value: Width = {
    freeM: consolidated.widthM,
    // The D10 lateral profile measures the rollable width; a separately
    // measured kerb-to-kerb figure belongs to the d10v2 banded path, not yet
    // wired. Equal-by-construction is stated in the reason codes rather than
    // passed off as an independent measurement.
    structuralM: consolidated.widthM,
    measuredAt: windowCentre,
    offsetFromAnchorM: haversineM(input.anchor, windowCentre),
  };

  return {
    known: true,
    value,
    provenance: {
      source: 'ign-ortho',
      method: 'd10-stitched',
      fetchedAt: input.fetchedAt,
      ...(input.imageryDate === null ? {} : { imageryDate: input.imageryDate }),
    },
    reliability: {
      // The core's own confidence, passed through untouched: it already ranks
      // kerb evidence above plateau fallbacks (ADR-047), and re-scoring it
      // here would put two authorities on one number.
      confidence: consolidated.confidence,
      basis: 'measured',
      reasonCodes: ['structural_equals_free_v1', ...consolidated.reasonCodes],
    },
  };
}
