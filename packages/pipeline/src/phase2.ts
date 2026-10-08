/**
 * l'organisation de la phase 2 : par où commencer, dans quel ordre,
 * et ce qu'on peut cesser de payer.
 *
 * Décision produit : « on n'est pas à 1 seconde près… surtout ne baissons
 * pas en qualité, c'est clairement la qualité qui prime. Analyser les
 * itinéraires en partant de l'endroit le plus risqué (destination) et
 * prioriser les itinéraires qui paraissent les plus certains. »
 *
 * Ce module ne décide d'aucun verdict. Il porte :
 *
 *  - les réglages de la phase 2 (`Phase2Params`), avec leurs valeurs par
 *    défaut, pour qu'un appelant écrit avant cette tâche compile et ne paie
 *    rien — le même partage que `gates.byWidth` ;
 *  - la mesure du tronc commun pour UN camion (`measureCommonTrunk`), qui est
 *    pure une fois le corridor chargé ;
 *  - la relecture de ce tronc pour un autre camion, sans réseau.
 */
import type {
  CommonTrunk,
  CriticalPoint,
  GeoPoint,
  TruckProfile,
  Verdict,
} from '@teneolog/domain';
import type { CollectPointsInput } from '@teneolog/points';
import { collectCriticalPoints, type CollectPointsParams } from '@teneolog/points';
import { projectTruck, type ProjectionPolicy } from '@teneolog/projection';
import {
  candidateFromRoutedLeg,
  commonTrunkOf,
  TiledCorridorSource,
  type CorridorPort,
  type TileRetryPolicy,
  type WayTilePort,
} from '@teneolog/routes';

/** Ce que la policy dit de l'organisation de la phase 2, et rien de plus. */
export interface Phase2Params {
  /**
   * Le cache de voies par tuile. À `false`, chaque corridor repart sur sa
   * propre requête, exactement comme avant le repli si jamais un
   * jour le cache et la requête directe se mettaient à diverger.
   */
  readonly wayTiles: {
    readonly enabled: boolean;
    readonly tileM: number;
    /**
     * la relecture d'une tuile en échec,
     * AVANT que S5 ne pose `corridor_partial`. Absent : le comportement
     * d'avant la tâche.
     */
    readonly retryMissingTiles?: TileRetryPolicy;
  };
  /** Rayon préchargé autour du point de livraison, avant toute jambe. */
  readonly destinationRadiusM: number;
  /** Écart au-delà duquel deux jambes ne sont plus sur la même rue. */
  readonly trunkToleranceM: number;
  /** Pas d'avancée le long du tronc. */
  readonly trunkStepM: number;
  /** Plafond de longueur du tronc : au-delà, on ne cherche plus. */
  readonly trunkMaxLengthM: number;
  /** Les seuils du tri des jambes (`leg-priority.ts`). */
  readonly legOrder: {
    readonly minTurnDeg: number;
    readonly minSegmentM: number;
    readonly snapM: number;
  };
  /** DRAPEAU — s'arrêter entre deux lots quand un plan sûr est déjà tenu. */
  readonly stopBetweenBatches: boolean;
  /** DRAPEAU — conclure NON sur un refus du tronc commun, sans charger la suite. */
  readonly commonRefusalStops: boolean;
}

/**
 * Les valeurs par défaut.
 *
 * Les deux drapeaux sont **baissés** : cette tâche mesure ce qu'ils
 * couperaient, elle ne les active pas. Le cache de tuiles, lui, est levé —
 * c'est une économie prouvée à résultat identique, pas un pari.
 */
export const DEFAULT_PHASE2: Phase2Params = {
  // la relecture est ACTIVE : c'est une correction de défaut
  // (audit L5-2, décision D4 de Décision produit), pas une règle
  // nouvelle mise en silence. 8 000 ms = le budget d'une requête Overpass de
  // tuile telle que l'A/B du 2026-09-11 l'a mesurée à Paris 11e (médiane 1,4 s
  // à Thairé, 30,9 s quand la vanne manquait ; 8 s couvre la queue haute d'une
  // tuile servie normalement sans tenir le run quand le fournisseur est à
  // terre) — la note de conception interne
  wayTiles: { enabled: true, tileM: 500, retryMissingTiles: { enabled: true, timeoutMs: 8_000 } },
  destinationRadiusM: 400,
  // 15 m : la tolérance avec laquelle la découverte dit déjà que deux jambes
  // sont la même approche (`SNAP_TOLERANCE_M`). En poser une deuxième ferait
  // deux définitions de « la même rue ».
  trunkToleranceM: 15,
  trunkStepM: 10,
  trunkMaxLengthM: 2_000,
  // 60° et 20 m : le seuil de virage de `points.turns.minDeflectionDeg` et une
  // base de mesure du même ordre que `projection.plans.headingSpanM`.
  legOrder: { minTurnDeg: 60, minSegmentM: 20, snapM: 25 },
  stopBetweenBatches: false,
  commonRefusalStops: false,
};

/**
 * Le cache de voies de CETTE adresse, ou null quand il est éteint.
 *
 * Construit par analyse et jamais au démarrage : les voies d'une adresse n'ont
 * rien à faire dans l'analyse de la suivante.
 */
export function tiledCorridorFor(
  tiles: WayTilePort | null | undefined,
  params: Phase2Params,
  graft: {
    readonly sampleStepM: number;
    readonly lateralToleranceM: number;
    readonly bearingToleranceDeg: number;
    readonly minCoverage: number;
  },
  maxConcurrent: number,
): TiledCorridorSource | null {
  if (tiles === null || tiles === undefined || !params.wayTiles.enabled) return null;
  return new TiledCorridorSource({
    tiles,
    tileM: params.wayTiles.tileM,
    maxConcurrent,
    // Le donneur tient DEUX requêtes de front, et pas quatre — voir
    // `donorConcurrent` pour l'engrenage que cela évite.
    donorConcurrent: Math.min(maxConcurrent, 2),
    graft,
    // la relecture d'une tuile muette, avant que la jambe soit jugée.
    ...(params.wayTiles.retryMissingTiles === undefined
      ? {}
      : { retryMissingTiles: params.wayTiles.retryMissingTiles }),
  });
}

export interface CommonTrunkInput {
  readonly stop: GeoPoint;
  readonly legs: readonly { readonly direction: 'in' | 'out'; readonly polyline: readonly GeoPoint[] }[];
  readonly topology: CollectPointsInput['topology'];
  readonly terminalNodeInterior: boolean;
  readonly stopFacts: CollectPointsInput['stop'];
  readonly truck: TruckProfile;
  readonly points: CollectPointsParams;
  readonly projection: ProjectionPolicy;
  readonly policyVersion: string;
  readonly candidates: {
    readonly corridorMarginM: number;
    readonly sampleStepM: number;
    readonly snapM: number;
    readonly approachWindowM: number;
    readonly laneWidthM: number;
    readonly minCorridorCoverage: number;
  };
  readonly phase2: Phase2Params;
  readonly fetchedAt: string;
}

/**
 * Le tronc commun, ses points de passage et le verdict qu'il porte.
 *
 * Le tronc est annoté avec `candidateFromRoutedLeg` — la MÊME annotation que
 * les itinéraires de production, pas une copie (c'est tout le propos de
 * `replay.ts`) — puis passé à S4 et S5 tels quels. Un point qui tombe ici
 * tombe sur le chemin de toutes les jambes, par construction du tronc.
 *
 * Rend `null` quand il n'y a rien de commun : sur une rue traversante abordée
 * des deux côtés, c'est le cas normal, et c'est une mesure, pas un échec.
 */
export async function measureCommonTrunk(
  input: CommonTrunkInput,
  corridor: CorridorPort,
): Promise<CommonTrunk | null> {
  const trunk = commonTrunkOf({
    stop: input.stop,
    legs: input.legs,
    toleranceM: input.phase2.trunkToleranceM,
    stepM: input.phase2.trunkStepM,
    maxLengthM: input.phase2.trunkMaxLengthM,
  });
  if (trunk.polyline.length < 2) {
    return {
      lengthM: 0,
      polyline: [],
      points: [],
      worstVerdict: null,
      legsCompared: trunk.legsCompared,
    };
  }

  // La ligne du tronc va du point de livraison vers l'extérieur ; une jambe
  // entrante va dans l'autre sens. On la remet à l'endroit pour que S4 lise la
  // fenêtre d'approche terminale au bon bout.
  const inward = [...trunk.polyline].reverse();
  let ways;
  try {
    ways = await corridor.fetchCorridor(inward, input.candidates.corridorMarginM);
  } catch {
    // Un corridor muet coûte la mesure du tronc, jamais le run.
    return {
      lengthM: trunk.lengthM,
      polyline: trunk.polyline,
      points: [],
      worstVerdict: null,
      legsCompared: trunk.legsCompared,
    };
  }

  const candidate = candidateFromRoutedLeg({
    id: TRUNK_LEG_ID,
    direction: 'in',
    polyline: inward,
    corridor: ways,
    distanceM: trunk.lengthM,
    durationS: 0,
    generatedBy: 'car-optimal',
    egressOf: null,
    sampleStepM: input.candidates.sampleStepM,
    snapM: input.candidates.snapM,
    approachWindowM: input.candidates.approachWindowM,
    laneWidthM: input.candidates.laneWidthM,
    minCorridorCoverage: input.candidates.minCorridorCoverage,
    fetchedAt: input.fetchedAt,
  });

  const collected = collectCriticalPoints(
    {
      candidates: [candidate],
      corridors: new Map([[TRUNK_LEG_ID, ways]]),
      stop: input.stopFacts,
      topology: input.topology,
      fetchedAt: input.fetchedAt,
      terminalNodeInterior: input.terminalNodeInterior,
    },
    input.points,
  );

  return {
    lengthM: trunk.lengthM,
    polyline: trunk.polyline,
    points: collected.points,
    worstVerdict: worstVerdictOf(collected.points, input.truck, input.projection, input.policyVersion, input.fetchedAt),
    legsCompared: trunk.legsCompared,
  };
}

export const TRUNK_LEG_ID = 'trunk:in';

/**
 * Le pire verdict que ces points portent pour CE camion — sans réseau.
 *
 * C'est `projectTruck` qui répond, pas une règle écrite ici : le tronc doit
 * être jugé avec les mêmes yeux que les jambes, sinon un refus commun ne
 * voudrait rien dire. Aucun candidat n'est passé — seuls les verdicts de
 * points sont lus, et ils ne dépendent d'aucun itinéraire.
 */
export function worstVerdictOf(
  points: readonly CriticalPoint[],
  truck: TruckProfile,
  policy: ProjectionPolicy,
  policyVersion: string,
  fetchedAt: string,
): Verdict | null {
  if (points.length === 0) return null;
  const projection = projectTruck({
    candidates: [],
    // Aucun itinéraire : le tronc commun juge les points sur leur propre
    // géométrie, il n'y a pas de jambe dont lire la sienne.
    collected: { points, byCandidate: new Map(), geometryByCandidate: new Map() },
    truck,
    policy,
    policyVersion,
    validUntil: fetchedAt,
    routerFailed: false,
    // Le tronc commun ne forme aucun plan : la forme de l'arrêt ne sert qu'à typer l'appel,
    // et rien n'y est prouvé.
    stopShape: { kind: 'THROUGH', turnaround: { known: false, why: 'not_applicable' }, provenTopology: false },
  });
  const severity: Readonly<Record<Verdict, number>> = { OK: 0, HUMAN: 1, NO: 2 };
  let worst: Verdict = 'OK';
  for (const verdict of projection.pointVerdicts) {
    if (severity[verdict.verdict] > severity[worst]) worst = verdict.verdict;
  }
  return worst;
}
