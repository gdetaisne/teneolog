/**
 * Vehicle vocabulary.
 *
 * A profile is data, never code. Evaluators read envelope dimensions by name;
 * a profile missing a dimension an evaluator needs must fail loud rather than
 * default.
 */

import { CRIT_AIR_ORDER, type CritAir, type LowEmissionZone } from './constraints.js';

export type TruckProfileId = string;

export type TruckFamily = 'vul' | 'rigid' | 'semi';

/**
 * Physical envelope. Every dimension is "more is more demanding" — which is
 * what makes the dominance rule below sound.
 */
export interface TruckEnvelope {
  readonly lengthM: number;
  readonly widthM: number;
  readonly heightM: number;
  readonly gvwT: number;
  /** Curb-to-curb minimum turning radius. */
  readonly turnRadiusM: number;
  readonly wheelbaseM: number;
  /**
   * SELLETTE → ESSIEU, pour un véhicule articulé.
   *
   * `wheelbaseM` d'un semi est l'empattement de son TRACTEUR (3,9 m sur un
   * 4×2), et ce n'est pas ce qui conduit le déport : c'est la distance de la
   * sellette à l'essieu de la remorque, environ deux fois plus grande et
   * ÉLEVÉE AU CARRÉ dans la formule SAE/WHI — elle domine d'un ordre de
   * grandeur. Jugé sur son tracteur, le 44 t exigeait 4,07 m dans un angle
   * droit contre 5,35 m pour un porteur 19 t : il sortait « Certain » là où le
   * porteur posait une question, pour le gabarit dont le responsable produit dit que
   * « sortir un semi qui est bloqué, c'est très compliqué » (principe 31).
   *
   * Porté de l'engine (`truck.types.ts`, `kingPinToRearAxleMeters`, ADR-007) :
   * 7,70 m est le typique de classe d'une semi tridem de 13,6 m ; le plafond
   * réglementaire est 12,0 m (directive 96/53/CE).
   *
   * Absent sur un porteur et sur un fourgon — ils n'ont pas de sellette — et
   * c'est la raison de l'optionnel. Un profil de famille `semi` qui ne le
   * porte pas est une donnée incomplète : la lecture ci-dessous retombe alors
   * sur l'empattement du tracteur, le comportement d'hier, et c'est le
   * catalogue livré qui est la garde (`config/policy.example.json`).
   */
  readonly kingPinToRearAxleM?: number;
  readonly frontOverhangM: number;
  readonly rearOverhangM: number;
}

export interface TruckEquipment {
  readonly tailLift: boolean;
  readonly crane: boolean;
  readonly refrigerated: boolean;
}

export interface TruckProfile {
  readonly id: TruckProfileId;
  readonly label: string;
  readonly family: TruckFamily;
  readonly envelope: TruckEnvelope;
  readonly equipment: TruckEquipment;
  /**
   * Crit'Air sticker of the vehicle, when it is known.
   *
   * Deliberately optional, and usually absent: a profile describes a GABARIT —
   * "a 19-tonne rigid" — while a sticker belongs to one registered lorry, from
   * its Euro norm, its fuel and its first registration. Absent, a low-emission
   * zone can still be reported as a requirement to meet ("Crit'Air 3 minimum
   * here"), which is what a carrier acts on; present, it becomes a yes or a no.
   * What it must never do is default to something and answer on its own.
   */
  readonly critAir?: CritAir;
}

/**
 * What a low-emission zone means for a vehicle.
 *
 * `unknown_vehicle` is a first-class answer, not a failure: it is the honest
 * state for a gabarit with no sticker declared, and it still carries the rule
 * to meet. The alternative — assuming a class — is how a report ends up
 * telling a carrier to drive into a fine.
 */
export type LowEmissionZoneOutcome =
  | { readonly kind: 'no_zone' }
  | { readonly kind: 'allowed'; readonly zone: LowEmissionZone }
  | { readonly kind: 'forbidden'; readonly zone: LowEmissionZone }
  | { readonly kind: 'unknown_vehicle'; readonly zone: LowEmissionZone };

/**
 * Read a zone's heavy-goods rule against a vehicle.
 *
 * The comparison is ordinal over `CRIT_AIR_ORDER`: a sticker at or after the
 * banned threshold cannot circulate. `NC` — no sticker at all — is the dirtiest
 * rank, so it is caught by every threshold.
 */
export function readLowEmissionZone(
  zone: LowEmissionZone | null,
  truck: TruckProfile,
): LowEmissionZoneOutcome {
  if (zone === null || zone.bannedFrom === null) return { kind: 'no_zone' };
  if (truck.critAir === undefined) return { kind: 'unknown_vehicle', zone };
  const vehicleRank = CRIT_AIR_ORDER.indexOf(truck.critAir);
  const bannedRank = CRIT_AIR_ORDER.indexOf(zone.bannedFrom);
  if (vehicleRank < 0 || bannedRank < 0) return { kind: 'unknown_vehicle', zone };
  return vehicleRank >= bannedRank ? { kind: 'forbidden', zone } : { kind: 'allowed', zone };
}

/** The cleanest sticker still admitted, for stating the requirement to meet. */
export function cleanestAdmittedCritAir(zone: LowEmissionZone): CritAir | null {
  if (zone.bannedFrom === null) return null;
  const bannedRank = CRIT_AIR_ORDER.indexOf(zone.bannedFrom);
  return bannedRank <= 0 ? null : (CRIT_AIR_ORDER[bannedRank - 1] ?? null);
}

/**
 * LA DIMENSION QUI CONDUIT LE DÉPORT — `L` dans `OT = R − √(R² − L²)`.
 *
 * Une seule lecture, pour tout ce qui juge un balayage (principe 23), et la
 * même que l'engine (`effectiveOfftrackWheelbaseMeters`, ADR-007) :
 *
 *  - véhicule articulé : sellette → essieu de la remorque, qui domine le
 *    tracteur d'un ordre de grandeur ;
 *  - porteur, fourgon : l'empattement, essieu avant → essieu arrière.
 *
 * Ce que ça change, sur le catalogue livré : le 44 t passe de 0,52 m de déport
 * à 2,13 m dans un angle droit, donc de 4,07 m à 5,68 m requis — plus exigeant
 * que le 19 t, ce que la physique dit depuis toujours.
 */
export function effectiveOffTrackWheelbaseM(truck: TruckProfile): number {
  const kingPin = truck.envelope.kingPinToRearAxleM;
  if (truck.family === 'semi' && kingPin !== undefined && kingPin > 0) return kingPin;
  return truck.envelope.wheelbaseM;
}

/**
 * True when `b` is at least as demanding as `a` on every envelope dimension.
 *
 * Deliberately conservative. Feasibility is not monotonic in any single notion
 * of "bigger" — a longer wheelbase can trace a smaller swept path — so an
 * inference across trucks is only sound when one envelope dominates the other
 * on all axes at once. Where neither dominates, nothing is inferred and the
 * point is evaluated (or asked) again.
 */
export function dominates(b: TruckProfile, a: TruckProfile): boolean {
  const x = b.envelope;
  const y = a.envelope;
  return (
    x.lengthM >= y.lengthM &&
    x.widthM >= y.widthM &&
    x.heightM >= y.heightM &&
    x.gvwT >= y.gvwT &&
    x.turnRadiusM >= y.turnRadiusM &&
    x.wheelbaseM >= y.wheelbaseM &&
    x.frontOverhangM >= y.frontOverhangM &&
    x.rearOverhangM >= y.rearOverhangM
  );
}
