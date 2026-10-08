/**
 * S2 bis — les contraintes du camion à l'ARRÊT DE REPLI.
 *
 * Le principe 10 exige que la rue d'avant passe S1–S2 pour le camion AVANT
 * d'être proposée. S1 est dans le fait lui-même (`assessTopology`,
 * `computeFallbackStop` : la parente est celle que le handoff a prouvée, avec
 * sa confiance). S2 se fait ici, avec la même fonction d'assemblage que
 * l'arrêt de livraison (`assembleStopConstraints`, une seule formule —
 * principe 23) et ce qui existe SANS appel réseau : la largeur déclarée de la
 * parente (greffée BD TOPO sur tout le cercle, pas seulement la retenue), ses
 * bandes légales, ses barrières, et la ZFE — servie depuis la base en mémoire.
 * La pente et la largeur mesurée restent inconnues à l'arrêt de repli : elles
 * coûteraient un appel chacune, et une inconnue dite est une réponse
 * (principe 14). Le contrôle complet — S0–S6 sur ce point — est le run que
 * l'opérateur lance s'il choisit cet arrêt (contrat BUG-068).
 */
import { assembleStopConstraints } from '@teneolog/constraints';
import type {
  Fact,
  FallbackStop,
  GeoPoint,
  LowEmissionZone,
  PhysicalBarrier,
  StopConstraints,
  TopologyAssessment,
} from '@teneolog/domain';
import type { RoadNeighbourhood, RoadWay } from '@teneolog/topology';

import type { PipelineParams, PipelinePorts } from './analyse.js';

export interface FallbackStopFacts {
  /** S1 bis — where, on which street, how far to walk, which band. */
  readonly place: FallbackStop;
  /** S2 bis — what the truck meets there, from the parent street's own description. */
  readonly stop: StopConstraints;
}

/**
 * The fallback stop with its constraints, or the same unknown the topology
 * carries. `undefined` when the assessment computed none (no policy block):
 * an absence stays an absence.
 */
export async function fallbackStopFacts(
  topology: TopologyAssessment,
  neighbourhood: RoadNeighbourhood | null,
  ports: PipelinePorts,
  params: PipelineParams,
  fetchedAt: string,
): Promise<Fact<FallbackStopFacts> | undefined> {
  const place = topology.fallbackStop;
  if (place === undefined) return undefined;
  if (!place.known) return place;

  const parent = neighbourhood?.ways.find((w) => w.id === place.value.street.segmentId);
  if (parent === undefined) {
    return { known: false, why: 'out_of_coverage', provenance: place.provenance };
  }

  const stop = await constraintsAtStop(place.value.stopAt, parent, place.value.barriers, ports, params, fetchedAt);
  return {
    known: true,
    value: { place: place.value, stop },
    provenance: place.provenance,
    reliability: place.reliability,
  };
}

/**
 * S2 at a stop that is not the delivery point, from the street it stands on
 * and nothing that costs a call but the zone: the fallback stop's, and a point
 * clicked on the map ( tranche 2) — one assembly for both, the same as
 * the delivery stop's (principe 23).
 */
export async function constraintsAtStop(
  at: GeoPoint,
  street: RoadWay,
  barriers: readonly Fact<PhysicalBarrier>[],
  ports: PipelinePorts,
  params: PipelineParams,
  fetchedAt: string,
): Promise<StopConstraints> {
  const lowEmissionZone = await lowEmissionZoneAt(ports, at, fetchedAt);
  return assembleStopConstraints({
    at,
    descriptions: [street],
    fetchedAt,
    declaredWidthConfidence: params.declaredWidthConfidence,
    barriers,
    ...(lowEmissionZone === undefined ? {} : { lowEmissionZone }),
  });
}

/**
 * The low-emission zone at a point. A lookup that fails must leave an unknown,
 * never a reassuring silence; without a port, nothing was looked up at all.
 * One reading for the delivery stop and the fallback stop (principe 23).
 */
export async function lowEmissionZoneAt(
  ports: PipelinePorts,
  at: GeoPoint,
  fetchedAt: string,
): Promise<Fact<LowEmissionZone | null> | undefined> {
  if (ports.lowEmissionZones === undefined) return undefined;
  try {
    const zone = await ports.lowEmissionZones.zoneAt(at);
    return {
      known: true,
      value: zone,
      provenance: { source: 'bnzfe', method: 'aires-point-in-polygon', fetchedAt },
      reliability: { confidence: 1, basis: 'declared', reasonCodes: [] },
    };
  } catch {
    return { known: false, why: 'provider_error' };
  }
}
