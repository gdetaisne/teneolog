/**
 * Un run où l'entrée et la sortie sont VRAIMENT deux choix.
 *
 * La fixture des paires (`pairs-fixture.ts`) suffit à tout ce qui se joue sur
 * des verdicts, mais ses jambes ont une polyligne dégénérée (`[AT, AT]`) :
 * aucun cap ne s'y mesure, donc aucune manœuvre ne s'y décide. Ici chaque jambe
 * porte une vraie ligne, tracée depuis l'arrêt sur un cap donné — c'est la
 * seule chose que les plans ajoutent à la lecture des faits, et c'est donc la
 * seule chose que cette fixture ajoute.
 *
 * Convention des caps : celui d'une ENTRANTE est la direction dans laquelle le
 * camion roule en arrivant ; celui d'une SORTANTE, la direction dans laquelle
 * il roule en partant. Deux caps égaux = tout droit ; opposés = demi-tour.
 */
import type {
  CriticalPoint,
  Fact,
  GeoPoint,
  RouteCandidate,
  TruckProfile,
  Turnaround,
} from '@teneolog/domain';
import { offsetPoint } from '@teneolog/topology';

import type { PlanStopShape } from '../../src/plans.js';
import type { ProjectionPolicy } from '../../src/policy.js';
import { projectTruck } from '../../src/project.js';
import { AT, PL19, POLICY, segment } from './pairs-fixture.js';

/** Une rue traversante : rien à mesurer, le demi-tour n'y a pas été cherché. */
export const THROUGH: PlanStopShape = {
  kind: 'THROUGH',
  turnaround: { known: false, why: 'not_applicable' },
  provenTopology: true,
};

/**
 * Une impasse dont le retournement a été MESURÉ au diamètre dit, sur une forme
 * PROUVÉE. Les deux qualificatifs comptent depuis ce sont les seules
 * conditions dans lesquelles un plan a le droit de refuser le demi-tour.
 */
export function deadEnd(usableDiameterM: number): PlanStopShape {
  return { kind: 'DEAD_END', turnaround: turnaround(usableDiameterM), provenTopology: true };
}

/** Une impasse dont personne n'a mesuré le retournement. */
export const DEAD_END_UNMEASURED: PlanStopShape = {
  kind: 'DEAD_END',
  turnaround: { known: false, why: 'no_data' },
  provenTopology: true,
};

/** La même impasse, mais dont le nœud terminal était au bord du rayon étudié. */
export function deadEndUnproven(usableDiameterM: number): PlanStopShape {
  return { kind: 'DEAD_END', turnaround: turnaround(usableDiameterM), provenTopology: false };
}

/** Une impasse dont le retournement est DÉCLARÉ, jamais mesuré — le cas d'Auxerre. */
export function deadEndDeclared(usableDiameterM: number): PlanStopShape {
  return {
    kind: 'DEAD_END',
    turnaround: {
      known: true,
      value: { usableDiameterM, centre: AT, surface: 'carriageway' },
      provenance: { source: 'osm-overpass', method: 'declared-width', fetchedAt: 'x' },
      reliability: { confidence: 0.8, basis: 'declared', reasonCodes: ['declared_width'] },
    },
    provenTopology: true,
  };
}

export function turnaround(usableDiameterM: number): Fact<Turnaround> {
  return {
    known: true,
    value: { usableDiameterM, centre: AT, surface: 'carriageway' },
    provenance: { source: 'ign-ortho', method: 'd10-stitched', fetchedAt: 'x' },
    reliability: { confidence: 0.8, basis: 'measured', reasonCodes: [] },
  };
}

export interface LegSpec {
  /** L'ancre de la jambe : deux jambes de même clé forment la paire du moteur. */
  readonly gate: string;
  /** Le cap du camion à l'arrêt, en degrés depuis le nord. */
  readonly headingDeg: number;
  readonly points?: readonly CriticalPoint[];
  /** Longueur de la ligne tracée. 200 m par défaut — dix fois le `headingSpanM`. */
  readonly lengthM?: number;
  readonly distanceM?: number;
  readonly highway?: string | null;
}

export interface PlanRunSpec {
  readonly inbound: readonly LegSpec[];
  readonly outbound: readonly LegSpec[];
  readonly stop?: PlanStopShape;
  readonly truck?: TruckProfile;
  /** Sans elle, `POLICY` — donc les valeurs par défaut du couplage à l'arrêt. */
  readonly policy?: ProjectionPolicy;
}

/**
 * La projection complète — c'est par elle que les plans se lisent, comme le
 * classement : une chaîne réelle, jamais des verdicts écrits à la main.
 */
export function planProjection(spec: PlanRunSpec) {
  const candidates: RouteCandidate[] = [];
  const points: CriticalPoint[] = [];
  const byCandidate = new Map<string, readonly string[]>();
  // La géométrie propre à chaque jambe : ici celle que la fixture
  // écrit sur ses points, jambe par jambe.
  const geometryByCandidate = new Map<string, ReadonlyMap<string, CriticalPoint['geometry']>>();

  const add = (leg: LegSpec, direction: 'in' | 'out', pairedWith: string | null) => {
    const id = `${leg.gate}:${direction}`;
    const lengthM = leg.lengthM ?? 200;
    const far = offsetPoint(
      AT,
      direction === 'in' ? (leg.headingDeg + 180) % 360 : leg.headingDeg,
      lengthM,
    );
    // L'entrante FINIT à l'arrêt, la sortante en PART : c'est cette asymétrie
    // que les caps lisent, et l'inverser ferait passer tout droit pour demi-tour.
    const polyline: readonly GeoPoint[] = direction === 'in' ? [far, AT] : [AT, far];
    for (const point of leg.points ?? []) {
      if (!points.some((held) => held.ref === point.ref)) points.push(point);
    }
    candidates.push({
      id,
      direction,
      polyline,
      segments: [segment(`${id}:seg`, leg.highway ?? 'secondary', 500)],
      coverage: { sampled: 10, matched: 10 },
      corridorReasonCodes: [],
      generatedBy: 'car-optimal',
      distanceM: leg.distanceM ?? 1_000,
      durationS: 60,
      egressOf:
        direction === 'out' && pairedWith !== null
          ? { inboundId: pairedWith, turnaround: spec.stop?.turnaround ?? THROUGH.turnaround }
          : null,
    });
    byCandidate.set(id, (leg.points ?? []).map((point) => point.ref));
    geometryByCandidate.set(id, new Map((leg.points ?? []).map((point) => [point.ref, point.geometry])));
  };

  for (const leg of spec.inbound) add(leg, 'in', null);
  for (const leg of spec.outbound) {
    // La paire du moteur d'aujourd'hui : la sortante nomme l'entrante de la
    // MÊME ancre, quand elle existe. C'est l'hypothèse que les plans mettent à
    // l'épreuve, donc elle doit être là, intacte.
    const twin = spec.inbound.find((other) => other.gate === leg.gate);
    add(leg, 'out', twin === undefined ? null : `${twin.gate}:in`);
  }

  return projectTruck({
    candidates,
    collected: { points, byCandidate, geometryByCandidate },
    truck: spec.truck ?? PL19,
    policy: spec.policy ?? POLICY,
    policyVersion: 'test-1',
    validUntil: '2026-09-24T00:00:00Z',
    stopShape: spec.stop ?? THROUGH,
  });
}

export function planRun(spec: PlanRunSpec) {
  return planProjection(spec).conclusion;
}

/**
 * LE POINT TURNAROUND, celui que S4 accroche aux deux jambes d'une
 * impasse.
 *
 * Sans lui, les cas de manœuvre mesuraient le terme de `rankPlans` tout seul,
 * jamais le partage avec le point — or c'est ce partage qui décide si la même
 * question est comptée une fois ou deux. Mesuré et prouvé : la seule forme où
 * le doute, s'il y en a un, est un doute MESURÉ.
 */
export function turnaroundPoint(ref: string, usableDiameterM: number): CriticalPoint {
  return {
    ref,
    type: 'TURNAROUND',
    at: AT,
    geometry: {
      known: true,
      value: {
        type: 'TURNAROUND',
        geometry: {
          surface: { usableDiameterM, areaM2: null, polygon: null, occupancy: 'clear' },
          requiresReversingM: 0,
          beyondStop: false,
          distanceFromStopM: 0,
          provenTopology: true,
        },
      },
      provenance: { source: 'ign-ortho', method: 'd10-stitched', fetchedAt: 'x' },
      reliability: { confidence: 0.8, basis: 'measured', reasonCodes: [] },
    },
    evidence: [],
  };
}

/** Le même point, dont S4 n'a rien pu établir : `point_geometry_no_data`. */
export function unknownTurnaroundPoint(ref: string): CriticalPoint {
  return { ref, type: 'TURNAROUND', at: AT, geometry: { known: false, why: 'no_data' }, evidence: [] };
}
