/**
 * S7 — one review scene: a critical point on its aerial frame, annotated for
 * one truck, carrying the single question the deck asks.
 *
 * Pure assembly over an already-fetched stitched frame. The projection
 * primitives are the FROZEN ones (`getStitchedCanvasMetrics`,
 * `latLngToCanvasPx` from the road-width core): imagery.md's golden rule —
 * never hand-roll the geo→pixel transform, every hand-rolled copy drifted.
 *
 * The truck manoeuvre comes from the frozen swept-path simulation. Its local
 * metric frame and the stitched canvas share the image convention (x east,
 * y DOWN), so metres map to pixels by scale alone around the anchor — no
 * rotation term to get wrong.
 */
import { effectiveOffTrackWheelbaseM } from '@teneolog/domain';
import type { CriticalPoint, GeoPoint, TruckProfile } from '@teneolog/domain';
import {
  getStitchedCanvasMetrics,
  latLngToCanvasPx,
  type TileGeoContext,
} from '@teneolog/road-width';
import { rasterFootprintEnvelope, simulateTurn, type SweptPathSimulationResult, type TruckSpec } from '@teneolog/swept-path';

import { spineSweepPolygons } from './spine-sweep.js';

export interface SceneFrame {
  readonly latA: number;
  readonly lngA: number;
  readonly dx2Px: number;
  readonly dy2Px: number;
  readonly dx3Px: number;
  readonly dy3Px: number;
  readonly pxPerM: number;
  readonly bearingDeg: number;
  readonly widthPx: number;
  readonly heightPx: number;
}

export interface ScenePolygon {
  readonly kind: 'swept_envelope' | 'truck_footprint' | 'required_circle' | 'ring';
  readonly points: readonly { readonly x: number; readonly y: number }[];
}

export interface SceneMarker {
  readonly kind: 'point' | 'mouth' | 'delivery';
  readonly x: number;
  readonly y: number;
  readonly label: string;
}

export interface ReviewScene {
  readonly pointRef: string;
  readonly truckId: string;
  readonly frame: SceneFrame;
  readonly imagePngBase64: string;
  readonly markers: readonly SceneMarker[];
  readonly polygons: readonly ScenePolygon[];
  /** The frozen simulation's own opinion, shown beside the image, never instead of it. */
  readonly simulated: { readonly verdict: string; readonly minClearanceM: number } | null;
}

export interface StitchedFrameInput {
  readonly tile: Pick<TileGeoContext, 'latA' | 'lngA' | 'dx2Px' | 'dy2Px' | 'dx3Px' | 'dy3Px'>;
  readonly pxPerM: number;
  readonly bearingDeg: number;
  readonly pngBase64: string;
  readonly widthPx: number;
  readonly heightPx: number;
}

/**
 * @param requiredTurnaroundDiameterM le diamètre REQUIS du
 *   demi-tour pour ce camion, tel que le verdict le lit
 *   (`turnaroundRequirementM` de `@teneolog/projection`, 2 R + dégagement).
 *   Passé par l'appelant plutôt que recalculé ici : une formule, une source
 *   (principe 23), et ce paquet ne dépend pas de la projection. Absent, le
 *   cercle requis n'est pas dessiné — un cercle faux serait pire qu'aucun.
 */
export function buildReviewScene(
  point: CriticalPoint,
  truck: TruckProfile,
  frame: StitchedFrameInput,
  extraMarkers: readonly { readonly kind: SceneMarker['kind']; readonly at: GeoPoint; readonly label: string }[] = [],
  routeSpineM: readonly { readonly x: number; readonly y: number }[] = [],
  requiredTurnaroundDiameterM?: number,
): ReviewScene {
  const metrics = getStitchedCanvasMetrics(frame.tile);
  const project = (p: GeoPoint) =>
    latLngToCanvasPx({ lat: p.lat, lng: p.lon }, frame.tile, metrics, frame.pxPerM);

  const markers: SceneMarker[] = [
    { kind: 'point', ...project(point.at), label: point.type },
    ...extraMarkers.map((m) => ({ kind: m.kind, ...project(m.at), label: m.label })),
  ];

  const polygons: ScenePolygon[] = [];
  let simulated: ReviewScene['simulated'] = null;

  if (point.geometry.known) {
    const g = point.geometry.value;

    if (g.type === 'TURN') {
      const t = g.geometry;
      const apexPx = project(t.apex);
      const spinePolygons = spineSweepPolygons(routeSpineM, truck, project(point.at), frame.pxPerM);
      if (spinePolygons !== null) {
        // The truck follows the measured route polyline (chain tracking: the
        // front tracks the guide, the rear off-tracks) — never a synthetic
        // curve that shortcuts the junction through the buildings.
        polygons.push(...spinePolygons);
      } else {
        const sim = simulateTurn({
          kind: 'turn',
          truck: toSpec(truck),
          apex: { x: 0, y: 0 },
          incomingBearingDeg: t.approachBearingDeg,
          outgoingBearingDeg: t.exitBearingDeg,
          incomingWidthM: widthOr(t.approachWidth, 6),
          outgoingWidthM: widthOr(t.exitWidth, 6),
        });
        polygons.push(...simPolygons(sim, apexPx, frame.pxPerM));
        simulated = { verdict: sim.verdict, minClearanceM: sim.minClearanceM };
      }
    }

    if (g.type === 'ROUNDABOUT') {
      const centrePx = project(g.geometry.centre);
      polygons.push({ kind: 'ring', points: circle(centrePx, g.geometry.outerRadiusM * frame.pxPerM) });
      const spinePolygons = spineSweepPolygons(routeSpineM, truck, project(point.at), frame.pxPerM);
      if (spinePolygons !== null) polygons.push(...spinePolygons);
    }

    if (g.type === 'TURNAROUND') {
      polygons.push(
        ...turnaroundCircles(project(point.at), g.geometry.surface.usableDiameterM, requiredTurnaroundDiameterM, frame.pxPerM),
      );
    }
  }

  return {
    pointRef: point.ref,
    truckId: truck.id,
    frame: {
      latA: frame.tile.latA,
      lngA: frame.tile.lngA,
      dx2Px: frame.tile.dx2Px,
      dy2Px: frame.tile.dy2Px,
      dx3Px: frame.tile.dx3Px,
      dy3Px: frame.tile.dy3Px,
      pxPerM: frame.pxPerM,
      bearingDeg: frame.bearingDeg,
      widthPx: frame.widthPx,
      heightPx: frame.heightPx,
    },
    imagePngBase64: frame.pngBase64,
    markers,
    polygons,
    simulated,
  };
}

/**
 * Two circles tell the whole story: what the space offers, what the truck
 * needs. The reviewer sees the gap without reading a number.
 *
 * the required circle is drawn at HALF THE REQUIRED DIAMETER,
 * R + clearance/2 (12 m for the 19 t): it used to be drawn at the turning
 * radius alone, so the circle on the photo was 2 m smaller across than the
 * requirement the verdict judged. A drawing changes; no verdict does.
 */
function turnaroundCircles(
  centrePx: { x: number; y: number },
  offeredDiameterM: number,
  requiredDiameterM: number | undefined,
  pxPerM: number,
): ScenePolygon[] {
  const out: ScenePolygon[] = [{ kind: 'ring', points: circle(centrePx, (offeredDiameterM / 2) * pxPerM) }];
  if (requiredDiameterM !== undefined) {
    out.push({ kind: 'required_circle', points: circle(centrePx, (requiredDiameterM / 2) * pxPerM) });
  }
  return out;
}

/**
 * The union outline of the swept body, not its convex hull: a hull closes the
 * inside of an L-turn and paints the buildings, while the raster union hugs
 * what the truck actually covers.
 */
function sweptOutline(sim: SweptPathSimulationResult): readonly { x: number; y: number }[] {
  const raster = rasterFootprintEnvelope(sim.bodyFootprints, 0.2);
  return raster.ok && raster.envelope.length >= 3 ? raster.envelope : sim.envelopePolygon;
}

/** Local metres (image convention, y down) → canvas px around an anchor. */
function simPolygons(
  sim: SweptPathSimulationResult,
  anchorPx: { x: number; y: number },
  pxPerM: number,
): ScenePolygon[] {
  const place = (pts: readonly { x: number; y: number }[]): { x: number; y: number }[] =>
    pts.map((p) => ({ x: anchorPx.x + p.x * pxPerM, y: anchorPx.y + p.y * pxPerM }));

  const out: ScenePolygon[] = [{ kind: 'swept_envelope', points: place(sweptOutline(sim)) }];
  // Three body positions read as motion without cluttering the frame.
  const n = sim.bodyFootprints.length;
  for (const index of [0, Math.floor(n / 2), n - 1]) {
    const footprint = sim.bodyFootprints[index];
    if (footprint !== undefined) out.push({ kind: 'truck_footprint', points: place(footprint) });
  }
  return out;
}

function circle(centre: { x: number; y: number }, radiusPx: number): { x: number; y: number }[] {
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i < 48; i += 1) {
    const a = (i / 48) * 2 * Math.PI;
    pts.push({ x: centre.x + Math.cos(a) * radiusPx, y: centre.y + Math.sin(a) * radiusPx });
  }
  return pts;
}

function widthOr(width: CriticalPoint['geometry'] extends never ? never : { known: boolean } & Record<string, unknown>, fallbackM: number): number {
  const w = width as { known: boolean; value?: { freeM: number } };
  return w.known && w.value !== undefined ? w.value.freeM : fallbackM;
}

function toSpec(truck: TruckProfile): TruckSpec {
  return {
    id: truck.id,
    label: truck.label,
    lengthM: truck.envelope.lengthM,
    widthM: truck.envelope.widthM,
    // La dimension qui balaye : l'empattement du porteur, sellette → essieu
    // pour l'articulé — la même lecture que le verdict (principe 23).
    wheelbaseM: effectiveOffTrackWheelbaseM(truck),
    turnRadiusM: truck.envelope.turnRadiusM,
    frontOverhangM: truck.envelope.frontOverhangM,
    rearOverhangM: truck.envelope.rearOverhangM,
  };
}
