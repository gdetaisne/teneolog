/**
 * S4 — Critical points.
 *
 * The places along a candidate where the answer can change. Measured
 * agnostically; the truck is applied later.
 */
import type { Fact } from './fact.js';
import type { GeoPoint, BearingDeg, FrameProvenance } from './geo.js';
import type { Width } from './constraints.js';
import type { PhysicalBarrier, UsableSurface } from './topology.js';

/**
 * The kinds of place that can change the answer.
 *
 * `TURNAROUND` is here because it is, in the field, the most frequent deciding
 * factor of all — "impasse, pas de possibilité de faire demi-tour en 19 t" is a
 * verdict, and it needs a scene, a human judgement and a named point like any
 * other. Measuring it inside the topology assessment alone left it unable to be
 * shown, reviewed, or named as the reason.
 *
 * There is deliberately no LOW_CLEARANCE: a height limit a source
 * declares for a segment is a legal band (`LegalBands.maxHeightM`, judged per
 * segment in S5 `legal.ts`), and no stage measures an overhead obstruction —
 * a cable, a porch, a canopy — so a point type for it would be a promise
 * nothing keeps. It returns with the imagery measurement that can produce it.
 *
 * There is deliberately no ENTRY or EXIT: those are roles of a leg, already
 * carried by `RouteCandidate.direction`, not places with a geometry.
 */
export type CriticalPointType =
  | 'TURN'
  | 'NARROW'
  | 'ROUNDABOUT'
  | 'TURNAROUND'
  | 'DESTINATION'
  /**
   * un tronçon que la carte
   * routière n'a pas rendu (`RouteCandidate.corridorUnread`), posé au MILIEU du
   * trou.
   *
   * Aucun type existant ne convenait, et aucun n'aurait dit la vérité : NARROW
   * affirme une largeur mesurée, TURN une déflexion, DESTINATION un lieu de
   * livraison. Ici il n'y a **aucune mesure** — c'est tout le propos — et le
   * type doit le dire, sinon l'écran fabriquerait une confiance (principe 14).
   *
   * Ce point n'est PAS produit par S4 : `collectCriticalPoints` ne le connaît
   * pas, aucun évaluateur de S5 ne le juge, il n'entre dans aucun classement.
   * Il est assemblé par le fil (l'API (hors instantané)) à partir des
   * tronçons non lus de la jambe, pour que le doute de corridor ait enfin un
   * lieu, une question et une réponse possible. Sa géométrie est un
   * `Fact` NON CONNU (`out_of_coverage`) : il n'y a rien à publier, et une
   * absence s'affiche comme une absence.
   */
  | 'UNREAD_SEGMENT';

/**
 * Stable identity of a point, derived from its location and type — never from
 * the run that found it.
 *
 * This is what lets a human answer outlive the run: the same corner, found
 * again next week by another analysis, carries the same reference and finds
 * the judgement already recorded against it.
 */
export type PointRef = string;

/**
 * Which of the four objects this is (restoring the June 2026
 * taxonomy): a **junction turn**, where ways meet and the vehicle pivots, or a
 * **curve**, which is steered through. They are not the same difficulty and
 * are not judged by the same rule — S5 asks a junction turn for the swept
 * width of its angle, and a curve for the off-tracking at its radius.
 */
export type TurnKind = 'junction' | 'curve';

export interface TurnGeometry {
  readonly apex: GeoPoint;
  readonly kind: TurnKind;
  /**
   * NET change of heading across the manoeuvre — the bearing going in against
   * the bearing coming out — never the sum of the vertex deflections.
   *
   * Summing turned a 42° bend into "128°" (Thairé) because a street debouching
   * inside the window added its own kink; that phantom angle then fixed the
   * worst margin of every plan of the run.
   */
  readonly deflectionDeg: number;
  readonly approachBearingDeg: BearingDeg;
  readonly exitBearingDeg: BearingDeg;
  /** Arc the manoeuvre spans, bearing offsets included. */
  readonly arcLengthM: number;
  /**
   * Radius of the bend — chord / (2·sin(θ/2)) across the manoeuvre.
   *
   * `null` on a junction turn, and deliberately: what a router draws around a
   * corner is its own rounding of it, not a curvature the lorry follows.
   * Published as a measurement it yielded radii under a metre, read downstream
   * as carriageway margins ten metres in deficit. A corner is judged on its
   * angle and the width it opens onto; only a curve is judged on its radius.
   */
  readonly radiusM: number | null;
  /**
   * Distance back to the previous junction turn of the same leg, when they are
   * close enough to chain (rule R-S of June 2026: no room to recover between
   * two corners). `null` when there is none within reach.
   *
   * A FACT, for the ranking to weigh (principe 28) — not a penalty applied
   * here. S5 judges each manoeuvre on its own margin.
   *
   * Per LEG, and it has to be: chaining is what precedes a corner on the road
   * you are driving, and two legs meeting the same corner from different
   * streets have different answers. Since each leg keeps its own
   * (`CollectedPoints.geometryByCandidate`); `points[]` carries the first
   * finder's, like every other field of this geometry.
   */
  readonly chainedWithPreviousM: number | null;
  readonly approachWidth: Fact<Width>;
  readonly exitWidth: Fact<Width>;
}

export interface RoundaboutGeometry {
  readonly centre: GeoPoint;
  /**
   * Radius of the ring CENTRELINE (mean centroid-to-vertex distance of the
   * ring ways) — NOT the outer kerb, despite the name. It is the radius the
   * axle path follows, which is what off-tracking wants; compared against a
   * turning radius it errs towards refusal. Kept as `outerRadiusM` because
   * S5 and S7 read it under that name ( renames the local variables;
   * the field rename is a follow-up touching projection + scenes).
   */
  readonly outerRadiusM: number;
  /**
   * Radius of the central island, or `null` when nobody measured it. The
   * corridor data carries no island; kerb-to-kerb comes with imagery (S7).
   * Null is the only honest "unmeasured" — a 0 reads as an island of no size.
   */
  readonly innerRadiusM: number | null;
  /** Arms joined to the ring, or `null` when unknowable (inferred from a turn cluster). */
  readonly armCount: number | null;
  /** Angle actually swept by the manoeuvre, not the full ring. */
  readonly sweptAngleDeg: number;
  /**
   * Drivable width of the ring itself — the annulus the truck turns inside.
   *
   * Without it every roundabout on every route escalated to a human, because
   * the outer radius alone says nothing about whether the vehicle fits around
   * the island. Declared road widths answer it wherever the data carries them;
   * where they do not, this stays unknown and the escalation is the right
   * answer rather than an accident.
   */
  readonly ringWidthM: Fact<number>;
}

export interface NarrowGeometry {
  readonly width: Fact<Width>;
  readonly lengthM: number;
  /**
   * A physical object creating the constriction — a bus gate, a chicane, a pair
   * of bollards. Carried here rather than as its own point type because the
   * evaluation is identical: clear width against vehicle width.
   */
  readonly constriction: Fact<PhysicalBarrier> | null;
}

/** The manoeuvre space itself, wherever it was found along the dead-end. */
export interface TurnaroundGeometry {
  readonly surface: UsableSurface;
  /** Reversing the manoeuvre demands, compared against the driving policy. */
  readonly requiresReversingM: number;
  /** True when the space lies past the stop, so the truck drives on and comes back. */
  readonly beyondStop: boolean;
  readonly distanceFromStopM: number;
  /**
   * Whether the dead-end topology that produced this point was proven interior
   * to the fetch radius (VV1-06 / ). A non-interior terminal node sits
   * at the edge of the fetched graph: the dead-end might dissolve on a wider
   * fetch, so a refusal based on shape alone cannot be published.
   *
   * Reason code when false and verdict would be NO: `topology_unproven`.
   */
  readonly provenTopology: boolean;
}

export type PointGeometry =
  | { readonly type: 'TURN'; readonly geometry: TurnGeometry }
  | { readonly type: 'ROUNDABOUT'; readonly geometry: RoundaboutGeometry }
  | { readonly type: 'NARROW'; readonly geometry: NarrowGeometry }
  | { readonly type: 'TURNAROUND'; readonly geometry: TurnaroundGeometry }
  | {
      readonly type: 'DESTINATION';
      readonly width: Fact<Width>;
      /**
       * les barrières physiques de la rue de
       * livraison, recopiées de `StopConstraints.barriers` par
       * `collectCriticalPoints`. C'est par ce point, accroché à toutes les
       * jambes, que la fermeture d'une rue atteint un verdict.
       *
       * Optionnel : absent sur un instantané écrit avant ce champ, et une
       * absence n'est pas « aucune barrière » (principe 14).
       */
      readonly barriers?: readonly Fact<PhysicalBarrier>[];
    };

/** An image and the frame it is in, so anything drawn on it lands where it should. */
export interface ImageryEvidence {
  readonly imageRef: string;
  readonly frame: FrameProvenance;
  readonly capturedAt: string | null;
}

export interface CriticalPoint {
  readonly ref: PointRef;
  readonly type: CriticalPointType;
  readonly at: GeoPoint;
  readonly geometry: Fact<PointGeometry>;
  readonly evidence: readonly Fact<ImageryEvidence>[];
}
