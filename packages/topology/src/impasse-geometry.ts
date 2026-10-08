/**
 * S1 quater — LA GÉOMÉTRIE DE L'IMPASSE que la carte du demi-tour dessine.
 *
 * Ce que la carte montre (la note de conception interne et §7.1) : l'axe de
 * la rue de livraison, l'arrêt dessus, le bout fermé, et les BRANCHES qui en
 * partent — carrefour, allée, entrée de lot — avec leur côté et leur angle,
 * parce que l'empreinte du trois temps s'accroche à l'axe et se met du côté de
 * la branche (« le côté suit la branche quand il y en a une »). Ce module ne
 * fait que LIRE le voisinage déjà chargé : aucune règle, aucun verdict
 * (principe 39 : « le cercle n'est pas un verdict » ; la géométrie non plus).
 *
 * UNE SOURCE PAR OBJET (principe 23) :
 *  - l'axe est la chaîne que le handoff a parcourue pour mesurer la bouche
 *    (`HandoffWalk.street`), jamais une seconde lecture de la rue ;
 *  - le bout fermé est celui que le handoff prouve (`closedTipAt*`) ;
 *  - les bras d'un carrefour sont ceux que la classification terminale lit
 *    (`drivableArmsAt`, `continuity.ts`), restreints aux chaussées du handoff
 *    (`isCarriageway`) — l'axe et ses branches parlent le même vocabulaire.
 *
 * LE SENS D'ENTRÉE est celui dans lequel le camion arrive : de la bouche vers le
 * bout. La bouche le donne (le premier tronçon du handoff part de l'arrêt vers
 * elle) ; sans bouche, le bout fermé le donne quand UN SEUL des deux bouts de la
 * chaîne est prouvé fermé — et la raison le dit. Sinon le sens n'est pas connu,
 * et le côté d'une branche n'a pas de sens : inconnue dite
 * (`IMPASSE_AXIS_ORIENTATION_UNKNOWN`), jamais un sens tiré au sort (principe 14).
 *
 * LE CÔTÉ se calcule dans un repère PLAN est/nord (x vers l'est, y vers le nord,
 * sens trigonométrique) : le produit vectoriel entrée × bras est positif quand
 * le bras part à GAUCHE du conducteur. Piège : `packages/swept-path` a y vers le
 * BAS, où le même signe veut dire l'inverse ; ici on est en lat/lon, nord en haut.
 *
 * Pur : mêmes entrées, même réponse.
 */
import {
  IMPASSE_AXIS_ORIENTATION_UNKNOWN,
  type Fact,
  type GeoPoint,
  type ImpasseBranch,
  type ImpasseGeometry,
  type SourceId,
  type TerminalTopology,
} from '@teneolog/domain';

import { departureBearingDeg, drivableArmsAt, type DrivableArm } from './continuity.js';
import { haversineM } from './geometry.js';
import {
  chainPassesAgainAt,
  isCarriageway,
  type HandoffLeg,
  type HandoffStreet,
  type HandoffWalk,
} from './handoff.js';
import type { RoadNeighbourhood, RoadWay } from './ports.js';

/** Policy: `pipeline.assessment.impasseGeometry`. */
export interface ImpasseGeometryParams {
  /** Branches are listed up to this many metres from the stop, along the axis, both ways. */
  readonly maxBranchAlongM: number;
}

export interface ImpasseGeometryInput {
  readonly neighbourhood: RoadNeighbourhood;
  readonly topologyKind: TerminalTopology['kind'];
  /** The walk S1 resolved: the delivery street, the mouth and the legs to it. */
  readonly handoff: HandoffWalk;
  readonly params: ImpasseGeometryParams;
  readonly fetchedAt: string;
}

const METHOD = 'impasse-geometry-along-handoff';

/**
 * `drivableArmsAt` leaves out one way; the axis may be several (a street split
 * at every change of name), so none is left out there and all the axis ways
 * are set aside by the caller.
 */
const NO_EXCLUDED_WAY = '';

/** Where the truck enters the delivery street, when the walk says it. */
interface Entry {
  /**
   * Where the walk left the delivery street — the mouth at depth 0, the
   * junction with the nested pocket deeper — in the chain's own abscissa. The
   * axis starts there. Null without a mouth: no entrance is known, nothing is cut.
   */
  readonly entryAlongM: number | null;
  /** The mouth node, when it is on the delivery street itself (depth 0). */
  readonly mouthNodeId: string | null;
}

/** How the entry direction was established — and so how far the sides can be trusted. */
interface Orientation extends Entry {
  /** True when the chain runs from the tip towards the mouth, and must be turned round. */
  readonly reversed: boolean;
  readonly confidence: number;
  readonly reasonCodes: readonly string[];
}

const NO_ENTRY: Entry = { entryAlongM: null, mouthNodeId: null };

/** The chain turned so that it runs from the mouth to the tip, from the entry on. */
interface OrientedAxis {
  readonly nodeIds: readonly string[];
  readonly points: readonly GeoPoint[];
  readonly alongM: readonly number[];
  readonly stopAlongM: number;
  readonly tip: GeoPoint | null;
  readonly wayIds: ReadonlySet<string>;
}

export function computeImpasseGeometry(input: ImpasseGeometryInput): Fact<ImpasseGeometry> {
  // A through street has no impasse to draw: not applicable, which is not
  // « looked for, none » (principe 14).
  if (input.topologyKind === 'THROUGH') return { known: false, why: 'not_applicable' };
  const { street } = input.handoff;
  if (street === null) return { known: false, why: 'no_data' };

  const source = sourceOf(street, input.neighbourhood);
  const orientation = orient(street, input.handoff, input.neighbourhood);
  if (orientation === null) {
    return {
      known: false,
      why: 'no_data',
      provenance: { source, method: IMPASSE_AXIS_ORIENTATION_UNKNOWN, fetchedAt: input.fetchedAt },
    };
  }

  const axis = orientedAxis(street, orientation);
  const value: ImpasseGeometry = {
    axis: axis.points,
    stopAlongM: axis.stopAlongM,
    startsAtEntry: orientation.entryAlongM !== null,
    tip: axis.tip,
    branches: branchesOf(axis, orientation.mouthNodeId, input),
    branchesReadWithinM: input.params.maxBranchAlongM,
  };
  return {
    known: true,
    value,
    provenance: { source, method: METHOD, fetchedAt: input.fetchedAt },
    reliability: {
      confidence: orientation.confidence,
      basis: 'derived',
      reasonCodes: [...orientation.reasonCodes, ...(axis.tip === null ? ['impasse_tip_not_proven'] : [])],
    },
  };
}

/**
 * The entry direction. The mouth first: the handoff's first leg runs along the
 * delivery street from the stop to where the walk left it — the mouth itself
 * at depth 0, the junction with the nested pocket deeper — so the truck comes
 * in from that end. Without a leg that says it, a single proven closed tip
 * says where the street ends, hence where it is entered from. Null otherwise.
 */
function orient(street: HandoffStreet, handoff: HandoffWalk, hood: RoadNeighbourhood): Orientation | null {
  const { mouth, legs } = handoff;
  const first = legs?.[0];
  if (!mouth.known || first === undefined) return byClosedTip(street, NO_ENTRY, mouth.known);
  const nested = mouth.value.depth > 0;
  // Known even when it does not give the direction: its arms stay the mouth.
  const entry: Entry = {
    entryAlongM: first.toAlongM,
    mouthNodeId: nested ? null : mouthNodeOf(street, first.toAlongM, mouth.value.parentSegmentId, hood),
  };
  const reversed = awayFromEntry(street, first);
  if (reversed === null) return byClosedTip(street, entry, true);
  return {
    reversed,
    ...entry,
    confidence: mouth.reliability.confidence,
    reasonCodes: [nested ? 'axis_oriented_from_nested_mouth' : 'axis_oriented_from_mouth'],
  };
}

/**
 * Whether the chain must be turned round for the truck to run away from the
 * entry: the first leg runs from the stop to the entry. A leg of zero length —
 * the stop projects onto the entry itself — still says it when the entry is
 * an end of the chain that the chain does not pass again: the street leaves it
 * one way only. `toAlongM` is a vertex abscissa copied from the chain, so the
 * equalities are exact. Null when the street leaves the entry both ways: an
 * interior entry under the stop, and an end the chain passes again — a ring's
 * closing node, a « P »'s neck (`chainPassesAgainAt`, the walk's own test), where
 * the head-or-tail answer would only be the direction the way was drawn in.
 */
function awayFromEntry(street: HandoffStreet, first: HandoffLeg): boolean | null {
  if (first.toAlongM !== first.fromAlongM) return first.toAlongM > first.fromAlongM;
  const { nodeIds, alongM } = street;
  const oneWayEndAt = (index: number): boolean =>
    first.toAlongM === alongM[index] && !chainPassesAgainAt(nodeIds, index);
  if (oneWayEndAt(0)) return false;
  if (oneWayEndAt(nodeIds.length - 1)) return true;
  return null;
}

/** The street is entered from its only open end, when exactly one end is a proven closed tip. */
function byClosedTip(street: HandoffStreet, entry: Entry, mouthKnown: boolean): Orientation | null {
  if (street.closedTipAtHead === street.closedTipAtTail) return null;
  return {
    reversed: street.closedTipAtHead,
    ...entry,
    // The proof is the tip's, which the walk establishes as firmly as a
    // junction (confidence 1).
    confidence: 1,
    reasonCodes: [mouthKnown ? 'axis_oriented_by_closed_tip' : 'axis_oriented_by_closed_tip_no_mouth'],
  };
}

/**
 * The mouth node on the chain: at the abscissa the walk stopped at, and on the
 * parent way it named — the abscissa alone would pick the wrong one of two
 * coincident vertices.
 */
function mouthNodeOf(
  street: HandoffStreet,
  alongM: number,
  parentWayId: string,
  hood: RoadNeighbourhood,
): string | null {
  const onParent = new Set(hood.nodes.filter((n) => n.wayIds.includes(parentWayId)).map((n) => n.id));
  return street.nodeIds.find((id, i) => street.alongM[i] === alongM && onParent.has(id)) ?? null;
}

/**
 * The chain turned so that it runs from the mouth to the tip, and cut at the
 * entry: the chain may carry on past it — a street continuing straight across
 * the mouth's crossroads, one way drawn through it — and that stretch is not
 * the impasse. Abscissae are measured from the entry; the stop always lies
 * past it (the first leg runs from the stop to the entry), and so does the
 * far end. The ways of the stretch cut off do not become branches.
 */
function orientedAxis(street: HandoffStreet, orientation: Orientation): OrientedAxis {
  const { reversed, entryAlongM } = orientation;
  const totalM = street.alongM[street.alongM.length - 1] ?? 0;
  const oriented = (a: number): number => (reversed ? totalM - a : a);
  const startM = entryAlongM === null ? 0 : oriented(entryAlongM);
  const order = street.nodeIds.map((_, i) => i);
  if (reversed) order.reverse();
  const kept = order.flatMap((i) => {
    const nodeId = street.nodeIds[i];
    const point = street.points[i];
    const alongM = street.alongM[i];
    if (nodeId === undefined || point === undefined || alongM === undefined) return [];
    return oriented(alongM) >= startM ? [{ nodeId, point, alongM: oriented(alongM) - startM }] : [];
  });
  const points = kept.map((v) => v.point);
  const closedFarEnd = reversed ? street.closedTipAtHead : street.closedTipAtTail;
  return {
    nodeIds: kept.map((v) => v.nodeId),
    points,
    alongM: kept.map((v) => v.alongM),
    stopAlongM: oriented(street.stopAlongM) - startM,
    tip: closedFarEnd ? (points[points.length - 1] ?? null) : null,
    wayIds: new Set(street.wayIds),
  };
}

/**
 * Every arm that leaves the axis within `maxBranchAlongM` of the stop, ordered
 * by abscissa then id. A way that crosses the axis offers two arms, each its
 * own branch; the heading in the id keeps them apart. Two arms of one way
 * leaving one node within half a degree of each other are one direction of
 * travel, kept once.
 */
function branchesOf(
  axis: OrientedAxis,
  mouthNodeId: string | null,
  input: ImpasseGeometryInput,
): readonly ImpasseBranch[] {
  const wayIdsByNode = new Map(input.neighbourhood.nodes.map((n) => [n.id, n.wayIds]));
  const byId = new Map<string, ImpasseBranch>();
  axis.nodeIds.forEach((nodeId, i) => {
    const alongM = axis.alongM[i];
    const at = axis.points[i];
    if (alongM === undefined || at === undefined) return;
    const alongFromStopM = alongM - axis.stopAlongM;
    if (Math.abs(alongFromStopM) > input.params.maxBranchAlongM) return;
    // Cheap first: a node only the axis passes through has no branch.
    if ((wayIdsByNode.get(nodeId) ?? []).every((id) => axis.wayIds.has(id))) return;
    const entry = entryDirectionAt(axis.points, i);
    if (entry === null) return;
    for (const arm of drivableArmsAt(input.neighbourhood, nodeId, NO_EXCLUDED_WAY)) {
      if (axis.wayIds.has(arm.way.id) || !isCarriageway(arm.way)) continue;
      const branch = branchOf({ arm, nodeId, at, alongFromStopM, entry, isMouth: nodeId === mouthNodeId });
      if (!byId.has(branch.id)) byId.set(branch.id, branch);
    }
  });
  return [...byId.values()].sort(
    (a, b) => a.alongFromStopM - b.alongFromStopM || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/** A direction in the east/north plane, unit length: `e` towards the east, `n` towards the north. */
interface PlaneVector {
  readonly e: number;
  readonly n: number;
}

/** A bearing (clockwise from north) as a unit vector in the east/north plane. */
function planeOf(bearingDeg: number): PlaneVector {
  const r = (bearingDeg * Math.PI) / 180;
  return { e: Math.sin(r), n: Math.cos(r) };
}

/**
 * The entry direction at vertex `i` of the oriented axis: the tangent — the
 * bisector of the heading arriving at the node and the heading leaving it —
 * so a branch at a bend is read against the street at the bend, not against
 * one of its two sides. At either end only one heading exists and is the
 * tangent; on a hairpin, where the two cancel out, the arriving one is kept.
 */
function entryDirectionAt(points: readonly GeoPoint[], i: number): PlaneVector | null {
  const back = departureBearingDeg(points, i, -1);
  const onward = departureBearingDeg(points, i, 1);
  const arriving = back === null ? null : planeOf((back + 180) % 360);
  const leaving = onward === null ? null : planeOf(onward);
  if (arriving === null || leaving === null) return arriving ?? leaving;
  const sum = { e: arriving.e + leaving.e, n: arriving.n + leaving.n };
  const norm = Math.hypot(sum.e, sum.n);
  return norm < 1e-9 ? arriving : { e: sum.e / norm, n: sum.n / norm };
}

/**
 * The driver's side of `arm`, and its angle to the entry direction, both in
 * the east/north plane (x east, y north, anticlockwise positive): the cross
 * product entry × arm is positive when the arm leaves to the LEFT. An arm
 * exactly ahead or behind has no side; it reads `right`, and its angle (0 or
 * 180) says why.
 */
function sideAndAngle(entry: PlaneVector, armBearingDeg: number): Pick<ImpasseBranch, 'side' | 'angleDeg'> {
  const arm = planeOf(armBearingDeg);
  const cross = entry.e * arm.n - entry.n * arm.e;
  const dot = entry.e * arm.e + entry.n * arm.n;
  return {
    side: cross > 0 ? 'left' : 'right',
    angleDeg: (Math.atan2(Math.abs(cross), dot) * 180) / Math.PI,
  };
}

interface ArmAtNode {
  readonly arm: DrivableArm;
  readonly nodeId: string;
  readonly at: GeoPoint;
  readonly alongFromStopM: number;
  readonly entry: PlaneVector;
  readonly isMouth: boolean;
}

function branchOf({ arm, nodeId, at, alongFromStopM, entry, isMouth }: ArmAtNode): ImpasseBranch {
  const { way } = arm;
  const capDeg = Math.round(arm.departureDeg) % 360;
  return {
    id: `branch:${nodeId}:${way.id}@${capDeg}`,
    nodeId,
    at,
    alongFromStopM,
    ...sideAndAngle(entry, arm.departureDeg),
    wayId: way.id,
    highway: way.tags['highway'] ?? null,
    service: way.tags['service'] ?? null,
    name: way.name,
    declaredWidthM: way.declaredWidthM,
    oneWay: way.oneWay !== 'no',
    isPrivate: way.isPrivate,
    lengthM: armLengthM(way, arm.index, arm.step),
    isMouth,
  };
}

/** The way's length from the node to its end, in the arm's direction, within the neighbourhood. */
function armLengthM(way: RoadWay, index: number, step: -1 | 1): number {
  let total = 0;
  for (let i = index; i + step >= 0 && i + step < way.geometry.length; i += step) {
    const a = way.geometry[i];
    const b = way.geometry[i + step];
    if (a !== undefined && b !== undefined) total += haversineM(a, b);
  }
  return total;
}

/** Who drew the axis: the first of its ways found in the neighbourhood. */
function sourceOf(street: HandoffStreet, hood: RoadNeighbourhood): SourceId {
  const first = street.wayIds[0];
  return hood.ways.find((w) => w.id === first)?.source ?? 'osm-overpass';
}
