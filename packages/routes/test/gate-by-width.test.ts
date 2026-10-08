/**
 * l'ancre par largeur : où elle tombe, et où elle refuse de tomber.
 *
 * La règle tient en une phrase (`gate-by-width.ts`) : en remontant du point de
 * livraison vers l'extérieur, l'ancre est le PREMIER point d'où tout ce qui
 * reste, jusqu'au rayon, est acceptable. Ce fichier la met à l'épreuve sur les
 * quatre géométries qui comptent — large partout, rétrécissement, largeur
 * inconnue, tronçon large isolé — plus le plafond et la panne de corridor.
 *
 * Le seuil n'est pas choisi ici : les tests passent 3,7 m, c'est-à-dire
 * `comfortableWidthM` d'un pl-19t sur la policy de test (2,5 + 0,8 + 0,4).
 */
import { describe, expect, it } from 'vitest';
import type { GeoPoint } from '@teneolog/domain';
import type { RoadWay } from '@teneolog/topology';

import type { DraftApproach } from '../src/discovery.js';
import { anchorFromProfile, outwardLine, placeGatesByWidth } from '../src/gate-by-width.js';
import type { CorridorPort } from '../src/ports.js';

const O: GeoPoint = { lat: 47.0, lon: 1.0 };
const M_PER_DEG_LAT = 111_320;

function at(northM: number): GeoPoint {
  return { lat: O.lat + northM / M_PER_DEG_LAT, lon: O.lon };
}

function way(id: string, fromM: number, toM: number, overrides: Partial<RoadWay> = {}): RoadWay {
  return {
    id,
    source: 'osm-overpass',
    nodeIds: [`${id}:0`, `${id}:1`],
    geometry: [at(fromM), at(toM)],
    name: id,
    importance: null,
    declaredWidthM: null,
    laneCount: null,
    oneWay: 'no',
    isPrivate: false,
    limits: { maxWeightT: null, maxHeightM: null, maxWidthM: null, maxLengthM: null },
    tags: { highway: 'tertiary' },
    ...overrides,
  };
}

/** Une jambe entrante rectiligne : origine à `lengthM` au nord, arrivée à l'arrêt. */
function approach(key: string, lengthM = 2_200): DraftApproach {
  const polyline: GeoPoint[] = [];
  for (let m = lengthM; m >= 0; m -= 50) polyline.push(at(m));
  return {
    key,
    direction: 'in',
    firstRound: 1,
    originAzimuthDeg: 0,
    distanceM: lengthM,
    durationS: 120,
    polyline,
    widthProfile: null,
    gateByWidth: null,
  };
}

/** Le seuil d'un pl-19t sur la policy de test : 2,5 + 0,8 + 0,4. */
const REQUIRED_M = 3.7;
const AT = '2026-09-11T10:00:00.000Z';

function corridorOf(ways: readonly RoadWay[]): CorridorPort {
  return { fetchCorridor: async () => ways };
}

async function place(
  ways: readonly RoadWay[],
  approaches: readonly DraftApproach[] = [approach('a')],
  overrides: Partial<Parameters<typeof placeGatesByWidth>[0]> = {},
  corridor: CorridorPort = corridorOf(ways),
) {
  return placeGatesByWidth(
    {
      stop: O,
      approachesIn: approaches,
      approachesOut: [],
      requiredWidthM: REQUIRED_M,
      truckId: 'pl-19t',
      radiusM: 2_000,
      corridorMarginM: 30,
      sampleStepM: 25,
      snapM: 25,
      laneWidthM: 3,
      maxApproaches: 12,
      maxConcurrent: 4,
      fetchedAt: AT,
      ...overrides,
    },
    corridor,
  );
}

describe("où l'ancre par largeur tombe", () => {
  it('large de bout en bout : rien à contrôler, l’ancre est contre le point de livraison', async () => {
    const result = await place([way('wide', 0, 2_200, { declaredWidthM: 6 })]);
    const gate = result.approachesIn[0]?.gateByWidth;

    // C'est la conséquence assumée de la règle, et c'est ce que veut §7.1 :
    // « si je suis sur une rue de 8 m de large, ça doit être instantané ».
    // Une voie assez large sur toute l'approche ne demande AUCUN contrôle,
    // donc le réseau à contrôler est vide et l'ancre est au point de livraison.
    expect(gate?.basis).toBe('width');
    expect(gate?.distanceFromDeliveryM).toBe(0);
    expect(gate?.reason).toBe('wide_from_the_delivery_point');
    expect(gate?.wayId).toBe('wide');
    expect(gate?.widthM).toBe(6);
    expect(gate?.widthSource).toBe('osm');
    expect(gate?.requiredWidthM).toBe(REQUIRED_M);
    expect(gate?.firstNarrowSegment).toBeNull();
  });

  it('rétrécissement à 600 m : l’ancre est à 600 m, et dit ce qui l’a poussée là', async () => {
    const result = await place([
      way('narrow', 0, 590, { declaredWidthM: 3, tags: { highway: 'residential' } }),
      way('wide', 590, 2_200, { declaredWidthM: 6 }),
    ]);
    const gate = result.approachesIn[0]?.gateByWidth;

    expect(gate?.basis).toBe('width');
    expect(gate?.distanceFromDeliveryM).toBe(600);
    expect(gate?.wayId).toBe('wide');
    expect(gate?.reason).toBe('first_wide_beyond_the_narrow');
    // Les 600 derniers mètres sont ce que S4 doit contrôler, et la rue qui
    // l'impose est nommée, pas seulement comptée.
    expect(gate?.firstNarrowSegment).toEqual({ wayId: 'narrow', widthM: 3, atM: 0 });
  });

  it('largeur inconnue partout : repli par la CLASSE, dit comme tel', async () => {
    const result = await place([way('mute', 0, 2_200)]); // tertiary, aucune largeur
    const gate = result.approachesIn[0]?.gateByWidth;

    expect(gate?.basis).toBe('class');
    expect(gate?.widthM).toBeNull();
    expect(gate?.widthSource).toBe('class_fallback');
    expect(gate?.reason).toBe('class_fallback');
    expect(gate?.highway).toBe('tertiary');
  });

  it('largeur inconnue sur une voie LOCALE : pas de repli — on ne sait pas, donc on contrôle', async () => {
    const result = await place([way('local', 0, 2_200, { tags: { highway: 'residential' } })]);
    const gate = result.approachesIn[0]?.gateByWidth;

    expect(gate?.basis).toBe('none');
    expect(gate?.reason).toBe('never_wide_enough');
    expect(gate?.point).toBeNull();
  });

  it('tronçon large isolé entre deux étroits : pas d’ancre là, ni ailleurs', async () => {
    const result = await place([
      way('narrow-1', 0, 590, { declaredWidthM: 3, tags: { highway: 'residential' } }),
      way('island', 590, 990, { declaredWidthM: 6 }),
      way('narrow-2', 990, 2_200, { declaredWidthM: 3, tags: { highway: 'residential' } }),
    ]);
    const gate = result.approachesIn[0]?.gateByWidth;

    // 600 m est large, mais ne tient pas jusqu'au bout : l'ancre ne s'y pose
    // pas. C'est toute la différence entre « large ici » et « large à partir
    // d'ici », et c'est la règle entière.
    expect(gate?.basis).toBe('none');
    expect(gate?.distanceFromDeliveryM).toBeNull();
    expect(gate?.reason).toBe('never_wide_enough');
    expect(gate?.firstNarrowSegment).toEqual({ wayId: 'narrow-1', widthM: 3, atM: 0 });
  });

  it('une largeur au seuil exact passe : la borne est inclusive, comme `band`', async () => {
    const result = await place([way('exact', 0, 2_200, { declaredWidthM: REQUIRED_M })]);
    expect(result.approachesIn[0]?.gateByWidth?.basis).toBe('width');
  });

  it('l’exigence s’arrête au rayon : un rétrécissement au-delà ne compte pas', async () => {
    const result = await place([
      way('wide', 0, 2_010, { declaredWidthM: 6 }),
      way('narrow-far', 2_010, 2_400, { declaredWidthM: 3, tags: { highway: 'residential' } }),
    ]);
    const gate = result.approachesIn[0]?.gateByWidth;
    expect(gate?.basis).toBe('width');
    expect(gate?.distanceFromDeliveryM).toBe(0);
  });
});

describe('la provenance de la largeur', () => {
  it('une largeur greffée depuis la BD TOPO se dit `bdtopo`, et se compte', async () => {
    const grafted = way('wide', 0, 2_200, {
      declaredWidthM: 6,
      attributed: {
        declaredWidthM: {
          source: 'bdtopo-postgis',
          donorWayId: 'TRONROUT042',
          offsetM: 0.7,
          coverage: 0.95,
        },
      },
    });
    const result = await place([grafted]);

    expect(result.approachesIn[0]?.gateByWidth?.widthSource).toBe('bdtopo');
    expect(result.byWidth.waysWithBdtopoWidth).toBe(1);
    expect(result.byWidth.cost.bdtopoQueries).toBe(1);
    expect(result.byWidth.waysLoaded).toBe(1);
  });

  it('un nombre de voies tient lieu de largeur, et reste de l’OSM', async () => {
    const result = await place([way('lanes', 0, 2_200, { laneCount: 2 })]); // 2 × 3 m = 6 m
    const gate = result.approachesIn[0]?.gateByWidth;
    expect(gate?.widthM).toBe(6);
    expect(gate?.widthSource).toBe('osm');
    expect(result.byWidth.waysWithBdtopoWidth).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// une largeur appartient au couple (voie, corridor)
// ---------------------------------------------------------------------------

/** Vers l'est, pour une deuxième approche qui ne partage pas la géométrie de la première. */
function eastAt(eastM: number): GeoPoint {
  return { lat: O.lat, lon: O.lon + eastM / (M_PER_DEG_LAT * Math.cos((O.lat * Math.PI) / 180)) };
}

function eastWay(id: string, fromM: number, toM: number, overrides: Partial<RoadWay> = {}): RoadWay {
  return { ...way(id, 0, 0, overrides), geometry: [eastAt(fromM), eastAt(toM)] };
}

/** La même jambe entrante, mais partant vers l'est. */
function eastApproach(key: string, lengthM = 2_200): DraftApproach {
  const polyline: GeoPoint[] = [];
  for (let m = lengthM; m >= 0; m -= 50) polyline.push(eastAt(m));
  return { ...approach(key, lengthM), key, polyline };
}

describe('deux corridors, deux largeurs pour la même voie', () => {
  // Le fait mesuré (A/B §4) : à Thairé, la voie OSM 755175098 est
  // créditée 5,2 m par le profil et 3,0 m par l'annotation de la jambe. Les
  // deux passent par `wayWidthFact`, et la BD TOPO ne se contredit pas : c'est
  // la GREFFE qui diffère. `graftDeclaredWidth` ne juge la voie que sur ses
  // échantillons DANS l'emprise du corridor (`corridorExtent`), et une voie OSM
  // longue croise plusieurs tronçons BD TOPO — donc deux corridors qui en
  // voient deux bouts différents greffent deux largeurs différentes, chacune
  // vraie là où elle a été lue. La largeur appartient au couple (voie,
  // corridor), jamais à l'identifiant de voie seul.
  const sharedId = '755175098';

  const northWays: readonly RoadWay[] = [
    way(sharedId, 0, 600, { declaredWidthM: 5.2 }),
    way('wide-n', 600, 2_200, { declaredWidthM: 6 }),
  ];
  const eastWays: readonly RoadWay[] = [
    eastWay(sharedId, 0, 600, { declaredWidthM: 3.0, tags: { highway: 'residential' } }),
    eastWay('wide-e', 600, 2_200, { declaredWidthM: 6 }),
  ];

  /** Chaque corridor rend SES voies — c'est ce que fait la greffe par emprise. */
  const twoCorridors: CorridorPort = {
    fetchCorridor: async (line) => {
      const second = line[1] as GeoPoint;
      return second.lon > O.lon ? eastWays : northWays;
    },
  };

  it('chaque approche garde la largeur de SON corridor', async () => {
    const result = await place(
      [],
      [approach('nord'), eastApproach('est')],
      {},
      twoCorridors,
    );

    const north = result.approachesIn[0];
    const east = result.approachesIn[1];

    // Au nord, 5,2 m passe le seuil de 3,7 m : rien à contrôler.
    expect(north?.widthProfile?.[0]?.wayId).toBe(sharedId);
    expect(north?.widthProfile?.[0]?.widthM).toBe(5.2);
    expect(north?.gateByWidth?.distanceFromDeliveryM).toBe(0);
    expect(north?.gateByWidth?.reason).toBe('wide_from_the_delivery_point');

    // À l'est, la MÊME voie mesure 3,0 m : les 600 premiers mètres sont à
    // contrôler, et c'est elle qui l'impose. Avant, le mémo partagé
    // lui rendait le 5,2 m du nord et faisait taire, silencieusement, tout ce
    // qu'il y a en amont.
    expect(east?.widthProfile?.[0]?.wayId).toBe(sharedId);
    expect(east?.widthProfile?.[0]?.widthM).toBe(3.0);
    expect(east?.gateByWidth?.distanceFromDeliveryM).toBe(600);
    expect(east?.gateByWidth?.wayId).toBe('wide-e');
    expect(east?.gateByWidth?.firstNarrowSegment).toEqual({
      wayId: sharedId,
      widthM: 3.0,
      atM: 0,
    });
  });

  it('l’ordre des approches ne change rien : ni l’une ni l’autre ne gagne', async () => {
    const result = await place(
      [],
      [eastApproach('est'), approach('nord')],
      {},
      twoCorridors,
    );

    expect(result.approachesIn[0]?.widthProfile?.[0]?.widthM).toBe(3.0);
    expect(result.approachesIn[1]?.widthProfile?.[0]?.widthM).toBe(5.2);
  });

  it('le recouvrement reste compté par VOIE : trois corridors, une voie', async () => {
    const ways = [way('wide', 0, 2_200, { declaredWidthM: 6 })];
    const result = await place(ways, [approach('a'), approach('b'), approach('c')]);
    // `waysLoaded` dit toujours ce qu'il disait — combien de voies distinctes
    // les approches se partagent — alors que les largeurs, elles, ne se
    // partagent plus.
    expect(result.byWidth.waysLoaded).toBe(1);
  });
});

describe('le coût, le plafond et les pannes', () => {
  it('une voie rencontrée par deux approches n’est dérivée qu’une fois', async () => {
    const ways = [way('wide', 0, 2_200, { declaredWidthM: 6 })];
    const result = await place(ways, [approach('a'), approach('b'), approach('c')]);

    expect(result.byWidth.computedFor).toBe(3);
    expect(result.byWidth.cost.overpassCalls).toBe(3);
    // Trois corridors, une seule voie distincte : c'est le recouvrement des
    // approches près du point de livraison, rendu visible.
    expect(result.byWidth.waysLoaded).toBe(1);
  });

  it('au-delà du plafond, les approches sont comptées, jamais tues', async () => {
    const ways = [way('wide', 0, 2_200, { declaredWidthM: 6 })];
    const result = await place(
      ways,
      [approach('a'), approach('b'), approach('c'), approach('d')],
      { maxApproaches: 2 },
    );

    expect(result.byWidth.computedFor).toBe(2);
    expect(result.byWidth.skipped).toBe(2);
    expect(result.byWidth.cost.overpassCalls).toBe(2);
    expect(result.approachesIn.map((a) => a.gateByWidth !== null)).toEqual([
      true,
      true,
      false,
      false,
    ]);
  });

  it('le plafond ALTERNE les deux directions : une sortie n’est pas sacrifiée à des entrées', async () => {
    const ways = [way('wide', 0, 2_200, { declaredWidthM: 6 })];
    const out = { ...approach('o'), direction: 'out' as const, polyline: [...approach('o').polyline].reverse() };
    const result = await place(ways, [approach('a'), approach('b'), approach('c')], {
      approachesOut: [out, { ...out, key: 'o2' }],
      maxApproaches: 2,
    });

    expect(result.approachesIn[0]?.gateByWidth).not.toBeNull();
    expect(result.approachesIn[1]?.gateByWidth).toBeNull();
    expect(result.approachesOut[0]?.gateByWidth).not.toBeNull();
    expect(result.byWidth.skipped).toBe(3);
  });

  it('un corridor en panne coûte une ancre, jamais le run', async () => {
    const result = await place([], [approach('a')], {}, {
      fetchCorridor: async () => {
        throw new Error('Overpass 504');
      },
    });
    const gate = result.approachesIn[0]?.gateByWidth;
    expect(gate?.basis).toBe('none');
    expect(gate?.reason).toBe('corridor_unavailable');
    expect(result.byWidth.cost.overpassCalls).toBe(1);
  });

  it('une approche sans ligne ne fait pas de requête du tout', async () => {
    const empty: DraftApproach = { ...approach('a'), polyline: [] };
    const result = await place([], [empty]);
    expect(result.approachesIn[0]?.gateByWidth?.reason).toBe('no_geometry');
    expect(result.byWidth.cost.overpassCalls).toBe(0);
  });

  it('le seuil et le camion voyagent avec la mesure', async () => {
    const result = await place([way('wide', 0, 2_200, { declaredWidthM: 6 })]);
    expect(result.byWidth.requiredWidthM).toBe(REQUIRED_M);
    expect(result.byWidth.truckId).toBe('pl-19t');
  });
});

describe('le profil, mesuré une fois, rejoué par camion', () => {
  it('fusionne les échantillons consécutifs sur la même voie, sans trou', async () => {
    const result = await place([
      way('narrow', 0, 590, { declaredWidthM: 3, tags: { highway: 'residential' } }),
      way('wide', 590, 2_200, { declaredWidthM: 6 }),
    ]);
    const profile = result.approachesIn[0]?.widthProfile ?? [];

    expect(profile.map((run) => run.wayId)).toEqual(['narrow', 'wide']);
    expect(profile[0]?.fromM).toBe(0);
    // Pas de trou : le deuxième tronçon commence au pas d'échantillonnage
    // suivant la fin du premier.
    expect(profile[1]?.fromM).toBe(600);
    expect(profile[0]?.widthM).toBe(3);
    expect(profile[1]?.structuring).toBe(true);
    expect(profile[0]?.structuring).toBe(false);
  });

  it('le même profil, deux camions, deux ancres — sans rien redemander au réseau', async () => {
    const result = await place([
      way('street', 0, 340, { declaredWidthM: 3.5, tags: { highway: 'residential' } }),
      way('wide', 340, 2_200, { declaredWidthM: 6 }),
    ]);
    const profile = result.approachesIn[0]?.widthProfile ?? [];

    // Un fourgon (2,0 + 0,8 + 0,4 = 3,2 m) passe dans la rue : rien à contrôler.
    const van = anchorFromProfile(profile, O, 3.2);
    expect(van.distanceFromDeliveryM).toBe(0);
    expect(van.reason).toBe('wide_from_the_delivery_point');

    // Un porteur 19 t (3,7 m) n'y passe pas : son ancre recule à la voie large.
    const rigid = anchorFromProfile(profile, O, REQUIRED_M);
    expect(rigid.distanceFromDeliveryM).toBe(350);
    expect(rigid.wayId).toBe('wide');
    expect(rigid.firstNarrowSegment).toEqual({ wayId: 'street', widthM: 3.5, atM: 0 });
  });

  it('une approche laissée de côté par le plafond n’a ni profil ni ancre', async () => {
    const ways = [way('wide', 0, 2_200, { declaredWidthM: 6 })];
    const result = await place(ways, [approach('a'), approach('b')], { maxApproaches: 1 });
    expect(result.approachesIn[0]?.widthProfile).not.toBeNull();
    expect(result.approachesIn[1]?.widthProfile).toBeNull();
  });

  it('un profil vide n’est pas une ancre : c’est une jambe qu’on n’a pas pu lire', () => {
    const gate = anchorFromProfile([], O, REQUIRED_M);
    expect(gate.basis).toBe('none');
    expect(gate.reason).toBe('no_geometry');
  });
});

describe('`outwardLine`', () => {
  it('retourne une entrante, laisse une sortante, et taille au rayon', () => {
    const inbound = approach('a', 2_200);
    const line = outwardLine(inbound, 2_000);
    // Du point de livraison vers l'extérieur : le premier point EST l'arrêt.
    expect(line[0]?.lat).toBeCloseTo(O.lat, 9);
    expect((line[line.length - 1] as GeoPoint).lat).toBeGreaterThan(O.lat);
    // Taillée : 2 000 m demandés, pas 2 200 servis.
    expect(line.length).toBeLessThan(inbound.polyline.length);

    const outbound = { ...inbound, direction: 'out' as const, polyline: [...inbound.polyline].reverse() };
    expect(outwardLine(outbound, 2_000)[0]?.lat).toBeCloseTo(O.lat, 9);
  });
});
