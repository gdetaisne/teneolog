/**
 * S7 — the truck swept along the measured route spine, and the spine as it is
 * driven when the steer starts earlier.
 *
 * Both are pure geometry over the FROZEN swept-path chain tracking: the front
 * reference point follows the guide, the rear off-tracks. Nothing here knows
 * a verdict, a policy, or a frame — local metres in, local metres (or canvas
 * pixels around an anchor) out.
 */
import { effectiveOffTrackWheelbaseM } from '@teneolog/domain';
import type { TruckProfile } from '@teneolog/domain';
import { rasterFootprintEnvelope, simulateChainAlongGuide } from '@teneolog/swept-path';

import type { ScenePolygon } from './scene.js';

export interface LocalPoint {
  readonly x: number;
  readonly y: number;
}

/** Raster cell of the swept-envelope union, metres. Geometric, not policy. */
const ENVELOPE_RASTER_CELL_M = 0.2;
/** Sample spacing of the eased corner the anticipated guide follows, metres. */
const ANTICIPATION_CURVE_STEP_M = 0.5;
/** Playback frames shipped per sweep: enough for fluid motion, light on the wire. */
const MAX_PLAYBACK_FRAMES = 80;

/**
 * Sweep the truck along the measured route spine (local metres around the
 * point, image convention). Front reference tracks the guide; the swept
 * envelope is the raster union of the body, not a hull. Null when the spine
 * cannot carry a simulation.
 */
export function spineSweepPolygons(
  spineM: readonly LocalPoint[],
  truck: TruckProfile,
  anchorPx: LocalPoint,
  pxPerM: number,
): ScenePolygon[] | null {
  if (spineM.length < 2) return null;
  const e = truck.envelope;
  // Même lecture que le verdict : sellette → essieu pour l'articulé.
  const trackedWheelbaseM = effectiveOffTrackWheelbaseM(truck);
  const tracked = simulateChainAlongGuide({
    guideM: spineM,
    chain: {
      links: [
        {
          lengthM: trackedWheelbaseM,
          widthM: e.widthM,
          frontOverhangM: e.frontOverhangM,
          rearOverhangM: e.rearOverhangM,
          refDistM: trackedWheelbaseM,
        },
      ],
    },
  });
  const link = tracked.links[0];
  if (link === undefined || link.bodyFootprints.length === 0) return null;
  const raster = rasterFootprintEnvelope(link.bodyFootprints, ENVELOPE_RASTER_CELL_M);
  if (!raster.ok || raster.envelope.length < 3) return null;
  const place = (pts: readonly LocalPoint[]): LocalPoint[] =>
    pts.map((p) => ({ x: anchorPx.x + p.x * pxPerM, y: anchorPx.y + p.y * pxPerM }));
  const out: ScenePolygon[] = [{ kind: 'swept_envelope', points: place(raster.envelope) }];
  // Every integration step is an animation frame for the front's playback —
  // subsampled to keep the wire light while the motion stays fluid.
  const n = link.bodyFootprints.length;
  const step = Math.max(1, Math.ceil(n / MAX_PLAYBACK_FRAMES));
  for (let index = 0; index < n; index += step) {
    const footprint = link.bodyFootprints[index];
    if (footprint !== undefined) out.push({ kind: 'truck_footprint', points: place([...footprint]) });
  }
  const last = link.bodyFootprints[n - 1];
  if (last !== undefined && (n - 1) % step !== 0) {
    out.push({ kind: 'truck_footprint', points: place([...last]) });
  }
  return out;
}

/**
 * The spine as driven when the steer starts `startEarlierM` before the corner
 *. The corner is the spine vertex nearest the reviewed point (the
 * same vertex `routeSpineAround` centres on). The guide leaves the incoming
 * leg `startEarlierM` upstream of that vertex, eases through the corner on a
 * quadratic curve controlled by the vertex — tangent to both legs, so the
 * heading change is spread over the anticipation instead of happening at the
 * vertex — and rejoins the outgoing leg `startEarlierM` downstream. Vertices
 * swallowed by the curve are dropped; the rest of the spine is untouched.
 *
 * 0 m returns the spine itself, so the tight variant is the main scene, bit
 * for bit. Null when the spine has no corner with a leg on each side.
 */
export function anticipatedSpine(
  spineM: readonly LocalPoint[],
  startEarlierM: number,
): readonly LocalPoint[] | null {
  if (spineM.length < 2) return null;
  if (startEarlierM <= 0) return spineM;
  const corner = nearestVertexToOrigin(spineM);
  if (corner <= 0 || corner >= spineM.length - 1) return null;
  const apex = spineM[corner]!;
  const before = walkAlong(spineM, corner, -startEarlierM);
  const after = walkAlong(spineM, corner, startEarlierM);
  const curve = quadraticCurve(before.point, apex, after.point);
  return [...spineM.slice(0, before.keepUntil + 1), ...curve, ...spineM.slice(after.keepFrom)];
}

function nearestVertexToOrigin(spineM: readonly LocalPoint[]): number {
  let nearest = 0;
  let nearestD = Number.POSITIVE_INFINITY;
  for (let i = 0; i < spineM.length; i += 1) {
    const p = spineM[i]!;
    const d = Math.hypot(p.x, p.y);
    if (d < nearestD) {
      nearestD = d;
      nearest = i;
    }
  }
  return nearest;
}

/**
 * The point `distanceM` along the polyline from vertex `from` (negative =
 * upstream), clamped to the spine's ends. `keepUntil` is the last upstream
 * vertex still before the point; `keepFrom` the first downstream vertex after.
 */
function walkAlong(
  spineM: readonly LocalPoint[],
  from: number,
  distanceM: number,
): { point: LocalPoint; keepUntil: number; keepFrom: number } {
  const dir = distanceM < 0 ? -1 : 1;
  let remaining = Math.abs(distanceM);
  let i = from;
  while (i + dir >= 0 && i + dir < spineM.length) {
    const a = spineM[i]!;
    const b = spineM[i + dir]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len >= remaining) {
      const t = len === 0 ? 0 : remaining / len;
      const point = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      return dir < 0
        ? { point, keepUntil: i - 1, keepFrom: i }
        : { point, keepUntil: i, keepFrom: i + 1 };
    }
    remaining -= len;
    i += dir;
  }
  // Ran off the spine: the anticipation starts (or ends) at its very end.
  const end = spineM[i]!;
  return dir < 0 ? { point: end, keepUntil: -1, keepFrom: 0 } : { point: end, keepUntil: i, keepFrom: spineM.length };
}

/** Quadratic Bézier a → b sampled every ~ANTICIPATION_CURVE_STEP_M, endpoints included. */
function quadraticCurve(a: LocalPoint, control: LocalPoint, b: LocalPoint): LocalPoint[] {
  const chord = Math.hypot(a.x - control.x, a.y - control.y) + Math.hypot(b.x - control.x, b.y - control.y);
  const n = Math.max(4, Math.ceil(chord / ANTICIPATION_CURVE_STEP_M));
  const out: LocalPoint[] = [];
  for (let k = 0; k <= n; k += 1) {
    const t = k / n;
    const u = 1 - t;
    out.push({
      x: u * u * a.x + 2 * u * t * control.x + t * t * b.x,
      y: u * u * a.y + 2 * u * t * control.y + t * t * b.y,
    });
  }
  return out;
}
