/**
 * LES PORTES : où une rue locale quitte le réseau structurant.
 *
 * Portage de `axis-gate-discovery/{junction-evaluation,gate-candidates}.ts`
 * de l'engine (principe 29). Une porte est une JONCTION axe × rue locale :
 * `at` est le point sur l'axe, `inward` est le point à 20 m sur la branche
 * locale du côté de l'adresse — c'est de là que le routeur part
 * (`gateRoutingPoint`). Router depuis l'axe lui-même fait suivre l'axe à OSRM
 * puis faire demi-tour, ce que l'engine a payé (BUG-065, Angoulême).
 *
 * Les six filtres, mot pour mot ceux de `evaluateAxisLocalJunctionAttempts` :
 *
 *  1. le bout de la rue locale est à moins de 25 m de l'axe (sinon elle ne le
 *     rejoint pas) ;
 *  2. la branche quitte l'axe d'au moins 20° (sinon elle le longe) ;
 *  3. la branche part du côté de l'axe où se trouve l'adresse — le repère est
 *     l'AXE, pas le cap vers l'adresse : une jonction décalée le long de l'axe
 *     met une branche valide à plus de 90° de l'adresse ;
 *  4. la corde jonction → adresse ne traverse pas un AUTRE axe retenu (on ne
 *     pose pas une porte derrière une porte) ;
 *  5. la jonction est à moins de 1,2 × le rayon de l'étage ;
 *  6. la rue locale n'est pas privée, et — plus on s'éloigne, plus on est
 *     exigeant — n'est ni un chemin ni un sentier au-delà de 2 km, ni plus
 *     étroite que 3,2 m au-delà de 5 km.
 *
 * `towardDestinationDeg ≤ 90°` de l'engine n'est pas porté : l'engine lui-même
 * le note « kept for debug only — no longer gates the decision », remplacé par
 * le filtre 3. Le recopier serait recopier une règle morte.
 *
 * CE QU'ON CHANGE. L'engine refuse une rue qui déclare moins que le gabarit
 * `pl-19t` ; ici non — voir `legalForReference` plus bas. S3 ne connaît pas le
 * camion, c'est ce qui permet de rejouer les mêmes itinéraires pour trois
 * gabarits. Un inconnu n'est jamais un refus (principe 5), et un tonnage
 * déclaré est un fait pour S5, pas un filtre d'ancrage.
 */
import type { AxisCorridor, AxisGate, AxisGateRejected, GeoPoint } from '@teneolog/domain';
import { bearingDeg, haversineM, offsetPoint, type RoadWay } from '@teneolog/topology';

import {
  chordCrosses,
  localBearingDeg,
  nearestOn,
  sectorOf,
  SIDE_AMBIGUOUS_SIN,
  sideSign,
  undirectedDeltaDeg,
} from './axes-geometry.js';

/** Le bout de la rue locale doit toucher l'axe d'aussi près (engine : `LOCAL_AXIS_ENDPOINT_MAX_GAP_M`). */
export const LOCAL_ENDPOINT_MAX_GAP_M = 25;
/** Sous cet angle, la branche longe l'axe au lieu d'en partir (engine : `LOCAL_BRANCH_MIN_LEAVE_AXIS_DEG`). */
export const LOCAL_BRANCH_MIN_LEAVE_DEG = 20;
/** Le point d'entrée sur la branche locale (engine : `PORTAL_INWARD_CHORD_M`). */
export const INWARD_CHORD_M = 20;
/** Un sommet plus près que ça du bout ne donne pas de direction (engine : `LOCAL_AWAY_FROM_JUNCTION_MIN_M`). */
export const AWAY_MIN_M = 3;
/** En deçà, on garde les rues faibles : ce sont les derniers mètres. */
export const QUALITY_PERMISSIVE_MAX_M = 2_000;
/** Au-delà, une largeur connue sous ce seuil écarte la rue (engine : `FAR_ANCHOR_MIN_CARRIAGEWAY_WIDTH_M`). */
export const QUALITY_WEAK_SURFACE_MAX_M = 5_000;
export const FAR_MIN_WIDTH_M = 3.2;
/** Deux portes du même axe à moins de ça sont la même (engine : `ANCHOR_SITE_DEDUPE_M`). */
export const GATE_SITE_DEDUPE_M = 35;
/** Deux portes sur la même rue locale à moins de ça sont la même (engine : `ANCHOR_LOCAL_SEGMENT_DEDUPE_M`). */
export const GATE_LOCAL_DEDUPE_M = 50;

/** Les natures BD TOPO qu'on refuse loin de l'adresse (liste de l'engine). */
const WEAK_NATURE_FRAGMENTS = [
  'empierree',
  'sentier',
  'chemin',
  'escalier',
  'pieton',
  'piste cycl',
  'cyclable',
  'voie vert',
  'chemin de halage',
] as const;

export interface AxisGateInput {
  readonly stop: GeoPoint;
  readonly axes: readonly AxisCorridor[];
  /** Les tronçons d'axe, par identifiant — les géométries que les axes nomment. */
  readonly axisWays: ReadonlyMap<string, RoadWay>;
  /** Les rues locales candidates (importance 4–5), déjà filtrées par la source. */
  readonly localWays: readonly RoadWay[];
  readonly radiusM: number;
  readonly sectorCount: number;
}

export interface AxisGateResult {
  readonly gates: readonly AxisGate[];
  readonly rejected: readonly AxisGateRejected[];
}

/**
 * Toutes les portes des axes retenus, dédoublonnées, triées de la plus proche
 * à la plus lointaine — l'ordre que la sélection finale consomme.
 */
export function findAxisGates(input: AxisGateInput): AxisGateResult {
  const gates: AxisGate[] = [];
  const rejected: AxisGateRejected[] = [];

  const geometriesByAxisId = axisGeometries(input);
  for (const axis of input.axes) {
    // PORTAGE EXACT (principe 29) : l'engine teste la corde contre TOUS les
    // tronçons de TOUS les autres axes retenus (`retainedAxisSegments`, moins
    // `owningAxisSegmentIds`), pas contre une corde par axe. La première passe
    // ne regardait que `AxisCorridor.geometry` — la plus longue
    // corde d'UN tronçon — et laissait donc passer une porte posée derrière
    // les dix autres morceaux du même axe.
    const others = input.axes
      .filter((a) => a.id !== axis.id)
      .flatMap((a) => geometriesByAxisId.get(a.id) ?? []);
    for (const axisWayId of axis.wayIds) {
      const axisWay = input.axisWays.get(axisWayId);
      if (axisWay === undefined) continue;
      for (const localWay of input.localWays) {
        const attempt = evaluate({ input, axis, axisWay, localWay, others });
        if (attempt.gate !== null) gates.push(attempt.gate);
        else if (attempt.rejection !== null) rejected.push(attempt.rejection);
      }
    }
  }

  return { gates: dedupe(gates), rejected };
}

interface Attempt {
  readonly gate: AxisGate | null;
  readonly rejection: AxisGateRejected | null;
}

/** Une rue locale contre un tronçon d'axe : ses deux bouts, le meilleur gagne. */
function evaluate(params: {
  readonly input: AxisGateInput;
  readonly axis: AxisCorridor;
  readonly axisWay: RoadWay;
  readonly localWay: RoadWay;
  readonly others: readonly (readonly GeoPoint[])[];
}): Attempt {
  let best: Attempt = { gate: null, rejection: null };
  for (const end of endpointsOf(params.localWay)) {
    const attempt = evaluateEnd({ ...params, end });
    if (attempt.gate !== null) {
      if (best.gate === null || attempt.gate.distanceM < best.gate.distanceM) best = attempt;
    } else if (best.gate === null && best.rejection === null) {
      best = attempt;
    }
  }
  return best;
}

interface LocalEnd {
  readonly at: GeoPoint;
  readonly index: number;
}

function endpointsOf(way: RoadWay): readonly LocalEnd[] {
  const first = way.geometry[0];
  const last = way.geometry[way.geometry.length - 1];
  if (first === undefined || last === undefined) return [];
  if (way.geometry.length < 2) return [{ at: first, index: 0 }];
  return [
    { at: first, index: 0 },
    { at: last, index: way.geometry.length - 1 },
  ];
}

function evaluateEnd(params: {
  readonly input: AxisGateInput;
  readonly axis: AxisCorridor;
  readonly axisWay: RoadWay;
  readonly localWay: RoadWay;
  readonly others: readonly (readonly GeoPoint[])[];
  readonly end: LocalEnd;
}): Attempt {
  const { input, axis, axisWay, localWay, others, end } = params;
  const onAxis = nearestOn(axisWay.geometry, end.at);
  if (onAxis === null || onAxis.distanceM > LOCAL_ENDPOINT_MAX_GAP_M) {
    return { gate: null, rejection: null };
  }

  const junction = onAxis.point;
  const away = awayFrom(localWay, end, input.stop);
  if (away === null) {
    return { gate: null, rejection: reject(axisWay, localWay, junction, null, ['no_local_point_away_from_junction']) };
  }

  const axisBearing = localBearingDeg(axisWay.geometry, junction);
  const awayBearing = bearingDeg(junction, away);
  const distanceM = haversineM(junction, input.stop);
  const reasons = refusals({ input, localWay, others, junction, axisBearing, awayBearing, distanceM });

  if (reasons.length > 0) {
    return { gate: null, rejection: reject(axisWay, localWay, junction, distanceM, reasons) };
  }

  const azimuthDeg = bearingDeg(input.stop, junction);
  return {
    gate: {
      id: `axis:${axisWay.id}+${localWay.id}`,
      at: junction,
      inward: offsetPoint(junction, awayBearing, INWARD_CHORD_M),
      axisId: axis.id,
      axisWayId: axisWay.id,
      localWayId: localWay.id,
      label: labelOf(axisWay, localWay),
      importance: axisWay.importance ?? axis.importance,
      localImportance: localWay.importance ?? 5,
      azimuthDeg,
      distanceM,
      sector: sectorOf(azimuthDeg, input.sectorCount),
      rank: null,
      reasonCodes: [],
      uncontrolledBeyondM: null,
    },
    rejection: null,
  };
}

/**
 * Les cinq motifs de refus d'une jonction, TOUS mesurés.
 *
 * L'engine accumule au lieu de s'arrêter au premier, et c'est ce qui permet de
 * lire « refusée pour trois raisons » plutôt que « refusée ». Sortie
 * d'`evaluateEnd` pour tenir la borne de complexité du cliquet (principe 26) :
 * ici on JUGE une jonction, là-bas on la construit.
 */
function refusals(params: {
  readonly input: AxisGateInput;
  readonly localWay: RoadWay;
  readonly others: readonly (readonly GeoPoint[])[];
  readonly junction: GeoPoint;
  readonly axisBearing: number;
  readonly awayBearing: number;
  readonly distanceM: number;
}): readonly string[] {
  const { input, localWay, others, junction, axisBearing, awayBearing, distanceM } = params;
  const reasons: string[] = [];

  if (undirectedDeltaDeg(awayBearing, axisBearing) < LOCAL_BRANCH_MIN_LEAVE_DEG) {
    reasons.push('branch_parallel_to_axis');
  }
  if (wrongSide(awayBearing, bearingDeg(junction, input.stop), axisBearing)) {
    reasons.push('branch_wrong_side_of_axis');
  }
  if (crossesAnotherAxis(junction, input.stop, others)) reasons.push('chord_crosses_retained_axis');
  if (distanceM > input.radiusM * 1.2) reasons.push('beyond_search_radius');
  if (!legalForReference(localWay)) reasons.push('legal_incompatible');
  if (!qualityAt(localWay, distanceM)) reasons.push('road_quality_rejected');
  return reasons;
}

/**
 * La branche part-elle du côté de l'axe OPPOSÉ à l'adresse ?
 *
 * Le repère est l'AXE, pas le cap vers l'adresse : une jonction décalée le long
 * de l'axe met une branche parfaitement valide à plus de 90° de l'adresse.
 * Quand l'un des deux est à ±5° de l'axe, le côté n'a pas de sens et le test ne
 * tranche rien.
 */
function wrongSide(awayBearing: number, towardDelivery: number, axisBearing: number): boolean {
  const branch = sideSign(awayBearing, axisBearing);
  const delivery = sideSign(towardDelivery, axisBearing);
  if (Math.abs(branch) < SIDE_AMBIGUOUS_SIN || Math.abs(delivery) < SIDE_AMBIGUOUS_SIN) return false;
  return Math.sign(branch) !== Math.sign(delivery);
}

function reject(
  axisWay: RoadWay,
  localWay: RoadWay,
  at: GeoPoint,
  distanceM: number | null,
  reasons: readonly string[],
): AxisGateRejected {
  return { axisWayId: axisWay.id, localWayId: localWay.id, at, distanceM, reasons };
}

/**
 * Le sommet de la rue locale, au-delà de 3 m du bout, dont le cap depuis le
 * bout pointe le plus vers l'adresse. C'est `localPointAwayFromEndpoint`.
 */
function awayFrom(localWay: RoadWay, end: LocalEnd, stop: GeoPoint): GeoPoint | null {
  const ordered =
    end.index === 0 ? localWay.geometry.slice(1) : [...localWay.geometry.slice(0, -1)].reverse();
  const candidates = ordered.filter((point) => haversineM(point, end.at) > AWAY_MIN_M);
  const first = candidates[0];
  if (first === undefined) return null;
  const toward = bearingDeg(end.at, stop);
  return candidates.reduce((best, point) =>
    undirectedDeltaDeg(bearingDeg(end.at, point), toward)
    < undirectedDeltaDeg(bearingDeg(end.at, best), toward)
      ? point
      : best,
  first);
}

function crossesAnotherAxis(
  junction: GeoPoint,
  stop: GeoPoint,
  others: readonly (readonly GeoPoint[])[],
): boolean {
  if (haversineM(junction, stop) < 1) return false;
  return others.some((geometry) => chordCrosses(junction, stop, geometry));
}

/** Les tracés de chaque axe, tronçon par tronçon — ce que la corde doit éviter. */
function axisGeometries(input: AxisGateInput): ReadonlyMap<string, readonly (readonly GeoPoint[])[]> {
  const out = new Map<string, readonly (readonly GeoPoint[])[]>();
  for (const axis of input.axes) {
    out.set(
      axis.id,
      axis.wayIds
        .map((id) => input.axisWays.get(id)?.geometry)
        .filter((geometry): geometry is readonly GeoPoint[] => geometry !== undefined && geometry.length >= 2),
    );
  }
  return out;
}

/**
 * Une rue privée n'est une porte pour personne ; le reste est l'affaire de S5.
 *
 * CE QU'ON CHANGE À L'ENGINE. `passesPl19tLegalCompatibility` refuse là-bas
 * une rue qui déclare moins que le gabarit `pl-19t` (tonnage, hauteur,
 * largeur). Ici non : S3 ne connaît pas le camion — c'est ce qui permet de
 * rejouer les mêmes itinéraires pour trois gabarits (`reprojectTruck`) — et un
 * tonnage à 3,5 t qui écarterait une porte pour un fourgon de 2,8 t serait un
 * refus fabriqué au mauvais étage. Le tonnage déclaré est lu par S5, où il
 * décide pour le camion choisi. `isPrivate` reste : une voie privée n'est pas
 * une entrée de secteur, quel que soit le véhicule.
 */
function legalForReference(way: RoadWay): boolean {
  return !way.isPrivate;
}

/** Loin de l'adresse, on cesse d'accepter les chemins et les rues trop étroites. */
function qualityAt(way: RoadWay, distanceM: number): boolean {
  if (distanceM <= QUALITY_PERMISSIVE_MAX_M) return true;
  const nature = (way.tags['nature'] ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
  if (WEAK_NATURE_FRAGMENTS.some((fragment) => nature.includes(fragment))) return false;
  if (distanceM > QUALITY_WEAK_SURFACE_MAX_M && way.declaredWidthM !== null) {
    return way.declaredWidthM >= FAR_MIN_WIDTH_M;
  }
  return true;
}

function labelOf(axisWay: RoadWay, localWay: RoadWay): string {
  const axisName = axisWay.name ?? axisWay.tags['nature'] ?? `BD TOPO ${axisWay.id.slice(-8)}`;
  const localName = localWay.name ?? localWay.tags['nature'] ?? `BD TOPO ${localWay.id.slice(-8)}`;
  return `${axisName} × ${localName}`;
}

/**
 * Une porte par site : la plus proche de l'adresse gagne.
 *
 * Deux critères, ceux de `dedupeGateCandidates` : même axe à moins de 35 m
 * (c'est le même carrefour vu deux fois), ou même rue locale à moins de 50 m
 * (c'est la même sortie sur deux tronçons d'axe consécutifs).
 */
export function dedupe(gates: readonly AxisGate[]): readonly AxisGate[] {
  const sorted = [...gates].sort((a, b) => a.distanceM - b.distanceM || a.id.localeCompare(b.id));
  const kept: AxisGate[] = [];
  for (const gate of sorted) {
    const duplicate = kept.some((held) => {
      const apart = haversineM(held.at, gate.at);
      const sameAxis = held.axisId === gate.axisId && apart <= GATE_SITE_DEDUPE_M;
      // `localWayId` est nul pour une porte de bande (`axes-band.ts`), qui ne
      // passe jamais ici : la garde évite qu'un jour deux nuls se lisent comme
      // « la même rue locale ».
      const sameLocal =
        held.localWayId !== null && held.localWayId === gate.localWayId && apart <= GATE_LOCAL_DEDUPE_M;
      return sameAxis || sameLocal;
    });
    if (!duplicate) kept.push(gate);
  }
  return kept;
}
