/**
 * Generalized tractrix chain integration — unified kinematic model.
 *
 * A "reference point" P_ref, at distance `refDistM` (g) forward from the rear
 * axle, is constrained to follow the guide path G(s). This single ODE handles
 * streets, turns, and roundabouts identically; the scene type affects only the
 * shape of the guide polyline.
 *
 * ODE (low-speed, no-slip bicycle model):
 *   dθ/ds = sin(φ − θ) / g
 * where θ = body heading (rad), φ = guide tangent (rad), s = arc-length,
 *       g = refDistM > 0.
 *
 * At each integration step:
 *   R = G − g · u(θ)              rear axle
 *   F = R + L · u(θ)              front axle (L = wheelbaseM)
 *   hitch = R + hitchFwdM · u(θ)  king-pin (articulated only)
 *
 * Articulated chains: hitch path from link i becomes the guide for link i+1,
 * with refDistM_{i+1} = kingPinToRearAxle (trailer's effective wheelbase).
 *
 * No verdict is emitted. This module produces geometry for human inspection.
 *
 * See: la note de conception interne
 */

import type {
  ChainTrackingInput,
  ChainTrackingResult,
  LinkTrackingResult,
  Point,
  VehicleLink,
} from './types.js';

const DEFAULT_DS_M = 0.25;

/** Wrap angle to (−π, π]. */
function normalizeAngle(a: number): number {
  const twoPi = 2 * Math.PI;
  let n = a % twoPi;
  if (n > Math.PI) n -= twoPi;
  else if (n <= -Math.PI) n += twoPi;
  return n;
}

/**
 * Oriented rectangular footprint of one link, anchored on the rear axle.
 * Returns four corners, clockwise: front-left, front-right, rear-right, rear-left.
 */
function linkFootprint(rearAxle: Point, headingRad: number, link: VehicleLink): Point[] {
  const cosH = Math.cos(headingRad);
  const sinH = Math.sin(headingRad);
  // forward and left-normal unit vectors (y-down screen metric)
  const fwdX = cosH;
  const fwdY = sinH;
  const sideX = -sinH; // left normal
  const sideY = cosH;
  const halfW = link.widthM / 2;
  // From rear axle: forward = wheelbase + front overhang; backward = rear overhang
  const frontM = link.lengthM + link.frontOverhangM;
  const rearM = link.rearOverhangM;
  const fcx = rearAxle.x + fwdX * frontM;
  const fcy = rearAxle.y + fwdY * frontM;
  const rcx = rearAxle.x - fwdX * rearM;
  const rcy = rearAxle.y - fwdY * rearM;
  return [
    { x: fcx + sideX * halfW, y: fcy + sideY * halfW },
    { x: fcx - sideX * halfW, y: fcy - sideY * halfW },
    { x: rcx - sideX * halfW, y: rcy - sideY * halfW },
    { x: rcx + sideX * halfW, y: rcy + sideY * halfW },
  ];
}

/**
 * Integrate one link along its guide polyline.
 *
 * The guide is the path that the link's reference point (at `refDistM` forward
 * of the rear axle) must follow. Euler integration is applied at sub-steps of
 * ≤ dsM along each guide segment.
 *
 * Returns per-step results AND the hitch path (used as guide for the next
 * link in an articulated chain).
 */
function integrateLink(
  guide: readonly Point[],
  dsM: number,
  link: VehicleLink,
  initialHeadingRad: number,
): {
  readonly result: LinkTrackingResult;
  readonly hitchPath: readonly Point[];
} {
  const refPath: Point[] = [];
  const rearAxlePath: Point[] = [];
  const frontAxlePath: Point[] = [];
  const bodyFootprints: Point[][] = [];
  const hitchPath: Point[] = [];

  const g = Math.max(link.refDistM, 0.01); // guard against zero
  const hitchFwd = link.hitchFwdM ?? 0; // default: hitch at rear axle

  let theta = initialHeadingRad;

  /** Record all derived positions for the current guide point + heading. */
  function record(guidePoint: Point): void {
    const cosT = Math.cos(theta);
    const sinT = Math.sin(theta);

    refPath.push(guidePoint);

    // Rear axle: R = G - g·u(θ)
    const rx = guidePoint.x - g * cosT;
    const ry = guidePoint.y - g * sinT;
    const rearAxle: Point = { x: rx, y: ry };
    rearAxlePath.push(rearAxle);

    // Front axle: F = R + L·u(θ)
    frontAxlePath.push({ x: rx + link.lengthM * cosT, y: ry + link.lengthM * sinT });

    // Body footprint (oriented rectangle anchored on rear axle)
    bodyFootprints.push(linkFootprint(rearAxle, theta, link));

    // Hitch point: R + hitchFwd·u(θ)
    hitchPath.push({ x: rx + hitchFwd * cosT, y: ry + hitchFwd * sinT });
  }

  if (guide.length === 0) {
    return { result: { refPath, rearAxlePath, frontAxlePath, bodyFootprints, hitchPath }, hitchPath };
  }

  // Record initial state (no integration at first point)
  record(guide[0]!);

  for (let i = 1; i < guide.length; i++) {
    const prev = guide[i - 1]!;
    const curr = guide[i]!;
    const dx = curr.x - prev.x;
    const dy = curr.y - prev.y;
    const segLen = Math.hypot(dx, dy);
    if (segLen < 1e-9) continue;

    // Guide tangent for this segment
    const phi = Math.atan2(dy, dx);

    // Sub-divide segment so each step ≤ dsM
    const nSteps = Math.max(1, Math.ceil(segLen / dsM));
    const actualDs = segLen / nSteps;
    const ux = dx / segLen;
    const uy = dy / segLen;

    for (let step = 1; step <= nSteps; step++) {
      // Euler: θ += sin(φ − θ) / g · Δs
      const dAngle = normalizeAngle(phi - theta);
      theta += (Math.sin(dAngle) / g) * actualDs;

      const t = step / nSteps;
      record({ x: prev.x + ux * segLen * t, y: prev.y + uy * segLen * t });
    }
  }

  return { result: { refPath, rearAxlePath, frontAxlePath, bodyFootprints, hitchPath }, hitchPath };
}

/**
 * Simulate a vehicle chain following a guide path.
 *
 * The guide must be in metric space (caller converts from px using pxPerM).
 * All returned paths are in the same metric space.
 *
 * No verdict is produced — outputs are geometry for human inspection.
 */
export function simulateChainAlongGuide(input: ChainTrackingInput): ChainTrackingResult {
  const dsM = input.dsM ?? DEFAULT_DS_M;
  const guide = input.guideM;

  if (guide.length < 2) {
    return { links: [], envelopePolygon: [], reasonCodes: ['guide_too_short'] };
  }
  if (input.chain.links.length === 0) {
    return { links: [], envelopePolygon: [], reasonCodes: ['chain_empty'] };
  }

  const reasonCodes: string[] = ['chain_tractrix_euler'];
  const linkResults: LinkTrackingResult[] = [];
  const allFootprints: Point[][] = [];

  // Initial heading = guide tangent at start (truck enters aligned with the trace)
  let currentGuide: readonly Point[] = guide;
  let currentHeading = Math.atan2(guide[1]!.y - guide[0]!.y, guide[1]!.x - guide[0]!.x);

  for (const link of input.chain.links) {
    if (link.refDistM <= 0) {
      reasonCodes.push('invalid_ref_dist');
      break;
    }

    const { result, hitchPath } = integrateLink(currentGuide, dsM, link, currentHeading);
    linkResults.push(result);

    for (const footprint of result.bodyFootprints) {
      allFootprints.push([...footprint]);
    }

    // Next link: hitch path becomes the guide
    if (hitchPath.length < 2) break;
    currentHeading = Math.atan2(
      hitchPath[1]!.y - hitchPath[0]!.y,
      hitchPath[1]!.x - hitchPath[0]!.x,
    );
    currentGuide = hitchPath;
  }

  // Envelope metric contour is deferred — debug UI renders evenodd union of
  // bodyFootprintsPx directly (same geometry, no boolean/raster cost on each fetch).
  // Call rasterFootprintEnvelope() when N1 clearance samples need a metric polygon.
  if (allFootprints.length > 0) {
    reasonCodes.push('swept_envelope_evenodd_ui');
  }

  return { links: linkResults, envelopePolygon: [], reasonCodes };
}
