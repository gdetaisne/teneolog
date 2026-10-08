import type { Pose, TruckSpec } from './types.js';

export const DEFAULT_SAFETY_MARGIN_M = 1.0;

/**
 * LE RAYON DE L'ESSIEU ARRIÈRE au braquage maxi — la seule lecture (
 * principe 23). Bicyclette : l'essieu avant (centre) décrit un cercle de rayon
 * R, l'essieu arrière un cercle concentrique de rayon Rr = √(R² − L²), L
 * l'empattement. R est lu comme le code le lit depuis ADR-007 — le rayon AU
 * CENTRE DE L'ESSIEU AVANT —, alors que le catalogue le dit « de bordure à
 * bordure » (`TruckEnvelope.turnRadiusM`) : la question reste ouverte et dite
 * (la note de conception interne). 19 t :
 * √(11² − 6,1²) = 9,15 m.
 *
 * Empattement ≥ R : aucun cercle réel, 0 (le déport vaut alors R entier).
 */
export function rearAxleMinTurnRadiusM(turnRadiusM: number, wheelbaseM: number): number {
  if (turnRadiusM <= 0) return 0;
  if (wheelbaseM <= 0) return turnRadiusM;
  if (wheelbaseM >= turnRadiusM) return 0;
  return Math.sqrt(turnRadiusM * turnRadiusM - wheelbaseM * wheelbaseM);
}

/** Déport en régime établi : R − Rr, l'écart entre le cercle de l'avant et celui de l'arrière. */
export function steadyStateOfftrackingM(turnRadiusM: number, wheelbaseM: number): number {
  if (turnRadiusM <= 0 || wheelbaseM <= 0) return 0;
  return turnRadiusM - rearAxleMinTurnRadiusM(turnRadiusM, wheelbaseM);
}

/**
 * LE MOUVEMENT ÉLÉMENTAIRE du trois temps, en forme close (pas
 * d'intégration d'Euler : un arc à braquage constant est exact).
 *
 * `pose` est l'essieu arrière (comme `truckFootprint`), repère image y vers le
 * BAS : `steer` +1 braque vers la DROITE du conducteur (le cap croît en marche
 * avant), −1 vers la gauche, 0 tout droit. `signedLengthM` est le chemin de
 * l'essieu arrière, négatif en marche arrière — à braquage égal, le cap tourne
 * alors dans l'autre sens. Le centre du virage est à `steer·Rr` sur la droite
 * du conducteur ; l'essieu arrière reste sur ce cercle.
 */
export function advanceRearAxle(
  pose: Pose,
  steer: -1 | 0 | 1,
  signedLengthM: number,
  rearAxleRadiusM: number,
): Pose {
  if (steer === 0) {
    return {
      x: pose.x + signedLengthM * Math.cos(pose.headingRad),
      y: pose.y + signedLengthM * Math.sin(pose.headingRad),
      headingRad: pose.headingRad,
    };
  }
  const signedRadius = steer * rearAxleRadiusM;
  const headingRad = pose.headingRad + signedLengthM / signedRadius;
  return {
    x: pose.x + signedRadius * (Math.sin(headingRad) - Math.sin(pose.headingRad)),
    y: pose.y - signedRadius * (Math.cos(headingRad) - Math.cos(pose.headingRad)),
    headingRad,
  };
}

/**
 * Carriageway a JUNCTION TURN demands: the vehicle pivots through the angle,
 * and its rear cuts inside by the off-tracking of its own tightest turn,
 * ramped by how far round it goes.
 *
 * Never ask this of a curve. A bend of 150 m radius and a right
 * angle at a crossroads have nothing in common but a number of degrees, and
 * charging the crossroads' sweep to the bend invented refusals on roads a
 * lorry drives through without touching the wheel.
 */
export function requiredWidthForTurnM(
  turnAngleDeg: number,
  truck: TruckSpec,
  safetyMarginM = DEFAULT_SAFETY_MARGIN_M,
): number {
  const angle = Math.max(0, Math.min(180, turnAngleDeg));
  const ramp = Math.min(angle, 90) / 90;
  return truck.widthM + steadyStateOfftrackingM(truck.turnRadiusM, truck.wheelbaseM) * ramp + safetyMarginM;
}

/**
 * Carriageway a CURVE demands: the vehicle is steered through it, so it sits
 * in steady state and its rear off-tracks by the amount THAT radius imposes —
 * a few centimetres on a wide bend, and the angle swept does not enter.
 */
export function requiredWidthForCurveM(
  radiusM: number,
  truck: TruckSpec,
  safetyMarginM = DEFAULT_SAFETY_MARGIN_M,
): number {
  return truck.widthM + steadyStateOfftrackingM(radiusM, truck.wheelbaseM) + safetyMarginM;
}

export function headingChangeDeg(incomingBearingDeg: number, outgoingBearingDeg: number): number {
  const signed = ((outgoingBearingDeg - incomingBearingDeg + 540) % 360) - 180;
  return Math.abs(signed);
}

export const PL_19T_TRUCK: TruckSpec = {
  id: 'pl-19t',
  label: 'Rigid truck 19 t',
  lengthM: 9.0,
  widthM: 2.5,
  wheelbaseM: 6.1,
  turnRadiusM: 11.0,
  // P0 class-typical split; tracked in la note de conception interne To-control.
  frontOverhangM: 1.2,
  rearOverhangM: 1.7,
};
