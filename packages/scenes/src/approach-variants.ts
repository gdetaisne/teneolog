/**
 * S7 — the three attack angles of a TURN: the same truck, the same
 * measured route spine, the same frame, the steer starting 0 / 3 / 6 m earlier.
 *
 * Every variant comes from the SAME spine-based sweep as the main scene, only
 * the guide differs (`anticipatedSpine`). The 0 m variant IS the main scene.
 * No synthetic apex, no verdict: the deck compares envelopes on the photo.
 */
import type { CriticalPoint, TruckProfile } from '@teneolog/domain';
import { getStitchedCanvasMetrics, latLngToCanvasPx } from '@teneolog/road-width';

import type { StitchedFrameInput } from './scene.js';
import { anticipatedSpine, spineSweepPolygons, type LocalPoint } from './spine-sweep.js';

export type TurnApproachVariantId = 'tight' | 'early_3m' | 'early_6m';
export type ApproachStartEarlierM = Readonly<Record<TurnApproachVariantId, number>>;

export const DEFAULT_APPROACH_START_EARLIER_M: ApproachStartEarlierM = {
  // Miroir de `config/policy.example.json`; utilisé seulement sans policy injectée.
  tight: 0,
  early_3m: 3,
  early_6m: 6,
};

/** Tightest first: the order the wire ships and the deck's stepper walks. */
const APPROACH_VARIANT_IDS: readonly TurnApproachVariantId[] = ['tight', 'early_3m', 'early_6m'];
const APPROACH_VARIANT_LABELS: Readonly<Record<TurnApproachVariantId, string>> = {
  tight: 'Approche serrée',
  early_3m: 'Anticipée +3 m',
  early_6m: 'Anticipée +6 m',
};

export interface TurnApproachVariant {
  readonly id: TurnApproachVariantId;
  readonly label: string;
  readonly startEarlierM: number;
  readonly framePx: { readonly width: number; readonly height: number };
  readonly envelopePolygonPx: readonly (readonly [number, number])[];
  /** Playback frames, same subsampling as the main scene's `truck_footprint` polygons. */
  readonly bodyFootprintsPx: readonly (readonly (readonly [number, number])[])[];
}

/**
 * All three variants, or none: a point that is not a TURN, has no route spine
 * (orphan point — no fallback to a synthetic corner), or whose spine has no
 * corner with a leg on each side yields `[]`, and the deck shows no stepper.
 */
export function buildTurnApproachVariants(
  point: CriticalPoint,
  truck: TruckProfile,
  frame: Pick<StitchedFrameInput, 'tile' | 'pxPerM' | 'widthPx' | 'heightPx'>,
  routeSpineM: readonly LocalPoint[],
  startEarlierM: ApproachStartEarlierM = DEFAULT_APPROACH_START_EARLIER_M,
): readonly TurnApproachVariant[] {
  if (!point.geometry.known || point.geometry.value.type !== 'TURN') return [];
  if (routeSpineM.length < 2) return [];
  const metrics = getStitchedCanvasMetrics(frame.tile);
  // Same anchor as `buildReviewScene`: the reviewed point, so the envelopes overlay.
  const anchorPx = latLngToCanvasPx(
    { lat: point.at.lat, lng: point.at.lon },
    frame.tile,
    metrics,
    frame.pxPerM,
  );
  const out: TurnApproachVariant[] = [];
  for (const id of APPROACH_VARIANT_IDS) {
    const guide = anticipatedSpine(routeSpineM, startEarlierM[id]);
    if (guide === null) return [];
    const polygons = spineSweepPolygons(guide, truck, anchorPx, frame.pxPerM);
    const envelope = polygons?.find((p) => p.kind === 'swept_envelope');
    if (polygons === null || envelope === undefined) return [];
    const tuple = (pts: readonly LocalPoint[]): (readonly [number, number])[] =>
      pts.map((q) => [q.x, q.y] as const);
    out.push({
      id,
      label: APPROACH_VARIANT_LABELS[id],
      startEarlierM: startEarlierM[id],
      framePx: { width: frame.widthPx, height: frame.heightPx },
      envelopePolygonPx: tuple(envelope.points),
      bodyFootprintsPx: polygons
        .filter((p) => p.kind === 'truck_footprint')
        .map((p) => tuple(p.points)),
    });
  }
  return out;
}
