/**
 * S2/S3 — Agnostic road constraints.
 *
 * Measured once, for the road, with no truck in sight. Every per-truck answer
 * in the system is a comparison against these.
 */
import type { Fact, SourceId } from './fact.js';
import type { GeoPoint } from './geo.js';
import type { PhysicalBarrier } from './topology.js';

/**
 * A carriageway width, with the place it was actually measured.
 *
 * The window search optimises for a clean, straight stretch, which can sit
 * tens of metres from the door. For a deliverability question that is a
 * different place, so the offset travels with the number and the imagery must
 * show it.
 */
export interface Width {
  /** Width free of fixed obstacles — what the truck can use. */
  readonly freeM: number;
  /** Width between structural edges — kerb to kerb. */
  readonly structuralM: number;
  readonly measuredAt: GeoPoint;
  /** Distance between the measurement window and the point it is meant to describe. */
  readonly offsetFromAnchorM: number;
}

/** A legal limit, with every source that stated one. The smallest wins. */
export interface LegalLimit {
  readonly value: number;
  readonly sources: readonly SourceId[];
  /** Values seen per source, kept so a disagreement is visible rather than averaged. */
  readonly statedValues: readonly { readonly source: SourceId; readonly value: number }[];
}

/**
 * Access rule on a segment.
 *
 * `conditional` is the "sauf desserte locale" case. Whether it clears depends
 * on the position of the segment in the route, not on the tag alone — lawful
 * on the terminal approach, unlawful as a through shortcut.
 */
export type AccessRule =
  | { readonly kind: 'open' }
  | { readonly kind: 'conditional'; readonly permits: readonly ('destination' | 'delivery' | 'permit')[] }
  | { readonly kind: 'forbidden'; readonly appliesTo: 'all' | 'hgv' };

/**
 * Crit'Air class, in the national vocabulary: `EL` is the electric/hydrogen
 * sticker, `V1`..`V5` the numbered ones, `NC` a vehicle old enough to have
 * none. Ordered here from cleanest to dirtiest, which is the order the rules
 * are written in.
 */
export type CritAir = 'EL' | 'V1' | 'V2' | 'V3' | 'V4' | 'V5' | 'NC';

/** Cleanest first. A sticker is banned when it sits at or after the threshold. */
export const CRIT_AIR_ORDER: readonly CritAir[] = ['EL', 'V1', 'V2', 'V3', 'V4', 'V5', 'NC'];

/**
 * A low-emission zone as the national base publishes it, read for ONE vehicle
 * class — heavy goods here, since that is what this product analyses.
 *
 * `bannedFrom` is the schema's own semantics and the easiest thing in this
 * file to invert: it is the sticker **at which circulation stops being
 * allowed**, not the worst one still admitted. `V4` bans Crit'Air 4, 5 and
 * unstickered vehicles. Getting this backwards tells a carrier their lorry may
 * enter Paris when it may not, so it is stated once, here, and read nowhere
 * else by hand.
 */
export interface LowEmissionZone {
  readonly zoneId: string;
  readonly name: string | null;
  /** Cleanest sticker that is ALREADY banned; null when the zone spares HGVs. */
  readonly bannedFrom: CritAir | null;
  /** When the restriction applies, in OSM `opening_hours` syntax. */
  readonly hours: string | null;
  readonly since: string;
  readonly until: string | null;
  readonly decreeUrl: string | null;
  readonly infoUrl: string | null;
  /** Publication date of the national base this was read from. */
  readonly dataUpdatedAt: string | null;
}

export interface LegalBands {
  readonly maxWeightT: Fact<LegalLimit>;
  readonly maxHeightM: Fact<LegalLimit>;
  readonly maxWidthM: Fact<LegalLimit>;
  readonly maxLengthM: Fact<LegalLimit>;
  readonly access: Fact<AccessRule>;
  /**
   * The low-emission zone in force here, or a KNOWN absence of one.
   *
   * `{known: false}` means we did not look, and must never be rendered as "no
   * restriction" — for two years the interface painted exactly that in green,
   * on addresses inside the Paris ZFE (audit 2026-08-26). An answered "no zone
   * here" is `{known: true, value: null}`.
   */
  readonly lowEmissionZone: Fact<LowEmissionZone | null>;
}

export type UrbanRural = 'urban' | 'rural';

export interface SurfaceContext {
  readonly urbanRural: UrbanRural;
  /** Vehicles observed parked along the carriageway. Evidence of usability, not a blocker. */
  readonly parkedVehiclesObserved: boolean;
  readonly sidewalkBothSides: boolean;
}

/** Everything measured at the stop, agnostically. */
export interface StopConstraints {
  readonly at: GeoPoint;
  readonly width: Fact<Width>;
  readonly slopePct: Fact<number>;
  readonly legal: LegalBands;
  readonly surface: Fact<SurfaceContext>;
  /**
   * les barrières physiques relevées SUR LA RUE DE
   * LIVRAISON, telles que S1 les a classées (`TopologyAssessment.barriers`).
   *
   * Portées jusqu'ici parce qu'elles décident de l'arrêt : une borne fixe ferme
   * une rue traversante et large, et jusqu'à ce correctif rien ne les lisait
   * — ni un verdict, ni le fil, et `assessObviousStop` validait par-dessus.
   * `readBarrierClosure` (`topology.ts`) est la seule lecture.
   *
   * Optionnel, et c'est une absence, pas un vide : un instantané écrit avant ce
   * champ ne dit rien des barrières, et `[]` dirait « cherchées, aucune »
   * (principe 14).
   */
  readonly barriers?: readonly Fact<PhysicalBarrier>[];
}
