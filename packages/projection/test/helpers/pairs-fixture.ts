/**
 * Le run de démonstration : N paires, chacune réglée au critère près.
 *
 * Partagé par `ranking.test.ts` (l'ordre) et `conclusion-golden.test.ts` (ce
 * que l'ordre n'a pas le droit de changer). Deux jeux de paires seraient deux
 * runs différents, et le test d'or ne prouverait plus rien du premier.
 */
import type {
  CriticalPoint,
  Fact,
  GeoPoint,
  RouteCandidate,
  RouteSegmentConstraint,
  TruckProfile,
  Width,
} from '@teneolog/domain';

import type { PlanStopShape } from '../../src/plans.js';
import type { ConclusionPolicy, ProjectionPolicy } from '../../src/policy.js';
import { projectTruck } from '../../src/project.js';

export const POLICY: ProjectionPolicy = {
  lateralClearanceM: 0.8,
  turnSweptClearanceM: 1.0,
  roundaboutSweptClearanceM: 1.0,
  turnaroundClearanceM: 2.0,
  comfortMarginM: 0.4,
  publishableConfidence: 0.55,
  hgvThresholdT: 3.5,
  passingLaneWidthM: 2.75,
};

export const PL19: TruckProfile = {
  id: 'pl-19t',
  label: 'Porteur 19 t',
  family: 'rigid',
  envelope: { lengthM: 9, widthM: 2.5, heightM: 3.5, gvwT: 19, turnRadiusM: 11, wheelbaseM: 6.1, frontOverhangM: 1.2, rearOverhangM: 1.7 },
  equipment: { tailLift: true, crane: false, refrigerated: false },
};

export const AT = { lat: 47.0, lon: 1.0 };
/** Largeur libre – (2,5 m + 0,8 m de garde) : la marge que la policy publie. */
export const CLEARANCE = PL19.envelope.widthM + POLICY.lateralClearanceM;

function width(freeM: number): Fact<Width> {
  return {
    known: true,
    value: { freeM, structuralM: freeM, measuredAt: AT, offsetFromAnchorM: 0 },
    provenance: { source: 'ign-ortho', method: 'd10-stitched', fetchedAt: 'x' },
    reliability: { confidence: 0.7, basis: 'measured', reasonCodes: [] },
  };
}

/** Un point mesuré : verdict OK, marge connue. */
export function measured(ref: string, freeM: number): CriticalPoint {
  return point(ref, width(freeM));
}

/** Un point qu'on ne sait pas mesurer : verdict HUMAIN, marge nulle (au sens : absente). */
export function unknown(ref: string): CriticalPoint {
  return point(ref, { known: false, why: 'not_visible' });
}

/**
 * une largeur ESTIMÉE, jamais mesurée.
 *
 * Même nombre, même calcul, une seule chose change : `basis`. Sous le seuil,
 * l'évaluateur ne refuse pas mais escalade (`unmeasured_width_cannot_refuse`)
 * et ne publie AUCUNE marge — c'est l'inconnue au sens du principe 28.
 */
function estimatedWidth(freeM: number): Fact<Width> {
  return {
    known: true,
    value: { freeM, structuralM: freeM, measuredAt: AT, offsetFromAnchorM: 0 },
    provenance: { source: 'osm-overpass', method: 'lane-count', fetchedAt: 'x' },
    reliability: { confidence: 0.7, basis: 'derived', reasonCodes: [] },
  };
}

/**
 * un VIRAGE mesuré : le type de point qui pèse dans le classement.
 *
 * `requiredWidthForTurnM` monte avec la déflexion ; à 90° un 19 t demande
 * nettement plus que sa caisse, et c'est ce que la marge compare. Le rayon
 * reste inconnu, comme sur toutes les données d'aujourd'hui (défaut J du jury).
 */
export function turn(ref: string, deflectionDeg: number, approachWidthM: number): CriticalPoint {
  return turnPoint(ref, deflectionDeg, width(approachWidthM));
}

/** Le même virage, sur une largeur estimée : un doute qui est une INCONNUE. */
export function estimatedTurn(
  ref: string,
  deflectionDeg: number,
  approachWidthM: number,
): CriticalPoint {
  return turnPoint(ref, deflectionDeg, estimatedWidth(approachWidthM));
}

function turnPoint(ref: string, deflectionDeg: number, w: Fact<Width>): CriticalPoint {
  return {
    ref,
    type: 'TURN',
    at: AT,
    geometry: {
      known: true,
      value: {
        type: 'TURN',
        geometry: {
          apex: AT,
          deflectionDeg,
          approachBearingDeg: 0,
          exitBearingDeg: deflectionDeg,
          // un virage de carrefour n'a pas de rayon (le routeur arrondit le coin), et
          // la fixture n'enchaîne rien.
          kind: 'junction',
          arcLengthM: 20,
          radiusM: null,
          chainedWithPreviousM: null,
          approachWidth: w,
          exitWidth: w,
        },
      },
      provenance: { source: 'ign-ortho', method: 'stop', fetchedAt: 'x' },
      reliability: { confidence: 0.9, basis: 'derived', reasonCodes: [] },
    },
    evidence: [],
  };
}

function point(ref: string, w: Fact<Width>): CriticalPoint {
  return {
    ref,
    type: 'NARROW',
    at: AT,
    geometry: {
      known: true,
      value: { type: 'NARROW', geometry: { width: w, lengthM: 20, constriction: null } },
      provenance: { source: 'ign-ortho', method: 'stop', fetchedAt: 'x' },
      reliability: { confidence: 0.9, basis: 'derived', reasonCodes: [] },
    },
    evidence: [],
  };
}

export function segment(segmentId: string, highway: string | null, lengthM: number): RouteSegmentConstraint {
  return {
    segmentId,
    from: AT,
    to: AT,
    position: 'transit',
    highway,
    lengthM,
    legal: {
      maxWeightT: { known: false, why: 'no_data' },
      maxHeightM: { known: false, why: 'no_data' },
      maxWidthM: { known: false, why: 'no_data' },
      maxLengthM: { known: false, why: 'no_data' },
      access: { known: false, why: 'no_data' },
      lowEmissionZone: { known: false, why: 'no_data' },
    },
    width: { known: false, why: 'no_data' },
  };
}

export interface PairSpec {
  /** `<nom>@<azimut>` — l'azimut est lu, et il donne sa géométrie à la paire. */
  readonly gate: string;
  /** Les segments du corridor, identiques sur les deux jambes. */
  readonly segments?: readonly RouteSegmentConstraint[];
  /** Distance d'UNE jambe ; la paire en porte le double. */
  readonly legDistanceM?: number;
  /** Les points de la paire, partagés par ses deux jambes. */
  readonly points?: readonly CriticalPoint[];
}

/**
 * LA GÉOMÉTRIE DE LA FIXTURE — pourquoi elle a cessé d'être `[AT, AT]`.
 *
 * Les plans lisent deux caps à l'arrêt : celui de l'arrivée, celui du départ.
 * Une polyligne réduite à deux fois le même point n'en porte aucun, et
 * `rankPlans` lit alors « je n'ai pas pu mesurer » — donc demi-tour non établi,
 * donc HUMAIN, sur TOUS les plans. La fixture disait ainsi d'une rue ce
 * qu'aucune rue ne dit, et la conclusion par plan y aurait été HUMAINE partout.
 *
 * Ce qu'elle dit maintenant, et qui est une vraie rue traversante :
 *
 *  - l'ancre `x@θ` est à 300 m du point de livraison, dans l'azimut θ ;
 *  - l'ENTRANTE vient de là : le camion arrive cap θ + 180 ;
 *  - la SORTANTE **continue** ce cap, puis fait le tour pour rejoindre son
 *    ancre. C'est ce qu'OSRM dessine le plus souvent sur une rue traversante,
 *    et c'est ce que l'A/B a mesuré : 9 des 24 meilleurs plans du corpus sont
 * `straight` (la note de conception interne).
 *
 * Conséquence lisible : un plan à MÊME ancre est tout droit (écart de cap nul),
 * un plan qui croise deux ancres écarte les caps de |θ₁ − θ₂| — au-delà de 60°,
 * c'est un demi-tour, et sur une rue traversante il n'est jamais établi.
 *
 * Ce que la géométrie NE change pas : la conclusion par paires. Ni
 * `concludePairs` ni `rankPairs` ne lisent une polyligne.
 */
const ORIGIN_DISTANCE_M = 300;

function bearingOf(gate: string): number {
  const at = gate.lastIndexOf('@');
  const parsed = at < 0 ? Number.NaN : Number(gate.slice(at + 1));
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Le point à `ORIGIN_DISTANCE_M` de `AT` dans l'azimut donné, en plan local. */
function origin(bearingDeg: number): GeoPoint {
  const rad = (bearingDeg * Math.PI) / 180;
  const north = (ORIGIN_DISTANCE_M * Math.cos(rad)) / 111_320;
  const east = (ORIGIN_DISTANCE_M * Math.sin(rad)) / (111_320 * Math.cos((AT.lat * Math.PI) / 180));
  return { lat: AT.lat + north, lon: AT.lon + east };
}

/** Entrante : de l'ancre vers l'arrêt. Sortante : de l'arrêt, dans le sens de l'arrivée. */
function legLine(gate: string, direction: 'in' | 'out'): readonly GeoPoint[] {
  const bearing = bearingOf(gate);
  return direction === 'in' ? [origin(bearing), AT] : [AT, origin(bearing + 180)];
}

/** La rue de la fixture : traversante, donc aucun retournement à y mesurer. */
export const THROUGH_STOP: PlanStopShape = {
  kind: 'THROUGH',
  turnaround: { known: false, why: 'not_applicable' },
  provenTopology: true,
};

export interface RunOptions {
  /** qui décide. Défaut : `pairs`, le moteur d'hier. */
  readonly conclusion?: ConclusionPolicy;
  readonly stop?: PlanStopShape;
}

/**
 * Un run : une paire par spec, dans l'ordre donné — qui est l'ordre d'azimut
 * puisque c'est ainsi que S3 sort ses ancres.
 */
export function runProjection(specs: readonly PairSpec[], options: RunOptions = {}) {
  const candidates: RouteCandidate[] = [];
  const points: CriticalPoint[] = [];
  const byCandidate = new Map<string, readonly string[]>();
  // La géométrie que CETTE jambe mesure. Ici chaque jambe porte ses
  // propres points, donc c'est la leur, telle que la fixture l'écrit.
  const geometryByCandidate = new Map<string, ReadonlyMap<string, CriticalPoint['geometry']>>();

  for (const spec of specs) {
    const segments = spec.segments ?? [segment(`${spec.gate}:seg`, 'secondary', 500)];
    const distanceM = spec.legDistanceM ?? 1_000;
    const refs = (spec.points ?? []).map((p) => p.ref);
    for (const p of spec.points ?? []) {
      if (!points.some((existing) => existing.ref === p.ref)) points.push(p);
    }
    for (const direction of ['in', 'out'] as const) {
      const id = `${spec.gate}:${direction}`;
      candidates.push({
        id,
        direction,
        polyline: legLine(spec.gate, direction),
        segments,
        coverage: { sampled: 10, matched: 10 },
        corridorReasonCodes: [],
        generatedBy: 'car-optimal',
        distanceM,
        durationS: 60,
        egressOf:
          direction === 'out'
            ? { inboundId: `${spec.gate}:in`, turnaround: { known: false, why: 'no_data' } }
            : null,
      });
      byCandidate.set(id, refs);
      geometryByCandidate.set(id, new Map((spec.points ?? []).map((p) => [p.ref, p.geometry])));
    }
  }

  return projectTruck({
    candidates,
    collected: { points, byCandidate, geometryByCandidate },
    truck: PL19,
    policy: options.conclusion === undefined ? POLICY : { ...POLICY, conclusion: options.conclusion },
    policyVersion: 'test-1',
    validUntil: '2026-09-24T00:00:00Z',
    stopShape: options.stop ?? THROUGH_STOP,
  });
}

/** La conclusion du même run — ce que la plupart des tests regardent. */
export function run(specs: readonly PairSpec[], options: RunOptions = {}) {
  return runProjection(specs, options).conclusion;
}

/** Le même run, conclu par le meilleur PLAN. */
export function runPlans(specs: readonly PairSpec[], stop: PlanStopShape = THROUGH_STOP) {
  return run(specs, { conclusion: { mode: 'plans' }, stop });
}

