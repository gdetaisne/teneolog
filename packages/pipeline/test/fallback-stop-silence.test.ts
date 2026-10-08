/**
 * Le test d'or de l'arrêt de repli : il ne change RIEN en aval.
 *
 * L'arrêt de repli (S1 bis `computeFallbackStop`, S2 bis `fallbackStopFacts`)
 * est calculé sur toute impasse et jamais choisi à la place de l'opérateur
 * (principe 10, complété le 2026-09-24) : c'est le fil qui le PROPOSE, et un
 * run lancé sur lui est un autre run. Ce fichier le prouve : le même run, joué
 * deux fois sur les mêmes ports et la même horloge, la policy
 * `assessment.fallbackStop` absente puis présente, doit rendre une `street`,
 * une `topology` (hors `fallbackStop`), un `stop`, des `candidates`, des
 * `collected`, une `projection`, un `summary` et une `gateSearch` DEEP-EQUAL.
 * Les seuls champs qui ont le droit de différer sont `topology.fallbackStop`
 * et `facts.fallbackStop` eux-mêmes — présents d'un côté seulement.
 *
 * Il remplace le témoin (`deadEndAvoidance`, 100 m à vol d'oiseau),
 * retiré tranche 2 : la règle d'hier contredisait celle-ci, et ce
 * qui a été rejeté sort du code (principe 22). Mêmes trois mondes — l'impasse
 * avec une rue traversante à 60 m, l'impasse sans, la rue traversante, où
 * l'arrêt de repli ne s'applique pas — plus un quatrième : l'impasse branchée
 * en T sur une rue qui continue des deux côtés, le seul où la bouche est
 * nommée, donc le seul où S1 bis MESURE un arrêt et où S2 bis tourne pour de
 * bon. Sans lui, le témoin ne verrait passer que des inconnues.
 */
import { describe, expect, it } from 'vitest';
import type { GeoPoint, TruckProfile } from '@teneolog/domain';
import type { RoadNeighbourhood, RoadWay } from '@teneolog/topology';

import type { PipelineParams } from '../src/analyse.js';
import { runFullAnalysis, type FullAnalysis, type FullParams, type FullPorts } from '../src/full.js';

const O: GeoPoint = { lat: 47.0, lon: 1.0 };
const M_PER_DEG_LAT = 111_320;

function at(northM: number, eastM: number): GeoPoint {
  return {
    lat: O.lat + northM / M_PER_DEG_LAT,
    lon: O.lon + eastM / (M_PER_DEG_LAT * Math.cos((O.lat * Math.PI) / 180)),
  };
}

function way(
  id: string,
  nodeIds: readonly string[],
  geometry: readonly GeoPoint[],
  overrides: Partial<RoadWay> = {},
): RoadWay {
  return {
    id,
    source: 'osm-overpass',
    nodeIds,
    geometry,
    name: null,
    importance: null,
    declaredWidthM: null,
    laneCount: null,
    oneWay: 'no',
    isPrivate: false,
    limits: { maxWeightT: null, maxHeightM: null, maxWidthM: null, maxLengthM: null },
    tags: { highway: 'residential' },
    ...overrides,
  };
}

function hoodOf(centre: GeoPoint, radiusM: number, ways: readonly RoadWay[]): RoadNeighbourhood {
  const positions = new Map<string, GeoPoint>();
  const owners = new Map<string, string[]>();
  for (const w of ways) {
    w.nodeIds.forEach((n, i) => {
      const p = w.geometry[i];
      if (p !== undefined) positions.set(n, p);
      const list = owners.get(n) ?? [];
      if (!list.includes(w.id)) list.push(w.id);
      owners.set(n, list);
    });
  }
  return {
    centre,
    radiusM,
    ways,
    nodes: [...positions].map(([id, p]) => ({ id, at: p, wayIds: owners.get(id) ?? [], tags: {} })),
  };
}

const PIPELINE: PipelineParams = {
  fetchLadderM: [80, 160],
  surfacesRadiusM: 120,
  selection: {
    maxSnapM: 30,
    ambiguityWindowM: 12,
    minWidthAdvantageM: 0.5,
    tipInteriorMarginM: 5,
    continuationDeviationDeg: 40,
    confidence: { unambiguous: 0.9, resolvedByRank: 0.75 },
  },
  assessment: {
    turnaroundSearchRadiusM: 120,
    maxMouthDepth: 2,
    maxDeviationDeg: 40,
    barrierSnapM: 6,
    measurement: {
      defaultTurningCircleDiameterM: null,
      fallbackCarriagewayWidthM: null,
      loopClosureToleranceM: 3,
    },
  },
  declaredWidthConfidence: 0.55,
  secondaryDescriptionSnapM: 25,
  geocoding: { minBanScore: 0.6 },
};

/** La policy de test, aux nombres près qui n'intéressent pas ce test. */
const BASE: FullParams = {
  pipeline: PIPELINE,
  gates: {
    searchRadiusM: 2000,
    gateCount: 5,
    minDistanceM: 500,
    //, etendu a R0 par zero, et non les 1 800 m de la prod :
    // les mondes de ces cas tiennent dans 900 m (les arteres sont a 800-900 m
    // de l'arret), donc le seuil de production n'y laisserait AUCUNE ancre R0
    // et, cote decouverte, ecarterait toutes les jambes posees sur le reseau
    // pour ne garder que les rayons tombes dans le vide a 2 000 m. Ces cas
    // mesurent le rapport de la decouverte, pas la portee ; la portee a ses
    // propres cas, a l'echelle reelle (packages/routes/test/discovery.test.ts,
    // packages/routes/test/gate-search.test.ts).
    minReachM: 0,
  },
  candidates: {
    alternativesPerGate: 1,
    corridorMarginM: 30,
    sampleStepM: 25,
    snapM: 25,
    approachWindowM: 150,
    laneWidthM: 3,
    minCorridorCoverage: 0.8,
    maxConcurrentFetches: 4,
  },
  points: {
    turns: { windowM: 40, minDeflectionDeg: 45, bearingOffsetM: 10, mergeWithinM: 25, geometryConfidence: 0.7, curveIgnoreRadiusM: 60, junction: { nodeSnapM: 6, apexShare: 0.8 } },
    roundabouts: { ringSnapM: 8, ringMergeM: 40, geometryConfidence: 0.7, declaredWidthConfidence: 0.55 },
    narrowMaxFreeM: 5,
    dedupeWithinM: 15,
    chainedWithinM: 40,
  },
  projection: {
    lateralClearanceM: 0.8,
    turnSweptClearanceM: 1.0,
    roundaboutSweptClearanceM: 1.0,
    turnaroundClearanceM: 2.0,
    comfortMarginM: 0.4,
    publishableConfidence: 0.55,
    hgvThresholdT: 3.5,
    passingLaneWidthM: 2.75,
  },
  discovery: {
    enabled: false,
    rounds: [4, 8, 24],
    radiusM: 2000,
    windowM: 1000,
    maxConcurrent: 4,
    stopWhen: { minMarginM: 0.4 },
  },
  obviousStop: { declaredWidthMinM: 10, measuredWidthMinM: 6.5 },
  policyVersion: 'test',
  reportShelfLifeDays: 30,
};

/**
 * La policy de test : les deux bandes du principe 10, le recul de 15 m,
 * la zone cliquable — et la marche arrière mesurée, l'autre champ
 * additif de S1 : les deux passent ensemble par le même test d'or.
 */
const WITH_FALLBACK: FullParams = {
  ...BASE,
  pipeline: {
    ...PIPELINE,
    assessment: {
      ...PIPELINE.assessment,
      fallbackStop: { plainWalkMaxM: 50, portageWalkMaxM: 150, stopOffsetM: 15, freePointRadiusM: 300 },
      reversing: { straightMaxDeflectionDeg: 15 },
      // la géométrie de l'impasse pour la carte du demi-tour : le
      // troisième champ additif de S1, au même test d'or.
      impasseGeometry: { maxBranchAlongM: 120 },
    },
  },
};

const TRUCK: TruckProfile = {
  id: 'pl-19t',
  label: 'Porteur 19 t',
  family: 'rigid',
  envelope: { lengthM: 9, widthM: 2.5, heightM: 3.5, gvwT: 19, turnRadiusM: 11, wheelbaseM: 6.1, frontOverhangM: 1.7, rearOverhangM: 1.7 },
  equipment: { tailLift: true, crane: false, refrigerated: false },
};

interface World {
  readonly name: string;
  /** Le voisinage vu par S0 — la rue de livraison et ce qui l'entoure. */
  readonly local: readonly RoadWay[];
  /** Le réseau structurant vu par S3, pour que le run aille jusqu'au bout. */
  readonly structuring: readonly RoadWay[];
}

const ARTERIAL = way('arterial', ['g1', 'g2'], [at(800, 0), at(900, 0)], {
  tags: { highway: 'primary' },
  declaredWidthM: 7,
});

/** L'impasse : une villa qui part d'une rue amont et finit en cul-de-sac. */
const VILLA = way('villa', ['j', 'tip'], [at(-4, -10), at(-4, 45)], {
  name: 'Villa Test',
  declaredWidthM: 4,
});
const FEEDER = way('feeder', ['f0', 'j'], [at(-4, -300), at(-4, -10)], { name: 'Rue Amont' });

/**
 * L'impasse en T : la villa part d'une rue nord-sud qui continue des deux
 * côtés du carrefour et sort du champ. La porte est à 40 m de la parente,
 * au-delà du rayon d'accrochage : la rue de livraison reste la villa.
 */
const TEE_VILLA = way('villa', ['t', 'tip'], [at(-4, -40), at(-4, 45)], {
  name: 'Villa Test',
  declaredWidthM: 4,
});
const TEE_PARENT = way('parent', ['p0', 't', 'p1'], [at(-400, -40), at(-4, -40), at(400, -40)], {
  name: 'Rue Traversante',
  declaredWidthM: 6,
});

function worlds(): readonly World[] {
  const boulevardAt = (northM: number) =>
    way('boulevard', ['b0', 'b1'], [at(northM, -300), at(northM, 300)], {
      name: 'Boulevard Test',
      tags: { highway: 'secondary' },
      declaredWidthM: 8,
    });
  // Une VRAIE traversante : ses deux bouts sont des carrefours, et ce qu'on
  // atteint par eux sort du champ. Sans ces deux amorces, une rue coupée par
  // le fetch a deux bouts morts et S1 la lit DEAD_END — ce qui ne prouverait
  // pas le cas qu'on veut ici.
  const through = way('street', ['a', 'b'], [at(0, -100), at(0, 100)], {
    name: 'Rue Test',
    declaredWidthM: 8,
  });
  const westLink = way('west-link', ['w', 'a'], [at(-300, -100), at(0, -100)]);
  const eastLink = way('east-link', ['b', 'e'], [at(0, 100), at(300, 100)]);
  return [
    {
      name: 'impasse avec une traversante à 60 m',
      local: [VILLA, FEEDER, boulevardAt(60)],
      structuring: [VILLA, FEEDER, boulevardAt(60), ARTERIAL],
    },
    {
      name: 'impasse sans traversante à portée',
      local: [VILLA, FEEDER, boulevardAt(140)],
      structuring: [VILLA, FEEDER, boulevardAt(140), ARTERIAL],
    },
    {
      name: 'rue traversante',
      local: [through, westLink, eastLink],
      structuring: [through, westLink, eastLink, ARTERIAL],
    },
    {
      name: 'impasse en T sur une rue qui continue',
      local: [TEE_VILLA, TEE_PARENT],
      structuring: [TEE_VILLA, TEE_PARENT, ARTERIAL],
    },
  ];
}

function ports(world: World): FullPorts {
  return {
    geocode: {
      geocode: async () => [
        { source: 'ban', point: O, score: 0.95, formatted: '1 Rue Test', banId: null, positionType: null },
      ],
    },
    graph: { fetchNeighbourhood: async (_c, r) => hoodOf(O, r, world.local) },
    surfaces: { fetchSurfaces: async () => [] },
    structuring: { fetchStructuring: async (_c, r) => hoodOf(O, r, world.structuring) },
    routing: {
      route: async (from, to) => {
        const polyline: GeoPoint[] = [];
        for (let i = 0; i <= 8; i += 1) {
          polyline.push({
            lat: from.lat + ((to.lat - from.lat) * i) / 8,
            lon: from.lon + ((to.lon - from.lon) * i) / 8,
          });
        }
        return [{ polyline, distanceM: 800, durationS: 90 }];
      },
    },
    corridor: { fetchCorridor: async () => [...world.structuring] },
  };
}

/** Une horloge figée : deux runs comparables doivent porter le même instant. */
const frozen = () => '2026-09-11T10:00:00.000Z';

async function runWith(world: World, params: FullParams) {
  const outcome = await runFullAnalysis(
    { kind: 'address', address: '1 Rue Test' },
    TRUCK,
    ports(world),
    params,
    frozen,
  );
  if (!outcome.ok) throw new Error(`${world.name} : ${outcome.stage}/${outcome.why}`);
  return outcome.analysis;
}

/** Le run sans l'arrêt de repli, là où il vit : dans la topologie et dans les faits. */
function withoutFallback(analysis: FullAnalysis): FullAnalysis {
  const { fallbackStop: _facts, ...facts } = analysis.facts;
  const {
    fallbackStop: _place,
    reversing: _reversing,
    impasseGeometry: _impasseGeometry,
    ...topology
  } = analysis.facts.topology;
  return { ...analysis, facts: { ...facts, topology } };
}

/**
 * Le compte rendu de la phase 2 sans son mur (`durationMs`, l'horloge réelle
 * de l'orchestration) : la seule valeur que deux runs identiques ne peuvent
 * pas partager, et qui ne décide de rien.
 */
function withoutWallClock(analysis: FullAnalysis): FullAnalysis {
  return analysis.phase2 === null
    ? analysis
    : { ...analysis, phase2: { ...analysis.phase2, durationMs: 0 } };
}

describe('l’arrêt de repli ne change rien en aval', () => {
  for (const world of worlds()) {
    it(`témoin : ${world.name}`, async () => {
      const off = await runWith(world, BASE);
      const on = await runWith(world, WITH_FALLBACK);

      // Le point de livraison, la rue retenue, l'arrêt : bit pour bit.
      expect(on.facts.anchor).toEqual(off.facts.anchor);
      expect(on.facts.stop).toEqual(off.facts.stop);
      expect(withoutFallback(on).facts.topology).toEqual(off.facts.topology);
      // Et tout le reste de l'analyse, y compris le verdict.
      expect(on.candidates).toEqual(off.candidates);
      expect(on.collected).toEqual(off.collected);
      expect(on.projection).toEqual(off.projection);
      expect(on.summary).toEqual(off.summary);
      expect(on.gateSearch).toEqual(off.gateSearch);
      // Le filet : l'analyse ENTIÈRE, à l'arrêt de repli et au chronomètre
      // près. Un champ neuf qu'il ferait bouger tomberait ici même s'il n'est
      // pas listé au-dessus.
      expect(withoutWallClock(withoutFallback(on))).toEqual(withoutWallClock(off));

      // Policy absente : rien n'a été calculé, ni en S1 bis ni en S2 bis.
      expect(off.facts.topology.fallbackStop).toBeUndefined();
      expect(off.facts.topology.impasseGeometry).toBeUndefined();
      expect(off.facts.fallbackStop).toBeUndefined();
    });
  }
});

describe('ce que l’arrêt de repli, lui, rapporte', () => {
  it('impasse en T : S1 bis mesure l’arrêt sur la parente, S2 bis y lit la largeur', async () => {
    const world = worlds()[3] as World;
    const on = await runWith(world, WITH_FALLBACK);
    expect(on.facts.topology.topology.kind).toBe('DEAD_END');

    const place = on.facts.topology.fallbackStop;
    if (place === undefined || !place.known) throw new Error('arrêt de repli non mesuré');
    expect(place.value.street.segmentId).toBe('parent');
    // Et la marche arrière est MESURÉE dans ce monde : sans cette
    // ligne, le test de silence passerait même si elle redevenait toujours
    // inconnue (relecture Opus du 24/09). Même longueur que la bouche.
    const reversing = on.facts.topology.reversing;
    if (reversing === undefined || !reversing.known) throw new Error('marche arrière non mesurée');
    expect(reversing.value.lengthM).toBeCloseTo(40, 0);
    // Et la géométrie de l'impasse aussi : l'axe part de la bouche,
    // la parente y donne deux bras — sans quoi le silence passerait même si
    // elle redevenait toujours inconnue.
    const geometry = on.facts.topology.impasseGeometry;
    if (geometry === undefined || !geometry.known) throw new Error('géométrie de l’impasse non mesurée');
    expect(geometry.value.stopAlongM).toBeCloseTo(40, 0);
    expect(geometry.value.branches.map((b) => [b.wayId, b.side, b.isMouth])).toEqual([
      ['parent', 'left', true],
      ['parent', 'right', true],
    ]);
    // À pied le long de la voie : 15 m de l'arrêt au carrefour (le recul de
    // policy), 40 m du carrefour à la projection de la porte le long de la
    // villa, 4 m de la projection à la porte. 59 m : la bande du portage.
    expect(place.value.walk.stopToMouthM).toBeCloseTo(15, 0);
    expect(place.value.walk.mouthToPointM).toBeCloseTo(40, 0);
    expect(place.value.walk.pointToAxisM).toBeCloseTo(4, 0);
    expect(place.value.band).toBe('portage');

    const facts = on.facts.fallbackStop;
    if (facts === undefined || !facts.known) throw new Error('S2 bis absent');
    // S2 bis porte la place de S1 bis telle quelle — une seule lecture.
    expect(facts.value.place).toEqual(place.value);
    expect(facts.value.stop.at).toEqual(place.value.stopAt);
    // La largeur déclarée de la PARENTE (6 m), pas celle de la villa (4 m).
    expect(facts.value.stop.width.known && facts.value.stop.width.reliability.basis).toBe('declared');
    expect(facts.value.stop.width.known ? facts.value.stop.width.value.freeM : null).toBe(6);
  });

  it('impasse sans bouche nommée : l’inconnue de S1 bis, rendue telle quelle par S2 bis', async () => {
    for (const world of worlds().slice(0, 2)) {
      const on = await runWith(world, WITH_FALLBACK);
      expect(on.facts.topology.topology.kind, world.name).toBe('DEAD_END');
      expect(on.facts.topology.fallbackStop, world.name).toEqual({ known: false, why: 'no_data' });
      expect(on.facts.fallbackStop, world.name).toEqual({ known: false, why: 'no_data' });
      // La géométrie, elle, se passe de bouche : la rue amont
      // continue la villa tout droit et sort du champ, la chaîne n'a qu'un
      // bout fermé — c'est lui qui donne le sens d'entrée, et c'est dit.
      const geometry = on.facts.topology.impasseGeometry;
      expect(geometry?.known && geometry.reliability.reasonCodes, world.name).toEqual([
        'axis_oriented_by_closed_tip_no_mouth',
      ]);
    }
  });

  it('rue traversante : « sans objet », qui n’est pas « cherché, rien trouvé »', async () => {
    const world = worlds()[2] as World;
    const on = await runWith(world, WITH_FALLBACK);
    expect(on.facts.topology.topology.kind).toBe('THROUGH');
    expect(on.facts.topology.fallbackStop).toEqual({ known: false, why: 'not_applicable' });
    expect(on.facts.topology.impasseGeometry).toEqual({ known: false, why: 'not_applicable' });
    // S2 bis rend l'inconnue de S1 bis telle quelle : pas de contraintes
    // inventées pour un arrêt qui n'existe pas (principe 14).
    expect(on.facts.fallbackStop).toEqual({ known: false, why: 'not_applicable' });
  });
});
