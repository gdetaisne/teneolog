/**
 * LE COIN DE THAIRÉ, monté une fois — le décor des deux tests d'or de
 * `TURN@46.0733,-0.9649` ( pour le verdict par jambe pour le
 * classement).
 *
 * Sorti de `thaire-corner-golden.test.ts` quand a eu besoin du MÊME
 * relevé au niveau des plans : deux exemplaires du chargement de fixtures
 * seraient deux corpus qui divergent, et c'est exactement ce que le test d'or
 * existe pour empêcher (principe 23).
 *
 * D'OÙ VIENNENT LES FAITS. Les vraies polylignes du run `382e9a97` et l'extrait
 * Overpass de la commune, capturés une fois le 2026-09-12 dans
 * `packages/points/test/fixtures/thaire/` — lus ici par leur chemin, pas
 * recopiés. Aucun réseau, aucun tunnel.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type {
  Fact,
  GeoPoint,
  RouteCandidate,
  TruckProfile,
  Width,
} from '@teneolog/domain';
import { collectCriticalPoints, type CollectedPoints, type CollectPointsParams } from '@teneolog/points';
import type { RoadWay } from '@teneolog/topology';

import type { ProjectionPolicy } from '../../src/policy.js';

export const AT = '2026-09-12T00:00:00Z';

/** La policy de référence (`config/policy.example.json`, bloc `points`). */
export const PARAMS: CollectPointsParams = {
  turns: {
    windowM: 40,
    minDeflectionDeg: 45,
    bearingOffsetM: 10,
    mergeWithinM: 25,
    geometryConfidence: 0.7,
    curveIgnoreRadiusM: 60,
    junction: { nodeSnapM: 6, apexShare: 0.8 },
  },
  roundabouts: {
    ringSnapM: 8,
    ringMergeM: 40,
    geometryConfidence: 0.7,
    declaredWidthConfidence: 0.55,
  },
  narrowMaxFreeM: 5,
  dedupeWithinM: 15,
  chainedWithinM: 40,
};

/** La policy de référence, bloc `projection` — `plans` et `conclusion` comprises. */
export const POLICY: ProjectionPolicy = {
  lateralClearanceM: 0.8,
  turnSweptClearanceM: 1.0,
  roundaboutSweptClearanceM: 1.0,
  turnaroundClearanceM: 2.0,
  comfortMarginM: 0.4,
  // la bande de confort du semi, comme dans la policy de référence
  // (proposition du principe 31, à confirmer par le responsable produit).
  comfortMarginByFamilyM: { semi: 0.8 },
  publishableConfidence: 0.55,
  hgvThresholdT: 3.5,
  passingLaneWidthM: 2.75,
  plans: { straightToleranceDeg: 60, headingSpanM: 20 },
  conclusion: { mode: 'plans' },
};

/** Les trois gabarits du catalogue livré, enveloppes comprises. */
export const TRUCKS: readonly TruckProfile[] = [
  {
    id: 'vul-fourgon',
    label: 'Fourgon',
    family: 'vul',
    envelope: { lengthM: 6, widthM: 2.1, heightM: 2.5, gvwT: 3.5, turnRadiusM: 7, wheelbaseM: 3.7, frontOverhangM: 0.9, rearOverhangM: 1.4 },
    equipment: { tailLift: false, crane: false, refrigerated: false },
  },
  {
    id: 'pl-19t',
    label: 'Porteur 19 t',
    family: 'rigid',
    envelope: { lengthM: 9, widthM: 2.5, heightM: 3.5, gvwT: 19, turnRadiusM: 11, wheelbaseM: 6.1, frontOverhangM: 1.2, rearOverhangM: 1.7 },
    equipment: { tailLift: true, crane: false, refrigerated: false },
  },
  {
    id: 'semi-44t',
    label: 'Semi-remorque 44 t',
    family: 'semi',
    // `kingPinToRearAxleM` comme dans le catalogue livré depuis c'est
    // la sellette → essieu qui conduit le déport d'un articulé, pas
    // l'empattement du tracteur (principe 31, `effectiveOffTrackWheelbaseM`).
    envelope: { lengthM: 16.5, widthM: 2.55, heightM: 4, gvwT: 44, turnRadiusM: 15, wheelbaseM: 3.9, kingPinToRearAxleM: 7.7, frontOverhangM: 1.4, rearOverhangM: 3 },
    equipment: { tailLift: false, crane: false, refrigerated: false },
  },
];

export function truck(id: string): TruckProfile {
  const found = TRUCKS.find((t) => t.id === id);
  if (found === undefined) throw new Error(`gabarit inconnu : ${id}`);
  return found;
}

/** La grise : arrive par la Rue Voisine 14 (3,0 m déclarés), 57°. */
export const GREY = '119513478@56:in';
/** La bleue : arrive par Exemple (5,2 m), 98° — même coin, autre manœuvre. */
export const BLUE = 'disc:r2@285:in';
export const CORNER: GeoPoint = { lat: 46.0733, lon: -0.9649 };

function fixture(name: string): unknown {
  const path = fileURLToPath(
    new URL(`../../../points/test/fixtures/thaire/${name}`, import.meta.url),
  );
  return JSON.parse(readFileSync(path, 'utf8'));
}

interface OsmNode { readonly type: 'node'; readonly id: number; readonly lat: number; readonly lon: number }
interface OsmWay { readonly type: 'way'; readonly id: number; readonly nodes: readonly number[]; readonly tags: Record<string, string> }

export function corridorWays(): readonly RoadWay[] {
  const raw = fixture('jury-thaire-osm-corridor.json') as { elements: readonly (OsmNode | OsmWay)[] };
  const nodes = new Map<number, GeoPoint>();
  for (const element of raw.elements) {
    if (element.type === 'node') nodes.set(element.id, { lat: element.lat, lon: element.lon });
  }
  const ways: RoadWay[] = [];
  for (const element of raw.elements) {
    if (element.type !== 'way') continue;
    const geometry = element.nodes.map((id) => nodes.get(id)).filter((p): p is GeoPoint => p !== undefined);
    if (geometry.length !== element.nodes.length) continue;
    ways.push({
      id: String(element.id),
      source: 'osm-overpass',
      nodeIds: element.nodes.map(String),
      geometry,
      name: element.tags['name'] ?? null,
      importance: null,
      declaredWidthM: null,
      laneCount: null,
      oneWay: element.tags['oneway'] === 'yes' ? 'forward' : 'no',
      isPrivate: false,
      limits: { maxWeightT: null, maxHeightM: null, maxWidthM: null, maxLengthM: null },
      tags: element.tags },
    );
  }
  return ways;
}

export function candidate(id: string): RouteCandidate {
  const raw = fixture('jury-thaire-routes-geo.json') as {
    data: { candidates: { value: readonly RouteCandidate[] } };
  };
  const found = raw.data.candidates.value.find((c) => c.id === id);
  if (found === undefined) throw new Error(`jambe absente de la fixture : ${id}`);
  return found;
}

/** Le 12 Rue de l’Exemple, tel que le run l'a géocodé. Rue traversante. */
const STOP_AT: GeoPoint = { lat: 46.073482, lon: -0.965414 };

/** La largeur de l'arrêt telle que le run l'a laissée : jamais mesurée. */
export const STOP_WIDTH_UNKNOWN: Fact<Width> = { known: false, why: 'no_data' };

/**
 * Une largeur MESURÉE à l'arrêt — 8,0 m, hors de tout doute pour les trois
 * gabarits.
 *
 * Pourquoi elle existe : dans le run réel, `DESTINATION` est HUMAIN sur toutes
 * les jambes (la largeur n'a jamais été mesurée), ce qui rend tout plan HUMAIN
 * et masque ce que le classement fait du coin. La poser mesurée ne change rien
 * au coin — c'est l'arrêt, 300 m plus loin — et laisse voir le verdict du plan.
 */
export const STOP_WIDTH_MEASURED: Fact<Width> = {
  known: true,
  value: { freeM: 8, structuralM: 8, measuredAt: STOP_AT, offsetFromAnchorM: 0 },
  provenance: { source: 'ign-ortho', method: 'd10', fetchedAt: AT },
  reliability: { confidence: 0.9, basis: 'measured', reasonCodes: [] },
};

/**
 * Le relevé S4 pour un jeu de jambes donné, sur le corridor de la commune.
 *
 * `egressOf: null` sur toutes : les plans apparient n'importe quelle entrante
 * avec n'importe quelle sortante, et garder l'appariement de R0
 * ferait juger une règle d'hier.
 */
export function collectFor(
  ids: readonly string[],
  stopWidth: Fact<Width>,
): { readonly candidates: readonly RouteCandidate[]; readonly collected: CollectedPoints } {
  const candidates = ids.map((id) => ({ ...candidate(id), egressOf: null }));
  const collected = collectCriticalPoints(
    {
      candidates,
      corridors: new Map(candidates.map((c) => [c.id, corridorWays()])),
      stop: {
        at: STOP_AT,
        width: stopWidth,
        slopePct: { known: false, why: 'no_data' },
        legal: {
          maxWeightT: { known: false, why: 'no_data' },
          maxHeightM: { known: false, why: 'no_data' },
          maxWidthM: { known: false, why: 'no_data' },
          maxLengthM: { known: false, why: 'no_data' },
          access: { known: false, why: 'no_data' },
          lowEmissionZone: { known: false, why: 'no_data' },
        },
        surface: { known: false, why: 'no_data' },
      },
      topology: {
        kind: 'THROUGH',
        continuity: { establishedBy: 'same_way', deviationDeg: 0, attributeBreak: false },
      },
      fetchedAt: AT,
    },
    PARAMS,
  );
  return { candidates, collected };
}
