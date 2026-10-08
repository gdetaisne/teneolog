/**
 * S1 — Terminal topology.
 *
 * The shape of the road at the stop, measured, before any truck is considered.
 *
 * The type is arranged so the defect it replaces cannot be expressed. In the
 * engine the shape was three independent booleans plus a nullable diameter, so
 * "there is a loop, we never measured it, treat it as fine" was a representable
 * and unhandled state — and it was the state a single OSM tag produced. Here a
 * terminal shape always carries its turnaround as a `Fact`, so the unmeasured
 * case has to be answered.
 */
import type { Fact } from './fact.js';
import type { GeoPoint, BearingDeg } from './geo.js';

/** Measured turnaround geometry. Absence is carried by the enclosing `Fact`. */
export interface Turnaround {
  /** Largest circle the vehicle can actually trace here, measured. */
  readonly usableDiameterM: number;
  readonly centre: GeoPoint;
  readonly surface: 'carriageway' | 'turning_circle' | 'loop' | 'open_area';
}

/**
 * How through-ness was established. A street whose name, importance or
 * direction changes at a node is still the same road: continuity is geometric,
 * never an attribute identity.
 */
export interface Continuity {
  readonly establishedBy: 'geometric_continuation' | 'same_way' | 'junction_traversal';
  /** Angular deviation at the node, degrees. Small means the road goes on. */
  readonly deviationDeg: number;
  /** True when the ways differ in name, importance or direction across the node. */
  readonly attributeBreak: boolean;
}

export interface OneWayConstraint {
  readonly oneWay: boolean;
  /** Permitted direction of travel, when one-way. */
  readonly permittedHeadingDeg: BearingDeg | null;
}

export interface Mouth {
  readonly point: GeoPoint;
  readonly parentSegmentId: string;
  readonly distanceFromStopM: number;
  /** Depth of the recursion when the parent street is itself terminal. */
  readonly depth: number;
}

/**
 * The three shapes a stop can have. Shape only.
 *
 * Access — private, pedestrian, gated, class-forbidden — is deliberately NOT a
 * fourth shape. It is a different dimension: a private road that is also a
 * dead-end is both at once, and a union forces a choice that loses the handoff
 * geometry. Access lives in `LegalBands.access` (per segment, resolved by
 * position) and physical closure lives in `PhysicalBarrier` below.
 *
 * Two further reasons this is not a shape. A private way is explicitly not
 * impassable — a commissioned delivery is exactly the permitted case — so a
 * terminal-looking kind misstates it. And "forbidden to this class" depends on
 * the vehicle, which has no business appearing in a truck-agnostic stage.
 */
export type TerminalTopology =
  | { readonly kind: 'THROUGH'; readonly continuity: Continuity }
  | {
      readonly kind: 'DEAD_END';
      readonly turnaround: Fact<Turnaround>;
      readonly entryDirection: Fact<OneWayConstraint>;
    }
  | {
      readonly kind: 'TERMINAL_LOOP';
      readonly turnaround: Fact<Turnaround>;
      readonly entryDirection: Fact<OneWayConstraint>;
    };

/**
 * A physical object that can make a topologically through street impassable.
 * The mirror of the false dead-end, and the more dangerous of the two: the
 * truck arrives, cannot pass, and the report said it could.
 */
export interface PhysicalBarrier {
  readonly kind: 'bollard' | 'gate' | 'chicane' | 'retractable_post' | 'height_frame' | 'block';
  readonly at: GeoPoint;
  readonly passable: 'no' | 'conditional' | 'unknown';
}

export type EgressCandidateKind =
  | 'turning_circle'
  | 'turning_loop'
  | 'roundabout'
  | 'parking'
  | 'junction'
  | 'square'
  | 'field_entrance'
  | 'driveway_pair';

/** Who owns the ground. Geometry and right of use are separate questions. */
export type GroundOwnership = 'public' | 'private' | 'unknown';

/**
 * How a place is reached from the stop: `inside` by road without
 * passing through the impasse mouth — a place of THIS impasse; `via_mouth` by
 * road only through the mouth — another street's place, « demi-tour
 * ailleurs », never this one; `unknown` when no mouth was resolved, or when the
 * place is not on the road graph at all (a surface polygon, a circle drawn on
 * a footway).
 */
export type EgressReach = 'inside' | 'via_mouth' | 'unknown';

export interface UsableSurface {
  readonly usableDiameterM: number;
  readonly areaM2: number | null;
  readonly polygon: readonly GeoPoint[] | null;
  /**
   * Occupancy seen on the imagery — an empty circle and a parked-full one are
   * not the same surface. Three-valued because absence is a shape: before any
   * imagery has spoken, `unassessed` is the only honest answer, and a boolean
   * would force a comfortable `false` — the exact defect class this domain
   * exists to close.
   */
  readonly occupancy: 'obstructed' | 'clear' | 'unassessed';
  /**
   * the centre of the inscribed circle the diameter was measured on,
   * when there is one. It was dropped on the way from `Turnaround` to the
   * candidate, so a loop or a surface option could only be placed on its first
   * vertex. Optional: absent where nothing was measured, and on older facts.
   */
  readonly centre?: GeoPoint;
}

export interface EgressCandidate {
  /**
   * Stable within a run and readable by a human: `node:<osm id>`, `way:<id>`,
   * `surface:<id>`, `stop:carriageway`. A `PointRef` rounded to 4 decimals
   * would merge two places 11 m apart (S1-S2, piège 22).
   */
  readonly id: string;
  readonly kind: EgressCandidateKind;
  readonly at: GeoPoint;
  /** As the crow flies. Kept for the radius filter and the explain tab. */
  readonly distanceFromStopM: number;
  /**
   * Metres BY ROAD from the stop. Null when the place is not on the
   * road graph — a surface polygon — never a guess.
   */
  readonly roadDistanceFromStopM: number | null;
  /**
   * How the place is reached from the stop: inside the impasse, only through
   * its mouth (another street's place — « demi-tour ailleurs »), or unknown
   * (no mouth resolved, or not on the graph). Sèvremoine, run bf60317d: the
   * loop of the next street was taken for this impasse's turnaround.
   */
  readonly reach: EgressReach;
  /** True when reaching it means driving further into the dead-end before coming back. */
  readonly beyondStop: boolean;
  readonly geometry: Fact<UsableSurface>;
  readonly ground: GroundOwnership;
  /** Reversing needed to use it, metres. Compared against the driving policy. */
  readonly requiresReversingM: number;
}

export interface TopologyAssessment {
  readonly topology: TerminalTopology;
  readonly barriers: readonly Fact<PhysicalBarrier>[];
  /**
   * Where the truck hands off to the public network when it cannot reach the
   * door itself — the impasse mouth, or the public-road start of a private way.
   *
   * Held here rather than on `DEAD_END` because a private *through* path needs
   * the same handoff, and because it makes one policy distance govern both.
   */
  readonly handoff: Fact<Mouth>;
  /**
   * Wrapped so that "we searched and found nothing" and "we never searched"
   * are different answers. An empty array cannot say which.
   */
  readonly egressCandidates: Fact<readonly EgressCandidate[]>;
  /**
   * the fallback stop on the street before the impasse (« la rue
   * d'avant »), computed for every terminal shape and NEVER selected in the
   * operator's place (principe 10). Optional: an assessment built before the
   * field, or without the policy block, carries none — an absence, not a
   * « none found » (principe 14).
   */
  readonly fallbackStop?: Fact<FallbackStop>;
  /**
   * the reversing path out of the impasse, from the delivery point
   * to the mouth, MEASURED and never judged (principe 39, D1 option 3 : « une
   * question, jamais un verdict »). Same shape as `fallbackStop` just above:
   * optional, absent without the policy block (`assessment.reversing`) and on
   * every assessment built before the field — an absence, not a « none
   * found » (principe 14).
   */
  readonly reversing?: Fact<ReversingPath>;
  /**
   * the geometry the turnaround map draws: the delivery street's axis
   * from the mouth to the tip, the stop on it, and the branches that leave it
   * (junctions, driveways, entrances) with their side and angle. Optional:
   * absent without the policy block, `not_applicable` on a through street.
   * Read from the neighbourhood already fetched; never a verdict.
   */
  readonly impasseGeometry?: Fact<ImpasseGeometry>;
  /**
   * Radius the topology was resolved within, and whether the terminal node was
   * provably interior to it. A degree-1 node at the edge of the fetch is not
   * evidence of a dead-end; a fixed inner ratio trades one false class for
   * another, so the resolution records its own reach.
   */
  readonly resolvedWithinM: number;
  readonly terminalNodeInterior: boolean;
}

/**
 * CE QU'UNE BARRIÈRE FAIT DE LA RUE DE LIVRAISON — la seule lecture, pour ses
 * deux consommateurs (constat L4-3).
 *
 * `assessTopology` classait déjà les barrières prudemment (`barrier=bollard`
 * fixe → `passable: 'no'`, un portail sans mention d'accès → `'unknown'`,
 * jamais ouvert) et personne ne les lisait : ni le fil de l’API, ni aucun
 * verdict, et `assessObviousStop` déclarait « arrêt évident » par-dessus une
 * borne relevée. Le module le disait lui-même : « worse than a false dead end,
 * because the truck arrives and the report said it would pass. »
 *
 * TROIS ÉTATS, et le troisième est celui que le principe 5 impose :
 *
 *  - `none` — rien d'accroché, ou seulement des barrières `conditional` (borne
 *    escamotable, chicane, gabarit) : le camion passe sous condition, et ce
 *    n'est pas ici qu'on en décide ;
 *  - `blocked` — une barrière infranchissable MESURÉE. Un refus est alors
 *    fondé. Aucun producteur ne rend `basis: 'measured'` aujourd'hui (les
 *    barrières viennent des tags OSM) : cet état existe pour le jour où une
 *    vision la verra, comme `VISION_PHYSICAL_BARRIER` dans l'engine ;
 *  - `doubtful` — une barrière infranchissable seulement DÉCLARÉE, ou dont la
 *    franchissabilité n'est pas établie. C'est une QUESTION, jamais un refus :
 *    même règle que `declared_width_cannot_refuse`, et même règle que l'engine,
 *    dont `OSM_BARRIER_PHYSICAL` porte `hardNo: false` (« barrier nodes on
 *    SERVICE ways should not be treated as hard-NO »).
 *
 * La plus fermante gagne : `blocked` avant `doubtful` avant `none`.
 */
export type BarrierClosure =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'blocked' | 'doubtful';
      readonly barrier: PhysicalBarrier;
      /** Le code du tag relevé (`barrier_bollard`…) puis ce qu'on en conclut. */
      readonly reasonCodes: readonly string[];
    };

export function readBarrierClosure(
  barriers: readonly Fact<PhysicalBarrier>[] | undefined,
): BarrierClosure {
  let held: BarrierClosure = { kind: 'none' };
  for (const fact of barriers ?? []) {
    if (!fact.known) continue;
    const closure = closureOf(fact.value, fact.reliability);
    if (closure.kind === 'blocked') return closure;
    if (closure.kind === 'doubtful' && held.kind === 'none') held = closure;
  }
  return held;
}

function closureOf(
  barrier: PhysicalBarrier,
  reliability: { readonly basis: string; readonly reasonCodes: readonly string[] },
): BarrierClosure {
  const tagCodes = reliability.reasonCodes;
  if (barrier.passable === 'unknown') {
    return { kind: 'doubtful', barrier, reasonCodes: [...tagCodes, 'barrier_passability_unknown'] };
  }
  if (barrier.passable !== 'no') return { kind: 'none' };
  // Infranchissable — mais une barrière que personne n'a vue ne condamne pas
  // une adresse (principe 5). Le code le dit, pour que l'écran puisse le dire.
  return reliability.basis === 'measured'
    ? { kind: 'blocked', barrier, reasonCodes: [...tagCodes, 'barrier_impassable'] }
    : {
        kind: 'doubtful',
        barrier,
        reasonCodes: [...tagCodes, 'barrier_impassable', 'declared_barrier_cannot_refuse'],
      };
}

// ---------------------------------------------------------------------------
// l'arrêt de repli : livrer avant d'entrer dans l'impasse
// ---------------------------------------------------------------------------

/**
 * Where the walk from the fallback stop to the door lands (principe 10,
 * completed 2026-09-24, D3 ): up to `plainMaxM` the stop is
 * proposed as it is; up to `portageMaxM` it is proposed with the portage said
 * in clear (« 120 m de portage, à confirmer avec le client »); beyond, the
 * street before the impasse is said absent. The two numbers are policy
 * (`assessment.fallbackStop`), recorded with the answer.
 */
export type FallbackStopBand = 'plain' | 'portage' | 'beyond';

/**
 * The walk, metres, ALONG THE CARRIAGEWAY AXIS, in three legs that add up.
 *
 * What it is not (principe 14): not a routed footway — a shortcut for a
 * pedestrian, a wall between the two streets, the crossing of the parent
 * street and the pavement are all uncounted. Two of the three legs are the
 * engine's own measure (`distanceFromStopM`, along the impasse from the mouth,
 * décision produit, 2026-07-07); the third is the door's offset from the axis as the
 * geocoder posed the point. The sum is therefore a floor for a walk that
 * follows the road, and an approximation for one that does not.
 */
export interface FallbackWalk {
  /** A — from the fallback stop to the mouth node, along the parent street. */
  readonly stopToMouthM: number;
  /** B — from the mouth to the delivery point's projection, along the impasse (`Mouth.distanceFromStopM`). */
  readonly mouthToPointM: number;
  /** C — from that projection to the delivery point itself, straight. */
  readonly pointToAxisM: number;
  readonly totalM: number;
  /**
   * the line those metres were counted on, stop first, door last:
   * A along the parent street, B the handoff's own chain walked back from the
   * mouth (the reversing path, reversed), C straight to the door. Its length is
   * `totalM` to the metre. Null when the chain cannot be laid back on the
   * carriageway (the reversing's `path_not_resolved`): the metres stand, the
   * line is not drawn rather than guessed (principe 14).
   */
  readonly path: readonly GeoPoint[] | null;
}

/** The street the fallback stop sits on, as the graph describes it. */
export interface FallbackStopStreet {
  readonly segmentId: string;
  readonly name: string | null;
  /** The raw `highway` class, for « une allée de service seulement s'il n'y a rien d'autre ». */
  readonly highway: string | null;
  readonly declaredWidthM: number | null;
  readonly laneCount: number | null;
  /** True when the source declares a direction of travel. */
  readonly oneWay: boolean;
  readonly isPrivate: boolean;
  readonly importance: number | null;
}

export interface FallbackStop {
  /** Where the truck would stop: on the parent street, `stopToMouthM` before the junction. */
  readonly stopAt: GeoPoint;
  /** The mouth the stop is measured from (`Mouth.point`). */
  readonly mouth: GeoPoint;
  readonly street: FallbackStopStreet;
  readonly walk: FallbackWalk;
  readonly band: FallbackStopBand;
  /** The policy bands the answer was classed against, recorded with it. */
  readonly bandsM: { readonly plainMaxM: number; readonly portageMaxM: number };
  /** Physical closures read on the parent street near the stop, as S1 classes them. */
  readonly barriers: readonly Fact<PhysicalBarrier>[];
  /** Nesting depth of the mouth (`Mouth.depth`): 0 when the parent is the street at the junction. */
  readonly depth: number;
}

// ---------------------------------------------------------------------------
// la marche arrière : reculer de l'arrêt jusqu'à la bouche
// ---------------------------------------------------------------------------

/**
 * The provenance method of a reversing fact whose path could not be laid back
 * on the carriageway — the mouth is known, the metres are known, the line is
 * not. Named so the wire can say `path_not_resolved` rather than `no_mouth`:
 * `UnknownReason` is the system-wide vocabulary and has no word for it, and
 * the method is how an unknown already says what was tried
 * (`turnaround-mapped-only-via-mouth`).
 */
export const REVERSING_PATH_NOT_RESOLVED = 'reversing-path-not-resolved';

/** The narrowest width a source DECLARES along the path — who said it is the fact's provenance. */
export interface ReversingWidth {
  readonly widthM: number;
  /** The way that declares it. */
  readonly segmentId: string;
}

/**
 * The reversing manoeuvre measured on the carriageway axis (D5 of
 * ). No rule of feasibility lives here, and none exists to port
 * (principe 29): the engine never reversed (« reverse-axis egress rejected
 * (décision produit) », 2026-06-16), and the only trace it left is « semi cannot reverse
 * out » in its eval set. What is here is what the operator needs to choose —
 * how long, how straight, how wide, where it comes out.
 */
export interface ReversingPath {
  /** The delivery point projected onto the delivery street: where the truck starts reversing. */
  readonly from: GeoPoint;
  /** The mouth (`Mouth.point`): where it drives out forward. */
  readonly to: GeoPoint;
  /**
   * The carriageway axis from `from` to `to`, EXACTLY the chain the handoff
   * walked to measure `Mouth.distanceFromStopM` — not a second route found by
   * another algorithm, so the line and the number cannot disagree.
   */
  readonly path: readonly GeoPoint[];
  /** = `Mouth.distanceFromStopM`: one number, one source (principe 23). */
  readonly lengthM: number;
  /** The sharpest heading change between two successive non-degenerate segments of `path`, degrees. */
  readonly maxDeflectionDeg: number;
  /**
   * Whether the screen may say « ligne droite »: no bend sharper than
   * `straightMaxDeflectionDeg`, AND a chord (end to end) of at least
   * cos(threshold) × the length — ten 9° bends make a quarter turn with no
   * single one over 15°. A DISPLAY threshold, not a feasibility one.
   */
  readonly straight: boolean;
  /** The policy threshold `straight` was read against, recorded with the answer. */
  readonly straightMaxDeflectionDeg: number;
  /** Unknown (`no_data`) when no way crossed declares a width — never a 0 (principe 14). */
  readonly narrowestWidth: Fact<ReversingWidth>;
  /** Name of the street it comes out onto (the mouth's parent way); null when the source names none. */
  readonly exitsOnto: string | null;
  /** Nesting depth of the mouth (`Mouth.depth`). */
  readonly depth: number;
}

// ---------------------------------------------------------------------------
// la géométrie de l'impasse que la carte du demi-tour dessine
// ---------------------------------------------------------------------------

/**
 * The provenance method of an impasse geometry whose ENTRY DIRECTION could not
 * be established — no usable mouth, and the chain proven closed at both ends
 * or at neither. The axis exists, but which side of it a branch is on means
 * nothing without the direction the truck comes in; an unknown, said, rather
 * than a direction picked at random (principe 14).
 */
export const IMPASSE_AXIS_ORIENTATION_UNKNOWN = 'impasse-axis-orientation-unknown';

/** A branch leaving the delivery street, read in the neighbourhood already loaded (la note de conception interne). */
export interface ImpasseBranch {
  /**
   * 'branch:<nodeId>:<wayId>@<cap>' — `<cap>` the departure bearing of the arm,
   * whole degrees clockwise from north [0, 360). A way that crosses the axis
   * leaves the node in two directions, each its own branch: the cap keeps
   * the two ids apart.
   */
  readonly id: string;
  readonly nodeId: string;
  /** The junction node, on the axis. */
  readonly at: GeoPoint;
  /** Metres along the axis from the stop's projection: negative towards the mouth, positive towards the tip. */
  readonly alongFromStopM: number;
  /** The driver's side, in the direction of ENTRY (from the mouth towards the tip). */
  readonly side: 'left' | 'right';
  /** 0–180: the angle between the entry direction and the branch's departure. */
  readonly angleDeg: number;
  readonly wayId: string;
  readonly highway: string | null;
  readonly service: string | null;
  readonly name: string | null;
  readonly declaredWidthM: number | null;
  readonly oneWay: boolean;
  readonly isPrivate: boolean;
  /** Length of the branch way from the node, within the neighbourhood. */
  readonly lengthM: number;
  /** The junction the handoff named the mouth. */
  readonly isMouth: boolean;
}

export interface ImpasseGeometry {
  /**
   * The delivery street's axis, oriented from the mouth to the tip (the
   * handoff's geometric chain), cut at the entry when one is known: the chain
   * may carry on past it, across the mouth's crossroads, and that is not the
   * impasse.
   */
  readonly axis: readonly GeoPoint[];
  /** Abscissa of the stop's projection along `axis`. */
  readonly stopAlongM: number;
  /**
   * True when an entry is known — the mouth, or the junction with the nested
   * pocket — and `axis[0]` is that entry, even when a closed tip gave the
   * direction (the stop on a mouth in the middle of the chain:
   * `axis_oriented_by_closed_tip`). False without a mouth: nothing is cut,
   * and `axis[0]` is only where the chain stopped being read, not a known
   * entrance (principe 14). The reason codes say where the direction came
   * from, not where the axis starts: never derive this field from them.
   */
  readonly startsAtEntry: boolean;
  /** The closed tip; null when it is not proven inside the neighbourhood. */
  readonly tip: GeoPoint | null;
  /** Ordered by abscissa. */
  readonly branches: readonly ImpasseBranch[];
  /**
   * Branches are read within this many metres of the stop along the axis, both
   * ways (policy `maxBranchAlongM`). Beyond it, none was read — which is not
   * « none » (principe 14).
   */
  readonly branchesReadWithinM: number;
}
