import type { CarZone } from './car-zone.js';
import type { D10v2StructuralResult } from './d10v2-banded-width.js';
import {
  carZoneIntersectsPlateau,
  parkedClampTargetM,
} from './yolo-clamp.js';

export type D10v2RollableSource =
  | 'yolo_clamp'
  | 'structural_unchanged'
  | 'd10_corroborated'
  | 'unavailable';

export interface D10v2Result extends D10v2StructuralResult {
  /** Phase B — rollable width after parking occlusion. */
  readonly largeurExploitableM: number | null;
  readonly rollableSource: D10v2RollableSource;
  readonly leftRollableM: number | null;
  readonly rightRollableM: number | null;
}

export interface AttachD10v2RollableInput {
  readonly carZones: readonly CarZone[];
  readonly parkingSideCount: 0 | 1 | 2;
  readonly parkedCarCount: number;
  /** D10 published rollable width — corroborates parking narrowing when narrower. */
  readonly d10WidthFinalM?: number | null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function plateauEdgeForSide(side: 'left' | 'right', leftM: number, rightM: number): number {
  return side === 'right' ? rightM : leftM;
}

function innermostParkedZone(side: 'left' | 'right', zones: readonly CarZone[]): CarZone | null {
  if (zones.length === 0) return null;
  return zones.reduce((best, z) => {
    if (side === 'right') {
      return z.innerEdgeM < best.innerEdgeM ? z : best;
    }
    return z.innerEdgeM > best.innerEdgeM ? z : best;
  });
}

function clampStructuralWithYolo(
  leftEdgeM: number,
  rightEdgeM: number,
  carZones: readonly CarZone[],
): {
  readonly leftM: number;
  readonly rightM: number;
  readonly yoloApplied: boolean;
  readonly reasonCodes: readonly string[];
} {
  let leftM = leftEdgeM;
  let rightM = rightEdgeM;
  let yoloApplied = false;
  const reasonCodes: string[] = [];

  for (const side of ['left', 'right'] as const) {
    const plateauEdge = plateauEdgeForSide(side, leftEdgeM, rightEdgeM);
    const sideCars = carZones.filter(
      (z) => z.side === side && carZoneIntersectsPlateau(z, leftEdgeM, rightEdgeM),
    );
    if (sideCars.length === 0) continue;

    const target = innermostParkedZone(side, sideCars);
    if (!target) continue;

    const clampM = parkedClampTargetM(side, target.innerEdgeM, plateauEdge);
    if (side === 'right' && clampM < rightM) {
      rightM = clampM;
      yoloApplied = true;
      reasonCodes.push(`d10v2:yolo_clamp_R:${target.innerEdgeM.toFixed(2)}→${clampM.toFixed(2)}`);
    } else if (side === 'left' && clampM > leftM) {
      leftM = clampM;
      yoloApplied = true;
      reasonCodes.push(`d10v2:yolo_clamp_L:${target.innerEdgeM.toFixed(2)}→${clampM.toFixed(2)}`);
    }
  }

  return { leftM, rightM, yoloApplied, reasonCodes };
}

function symmetricEdges(widthM: number): { leftM: number; rightM: number } {
  const half = round2(widthM / 2);
  return { leftM: -half, rightM: half };
}

/**
 * D10v2 Phase B — rollable width from Phase A structural edges + YOLO / BDTOPO parking.
 */
export function attachD10v2Rollable(
  structural: D10v2StructuralResult,
  input: AttachD10v2RollableInput,
): D10v2Result {
  if (structural.source === 'unavailable' || structural.largeurRueM == null) {
    return {
      ...structural,
      largeurExploitableM: null,
      rollableSource: 'unavailable',
      leftRollableM: null,
      rightRollableM: null,
      reasonCodes: [...structural.reasonCodes, 'd10v2:rollable_unavailable'],
    };
  }

  const structuralWidth = structural.largeurRueM;
  const leftEdge = structural.leftEdgeM ?? -structuralWidth / 2;
  const rightEdge = structural.rightEdgeM ?? structuralWidth / 2;
  const reasonCodes = [...structural.reasonCodes];

  const yolo = clampStructuralWithYolo(leftEdge, rightEdge, input.carZones);
  reasonCodes.push(...yolo.reasonCodes);

  let rollableWidth = round2(yolo.rightM - yolo.leftM);
  let leftRollable = round2(yolo.leftM);
  let rightRollable = round2(yolo.rightM);
  let rollableSource: D10v2RollableSource = yolo.yoloApplied
    ? 'yolo_clamp'
    : 'structural_unchanged';

  const hasParkingEvidence = input.parkingSideCount > 0 || input.parkedCarCount > 0;

  if (
    input.d10WidthFinalM != null
    && input.d10WidthFinalM < rollableWidth
    && hasParkingEvidence
  ) {
    rollableWidth = round2(input.d10WidthFinalM);
    const sym = symmetricEdges(rollableWidth);
    leftRollable = sym.leftM;
    rightRollable = sym.rightM;
    rollableSource = 'd10_corroborated';
    reasonCodes.push(`d10v2:rollable_from_d10_final:${rollableWidth}`);
    if (input.parkedCarCount > 0) {
      reasonCodes.push(`d10v2:parked_cars=${input.parkedCarCount}`);
    }
  }

  reasonCodes.push(
    `d10v2:exploitable=${rollableWidth}`,
    `d10v2:rollable_source=${rollableSource}`,
  );

  const rollableConfidenceFactor =
    rollableSource === 'yolo_clamp' ? 0.92
      : rollableSource === 'd10_corroborated' ? 0.88
        : 1;

  return {
    ...structural,
    largeurExploitableM: rollableWidth,
    rollableSource,
    leftRollableM: leftRollable,
    rightRollableM: rightRollable,
    confidence: round2(structural.confidence * rollableConfidenceFactor),
    reasonCodes,
  };
}
