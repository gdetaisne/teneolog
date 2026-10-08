/**
 * La découverte par tours, sur un routeur factice déterministe.
 *
 * Le port de routage réel est un service ; ici il est une fonction pure de
 * l'origine, ce qui permet de prouver les quatre choses qui font la règle :
 *
 *  - les tours ne se superposent pas : 4 puis 8 puis 24 azimuts, jamais deux
 *    fois le même, et une origine déjà routée ne l'est pas deux fois ;
 *  - l'origine est choisie sur le réseau structurant, la classe d'abord ;
 *  - deux jambes qui partagent leur approche finale n'en font qu'une, et c'est
 *    la première rencontrée qui est gardée — donc le tour le plus petit ;
 *  - un routeur qui tombe coûte une approche, comptée, jamais le run.
 *
 * Le comptage des appels est testé pour lui-même : le coût de la découverte
 * est l'argument qui la rend acceptable en silence (§5), un run qui routerait
 * deux fois la même origine le trahirait sans que rien d'autre ne bouge.
 */
import { describe, expect, it } from 'vitest';
import type { GeoPoint } from '@teneolog/domain';
import { bearingDeg, type RoadNeighbourhood, type RoadWay } from '@teneolog/topology';

import { azimuthsOf, coverApproaches, discoverApproaches, type DiscoveryInput } from '../src/discovery.js';
import type { RoutedPath, RoutingPort } from '../src/ports.js';

const O: GeoPoint = { lat: 47.0, lon: 1.0 };
const M_PER_DEG_LAT = 111_320;

function at(base: GeoPoint, northM: number, eastM: number): GeoPoint {
  return {
    lat: base.lat + northM / M_PER_DEG_LAT,
    lon: base.lon + eastM / (M_PER_DEG_LAT * Math.cos((base.lat * Math.PI) / 180)),
  };
}

function way(id: string, geometry: readonly GeoPoint[], overrides: Partial<RoadWay> = {}): RoadWay {
  return {
    id,
    source: 'osm-overpass',
    nodeIds: geometry.map((_, i) => `${id}:${i}`),
    geometry,
    name: null,
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

function hood(ways: readonly RoadWay[]): RoadNeighbourhood {
  return { centre: O, radiusM: 2_000, ways, nodes: [] };
}

function input(ways: readonly RoadWay[], overrides: Partial<DiscoveryInput> = {}): DiscoveryInput {
  return {
    stop: O,
    neighbourhood: hood(ways),
    rounds: [4, 8, 24],
    radiusM: 2_000,
    minDistanceM: 500,
    // zero par defaut : ces cas mesurent le DEDOUBLONNAGE, et un
    // seuil de portee y ecarterait des jambes synthetiques pour une raison
    // qui n'est pas celle qu'ils testent. Les cas de portee le posent.
    minReachM: 0,
    windowM: 1_000,
    alternatives: 1,
    maxConcurrent: 4,
    fetchedAt: '2026-09-11T10:00:00.000Z',
    ...overrides,
  };
}

/**
 * Un routeur qui rentre par l'un de quatre couloirs, selon le quadrant de
 * l'origine : c'est ce qui fait que 36 rayons ne donnent pas 36 approches.
 *
 * Chaque jambe saute jusqu'à la bouche de son couloir puis descend exactement
 * la même ligne jusqu'à l'arrêt — deux origines du même quadrant partagent
 * donc leurs derniers mètres au mètre près.
 *
 * La bouche est à 1 400 m, c'est-à-dire AU-DELÀ de la fenêtre de 1 000 m : le
 * saut depuis l'origine, qui lui diffère d'un rayon à l'autre, reste hors de
 * ce que la comparaison regarde. Une bouche à 900 m ferait entrer le saut dans
 * la queue et aucune jambe ne ressemblerait à une autre — ce qui testerait la
 * fixture, pas la règle.
 */
const MOUTH_M = 1_400;

function corridorRouter(): RoutingPort & { calls: () => number } {
  const seen: GeoPoint[] = [];
  const mouths = [at(O, MOUTH_M, 0), at(O, 0, MOUTH_M), at(O, -MOUTH_M, 0), at(O, 0, -MOUTH_M)];
  return {
    calls: () => seen.length,
    route: async (from: GeoPoint, to: GeoPoint): Promise<readonly RoutedPath[]> => {
      seen.push(from);
      // Frontières à 45°, 135°, 225°, 315° : aucun des 36 azimuts joués ne
      // tombe dessus, donc le quadrant d'un rayon ne dépend pas du dernier
      // bit de `bearingDeg` (plein est vaut 89,999° ou 90,001° selon le point).
      const quadrant = Math.floor(((bearingDeg(to, from) + 45) % 360 + 360) % 360 / 90);
      const mouth = mouths[quadrant]!;
      const polyline: GeoPoint[] = [from];
      // Vingt points entre la bouche du couloir et l'arrêt : la comparaison
      // échantillonne tous les 10 m, il lui faut de la matière.
      for (let i = 0; i <= 20; i += 1) {
        polyline.push({
          lat: mouth.lat + ((to.lat - mouth.lat) * i) / 20,
          lon: mouth.lon + ((to.lon - mouth.lon) * i) / 20,
        });
      }
      return [{ polyline, distanceM: 1_800, durationS: 200 }];
    },
  };
}

/** Le réseau structurant : une voie par direction cardinale, à 1 800 m. */
function cross(): readonly RoadWay[] {
  return [
    way('north', [at(O, 1_700, 0), at(O, 1_900, 0)]),
    way('east', [at(O, 0, 1_700), at(O, 0, 1_900)]),
    way('south', [at(O, -1_700, 0), at(O, -1_900, 0)]),
    way('west', [at(O, 0, -1_700), at(O, 0, -1_900)]),
  ];
}

// ------------------------------------------------------------------- azimuts --

describe('azimuthsOf — les tours ne se superposent jamais', () => {
  it('4, 8 puis 24 rayons font 36 azimuts distincts', () => {
    const rounds = [4, 8, 24];
    const used: number[] = [];
    const perRound: number[][] = [];
    rounds.forEach((rays, index) => {
      const azimuths = azimuthsOf(rays, index + 1, rounds.length, used);
      perRound.push([...azimuths]);
      used.push(...azimuths);
    });
    expect(perRound.map((r) => r.length)).toEqual([4, 8, 24]);
    expect(new Set(used).size).toBe(36);
    expect(perRound[0]).toEqual([0, 90, 180, 270]);
  });

  it('un tour est équiréparti : les écarts consécutifs sont égaux', () => {
    const azimuths = [...azimuthsOf(8, 2, 3, [])].sort((a, b) => a - b);
    const gaps = azimuths.slice(1).map((a, i) => a - azimuths[i]!);
    for (const gap of gaps) expect(gap).toBeCloseTo(45, 9);
  });

  it('un azimut déjà tiré est écarté plutôt que rejoué', () => {
    expect(azimuthsOf(4, 1, 1, [90])).toEqual([0, 180, 270]);
  });
});

// ------------------------------------------------------------------- origines --

describe('discoverApproaches — les origines', () => {
  it('prend la meilleure classe du secteur, puis la plus lointaine', async () => {
    const ways = [
      // Deux voies plein nord : la primaire est plus près, elle doit gagner.
      way('nord-primaire', [at(O, 1_200, 0)], { tags: { highway: 'primary' } }),
      way('nord-tertiaire', [at(O, 1_900, 0)], { tags: { highway: 'tertiary' } }),
    ];
    const router = corridorRouter();
    const discovery = await discoverApproaches(input(ways, { rounds: [4] }), router);
    const north = discovery.rounds[0]?.origins.find((o) => o.azimuthDeg === 0);
    expect(north?.wayId).toBe('nord-primaire');
  });

  it('à défaut de sommet structurant, pose l’origine sur le cercle et le dit', async () => {
    const router = corridorRouter();
    const discovery = await discoverApproaches(input([], { rounds: [4] }), router);
    const origins = discovery.rounds[0]?.origins ?? [];
    expect(origins.length).toBe(4);
    for (const origin of origins) expect(origin.wayId).toBeNull();
  });

  it('ignore ce qui est hors de la bande [minDistanceM, radiusM]', async () => {
    const ways = [
      way('trop-pres', [at(O, 200, 0)], { tags: { highway: 'primary' } }),
      way('trop-loin', [at(O, 4_000, 0)], { tags: { highway: 'primary' } }),
    ];
    const router = corridorRouter();
    const discovery = await discoverApproaches(input(ways, { rounds: [4] }), router);
    for (const origin of discovery.rounds[0]?.origins ?? []) expect(origin.wayId).toBeNull();
  });

  it('ne route pas deux fois la même origine, et le compte le prouve', async () => {
    // Quatre voies cardinales : les secteurs du tour 2 qui recouvrent une
    // direction déjà servie retombent sur le MÊME sommet. Le rayon est
    // comptabilisé dans `rays`, l'origine ne l'est pas dans `origins`, et
    // surtout le routeur n'est pas rappelé.
    const router = corridorRouter();
    const discovery = await discoverApproaches(input(cross(), { rounds: [4, 8] }), router);
    const routed = discovery.rounds.flatMap((round) => round.origins);
    const keys = routed.map((o) => `${o.at.lat.toFixed(6)},${o.at.lon.toFixed(6)}`);
    expect(new Set(keys).size).toBe(keys.length);
    // une origine est routée DEUX fois — l'aller et le retour sont
    // deux choix indépendants — et jamais plus. Le double, jamais le triple :
    // c'est la borne de coût que la tâche s'est donnée.
    expect(discovery.cost.routingCalls).toBe(2 * routed.length);
    expect(router.calls()).toBe(2 * routed.length);
    expect(discovery.rounds[1]?.rays).toBe(8);
    // Douze rayons demandés, strictement moins d'origines routées — combien
    // dépend de la géométrie du voisinage, et c'est très bien ainsi : ce qui
    // est garanti, c'est qu'aucune origine n'est payée deux fois.
    expect(discovery.rounds[1]?.origins.length).toBeLessThan(8);
    expect(discovery.cost.routingCalls).toBeLessThan(24);
  });
});

// -------------------------------------------------------------- dédoublonnage --

describe('discoverApproaches — une approche, pas une jambe', () => {
  it('36 rayons, quatre couloirs : quatre approches, gardées au premier tour', async () => {
    // Aucun réseau structurant : les 36 origines sont les 36 points du cercle,
    // toutes distinctes — c'est le cas où l'on route vraiment 36 rayons.
    const router = corridorRouter();
    const discovery = await discoverApproaches(input([]), router);

    expect(discovery.approaches.length).toBe(4);
    // Le tour 1 tire les quatre azimuts cardinaux : il a tout trouvé, et les
    // deux tours suivants ne gardent plus rien.
    expect(discovery.rounds.map((round) => round.legsKept)).toEqual([4, 0, 0]);
    for (const approach of discovery.approaches) expect(approach.firstRound).toBe(1);
    // Trente-six rayons routés quand même : en silence, tous les tours sont
    // joués. Deux fois trente-six appels depuis chaque rayon est
    // routé à l'aller et au retour.
    expect(discovery.cost.routingCalls).toBe(72);
    expect(discovery.rounds.reduce((sum, r) => sum + r.legsRouted, 0)).toBe(36);
    expect(discovery.rounds.reduce((sum, r) => sum + r.legsRoutedOut, 0)).toBe(36);
    expect(router.calls()).toBe(72);
  });

  it('la jambe gardée porte sa ligne ; les jambes écartées ne sont que comptées', async () => {
    const router = corridorRouter();
    const discovery = await discoverApproaches(input([]), router);
    for (const approach of discovery.approaches) {
      expect(approach.polyline.length).toBeGreaterThan(2);
      expect(approach.distanceM).toBe(1_800);
    }
    const kept = discovery.rounds.reduce((sum, r) => sum + r.legsKept, 0);
    expect(kept).toBe(discovery.approaches.length);
  });

  it('le budget dit ce qui était permis et ce qui a été joué', async () => {
    const router = corridorRouter();
    const discovery = await discoverApproaches(input(cross()), router);
    expect(discovery.budget).toEqual({ maxRounds: 3, playedRounds: 3, settingKind: null });
    expect(discovery.windowM).toBe(1_000);
    expect(discovery.fetchedAt).toBe('2026-09-11T10:00:00.000Z');
    expect(discovery.cost.durationMs).toBeGreaterThanOrEqual(0);
  });
});

// ------------------------------------------------------------------- pannes --

describe('discoverApproaches — le routeur peut tomber', () => {
  it('un rayon sans réponse coûte une approche, comptée, jamais le run', async () => {
    const good = corridorRouter();
    let n = 0;
    const flaky: RoutingPort = {
      route: async (from, to, alternatives) => {
        n += 1;
        if (n % 2 === 0) throw new Error('OSRM 503');
        return good.route(from, to, alternatives);
      },
    };
    const discovery = await discoverApproaches(input([], { rounds: [4, 8] }), flaky);
    const failed = discovery.rounds.reduce(
      (sum, round) => sum + round.legsFailed + round.legsFailedOut,
      0,
    );
    expect(failed).toBeGreaterThan(0);
    expect(discovery.approaches.length).toBeGreaterThan(0);
    // Les appels comptent les pannes : c'est le coût réel, pas le coût utile.
    // Douze rayons, vingt-quatre appels — l'aller et le retour de chacun.
    expect(discovery.cost.routingCalls).toBe(24);
    const routed = discovery.rounds.reduce(
      (sum, r) => sum + r.legsRouted + r.legsRoutedOut,
      0,
    );
    expect(failed + routed).toBe(24);
  });

  it('un routeur totalement muet rend une découverte vide, pas une erreur', async () => {
    const dead: RoutingPort = { route: async () => Promise.reject(new Error('down')) };
    const discovery = await discoverApproaches(input(cross(), { rounds: [4] }), dead);
    expect(discovery.approaches).toEqual([]);
    expect(discovery.approachesOut).toEqual([]);
    expect(discovery.rounds[0]?.legsFailed).toBe(4);
    expect(discovery.rounds[0]?.legsRouted).toBe(0);
    expect(discovery.rounds[0]?.legsFailedOut).toBe(4);
    expect(discovery.rounds[0]?.legsRoutedOut).toBe(0);
  });
});

// --------------------------------------------------------- les jambes sortantes --

describe('discoverApproaches — la sortie est un choix à part', () => {
  it('route stop → origine pour les mêmes origines, et le dit tour par tour', async () => {
    const seen: { from: GeoPoint; to: GeoPoint }[] = [];
    const base = corridorRouter();
    const spy: RoutingPort = {
      route: async (from, to, alternatives) => {
        seen.push({ from, to });
        return base.route(from, to, alternatives);
      },
    };
    const discovery = await discoverApproaches(input([], { rounds: [4] }), spy);

    const origins = discovery.rounds[0]?.origins ?? [];
    expect(origins.length).toBe(4);
    // Chaque origine est vue une fois comme départ d'un aller et une fois
    // comme arrivée d'un retour : les deux sens, les mêmes points.
    for (const origin of origins) {
      expect(seen.filter((call) => call.from === origin.at).length).toBe(1);
      expect(seen.filter((call) => call.to === origin.at).length).toBe(1);
    }
    expect(seen.filter((call) => call.from === O).length).toBe(4);
  });

  it('dédoublonne les sorties sur leurs PREMIERS mètres, pas les derniers', async () => {
    // Le routeur factice sort par la bouche du quadrant opposé : quatre
    // couloirs de départ, donc quatre approches sortantes — et les 36 rayons
    // n'en font pas 36, exactement comme à l'entrée.
    const discovery = await discoverApproaches(input([]), corridorRouter());
    expect(discovery.approachesOut.length).toBe(4);
    expect(discovery.rounds.map((round) => round.legsKeptOut)).toEqual([4, 0, 0]);
    for (const approach of discovery.approachesOut) {
      expect(approach.direction).toBe('out');
      expect(approach.firstRound).toBe(1);
      expect(approach.polyline.length).toBeGreaterThan(2);
    }
    // Les clés ne se confondent pas avec celles des entrées : deux listes, un
    // même azimut, et un lecteur qui doit pouvoir les distinguer.
    const keysIn = new Set(discovery.approaches.map((a) => a.key));
    for (const approach of discovery.approachesOut) expect(keysIn.has(approach.key)).toBe(false);
    for (const approach of discovery.approaches) expect(approach.direction).toBe('in');
  });

  it('la couverture par R0 se joint côté sortie sur les jambes sortantes', async () => {
    const router = corridorRouter();
    const discovery = await discoverApproaches(input(cross(), { rounds: [4] }), router);
    // Une jambe R0 qui repart de l'arrêt vers une ancre du nord : la même
    // ligne que le routeur factice produit pour ce couple.
    const r0 = (await router.route(O, at(O, 1_500, 10), 1))[0]!;

    const covered = coverApproaches(
      discovery.approachesOut,
      [{ id: 'r0:out', polyline: r0.polyline }],
      1_000,
      'out',
    );
    expect(covered.coverage.approachesTotal).toBe(4);
    expect(covered.coverage.coveredByR0).toBe(1);
    expect(covered.coverage.r0CandidatesUncovered).toEqual([]);

    // Et la même jambe, jointe par ses DERNIERS mètres, ne couvre rien : les
    // deux extrémités ne disent pas la même chose, et c'est tout l'objet.
    const wrongEnd = coverApproaches(
      discovery.approachesOut,
      [{ id: 'r0:out', polyline: r0.polyline }],
      1_000,
    );
    expect(wrongEnd.coverage.coveredByR0).toBe(0);
  });
});

// ----------------------------------------------------------- couverture par R0 --

describe('coverApproaches — ce que la règle actuelle atteint', () => {
  it('un itinéraire R0 qui partage l’approche la couvre, et se nomme', async () => {
    const router = corridorRouter();
    const discovery = await discoverApproaches(input(cross(), { rounds: [4] }), router);
    // Une jambe R0 qui rentre par le couloir nord : exactement la ligne que le
    // routeur factice produit depuis une origine du quadrant nord.
    const r0 = (await router.route(at(O, 1_500, 10), O, 1))[0]!;

    const covered = coverApproaches(discovery.approaches, [{ id: 'r0:in', polyline: r0.polyline }], 1_000);
    expect(covered.coverage.approachesTotal).toBe(4);
    expect(covered.coverage.coveredByR0).toBe(1);
    expect(covered.coverage.r0CandidatesUncovered).toEqual([]);
    expect(covered.approachOfCandidate.get('r0:in')?.firstRound).toBe(1);
    expect(covered.approaches.filter((a) => a.coveredByCandidateId === 'r0:in').length).toBe(1);
  });

  it('un itinéraire R0 qui arrive par ailleurs se signale comme non couvert', async () => {
    const router = corridorRouter();
    const discovery = await discoverApproaches(input(cross(), { rounds: [4] }), router);
    const elsewhere = { id: 'r0:ailleurs', polyline: [at(O, 0, 3_000), at(O, 800, 2_000), at(O, 900, 900)] };

    const covered = coverApproaches(discovery.approaches, [elsewhere], 1_000);
    expect(covered.coverage.coveredByR0).toBe(0);
    expect(covered.coverage.r0CandidatesUncovered).toEqual(['r0:ailleurs']);
    expect(covered.approachOfCandidate.size).toBe(0);
  });
});

// ------------------------------------------------- la portée jusqu'au cercle --

/**
 * une jambe qui n'atteint pas le cercle n'entre pas en concurrence.
 *
 * L'origine d'un rayon est un SOMMET DU RÉSEAU pris entre `minDistanceM` et
 * `radiusM`, jamais un point du cercle : dans un bourg, le sommet le mieux
 * classé d'un secteur peut n'être qu'à 600 m. La jambe routée jusque-là ne dit
 * rien de la façon d'entrer dans le bourg ni d'en sortir — et au jury de
 * Thairé c'est elle qui gagnait, parce qu'elle s'arrêtait juste avant la seule
 * vraie difficulté (défaut A).
 */
describe('discoverApproaches — la portée jusqu’au cercle', () => {
  /**
   * Un secteur dont le meilleur sommet est proche : une primaire à 600 m bat
   * une tertiaire lointaine sur la CLASSE (`betterOrigin` regarde le rang avant
   * la distance), donc le rayon plein est n'est routé que jusqu'à 600 m. C'est
   * la forme exacte du défaut, à l'échelle réelle.
   */
  function shortSectorWorld(): readonly RoadWay[] {
    return [
      way('north-far', [at(O, 1_700, 0), at(O, 1_900, 0)]),
      way('east-near', [at(O, 0, 560), at(O, 0, 600)], { tags: { highway: 'primary' } }),
    ];
  }

  it('la jambe trop courte est écartée, comptée et nommée', async () => {
    const discovery = await discoverApproaches(
      input(shortSectorWorld(), { rounds: [4], minReachM: 1_800 }),
      corridorRouter(),
    );

    // Les deux sens du rayon plein est échouent, et chacun se nomme.
    expect(discovery.shortOfRing.map((leg) => leg.key)).toEqual(['r1@090', 'r1@090:out']);
    expect(discovery.shortOfRing.map((leg) => leg.direction)).toEqual(['in', 'out']);
    for (const leg of discovery.shortOfRing) {
      expect(leg.reachM).toBeGreaterThan(590);
      expect(leg.reachM).toBeLessThan(610);
      // La distance ROUTÉE, elle, reste celle du routeur : les deux nombres
      // disent deux choses, et le tableau du jury les montre côte à côte.
      expect(leg.routedDistanceM).toBe(1_800);
    }

    // Et aucune approche gardée ne porte cette clé, dans un sens ni dans l'autre.
    const kept = [...discovery.approaches, ...discovery.approachesOut].map((a) => a.key);
    expect(kept).not.toContain('r1@090');
    expect(kept).not.toContain('r1@090:out');
    expect(kept.length).toBe(6); // trois secteurs restants × deux sens
  });

  it('à seuil nul la même jambe est gardée : c’est bien le seuil qui décide', async () => {
    const discovery = await discoverApproaches(
      input(shortSectorWorld(), { rounds: [4], minReachM: 0 }),
      corridorRouter(),
    );
    expect(discovery.shortOfRing).toEqual([]);
    expect(discovery.approaches.map((a) => a.key)).toContain('r1@090');
    expect(discovery.approaches.length + discovery.approachesOut.length).toBe(8);
  });
});

/**
 * L'ORDRE EST LA RÈGLE : écarter la courte AVANT de dédoublonner.
 *
 * C'est la moitié cachée du défaut A du jury de Thairé. Une jambe de 887 m
 * couvre les derniers mètres de toutes celles qui arrivent par le même côté :
 * la laisser dans l'ensemble de comparaison ne la ferait pas seulement gagner,
 * ça l'empêcherait d'avoir une concurrente — elle EFFACERAIT l'approche
 * complète qui la prolonge, et le classement n'aurait plus rien à départager.
 *
 * Le cas le montre dans les deux sens : avec le seuil, la courte est comptée et
 * la longue survit ; sans le seuil, la courte gagne et la longue disparaît. Un
 * cas qui ne jouerait que la première moitié prouverait seulement qu'un filtre
 * filtre.
 */
describe('discoverApproaches — la courte est écartée avant le dédoublonnage', () => {
  /**
   * Un routeur à UN SEUL couloir : toutes les jambes partagent leurs derniers
   * mètres, donc toutes sont « la même approche ». Le quadrant ne décide plus
   * rien — ce qui est voulu : ici on ne teste pas la mesure de ressemblance,
   * on teste l'ORDRE dans lequel la portée et le dédoublonnage s'appliquent.
   */
  function oneCorridorRouter(): RoutingPort {
    const mouth = at(O, MOUTH_M, 0);
    const spine = (to: GeoPoint): GeoPoint[] => {
      const out: GeoPoint[] = [];
      for (let i = 0; i <= 20; i += 1) {
        out.push({
          lat: mouth.lat + ((to.lat - mouth.lat) * i) / 20,
          lon: mouth.lon + ((to.lon - mouth.lon) * i) / 20,
        });
      }
      return out;
    };
    return {
      route: async (from: GeoPoint, to: GeoPoint): Promise<readonly RoutedPath[]> => {
        // `from === stop` : c'est la jambe SORTANTE, lue de l'arrêt vers
        // l'origine — le couloir d'abord, l'origine au bout.
        const outbound = from.lat === O.lat && from.lon === O.lon;
        const polyline = outbound
          ? [...spine(from).reverse(), to]
          : [from, ...spine(to)];
        return [{ polyline, distanceM: 1_800, durationS: 200 }];
      },
    };
  }

  /**
   * Deux secteurs, deux jambes qui se ressemblent : une primaire à 600 m au
   * nord (rencontrée la PREMIÈRE, azimut 0) et une tertiaire à 1 900 m à l'est.
   */
  function shortThenLongWorld(): readonly RoadWay[] {
    return [
      way('court', [at(O, 560, 0), at(O, 600, 0)], { tags: { highway: 'primary' } }),
      way('long', [at(O, 0, 1_800), at(O, 0, 1_900)]),
    ];
  }

  it('la courte est comptée et la longue survit', async () => {
    const discovery = await discoverApproaches(
      input(shortThenLongWorld(), { rounds: [4], minReachM: 1_800 }),
      oneCorridorRouter(),
    );

    // Écartée : elle n'a jamais rejoint l'ensemble de comparaison.
    expect(discovery.shortOfRing.map((leg) => leg.key)).toEqual(['r1@000', 'r1@000:out']);
    // Et la longue est là, dans les deux sens.
    expect(discovery.approaches.map((a) => a.key)).toEqual(['r1@090']);
    expect(discovery.approachesOut.map((a) => a.key)).toEqual(['r1@090:out']);
  });

  it('sans le seuil, la courte gagne et la longue n’existe plus', async () => {
    const discovery = await discoverApproaches(
      input(shortThenLongWorld(), { rounds: [4], minReachM: 0 }),
      oneCorridorRouter(),
    );

    expect(discovery.shortOfRing).toEqual([]);
    // La première rencontrée gagne, et elle couvre toutes les suivantes : la
    // jambe qui porte jusqu'au cercle a disparu du run.
    expect(discovery.approaches.map((a) => a.key)).toEqual(['r1@000']);
    expect(discovery.approachesOut.map((a) => a.key)).toEqual(['r1@000:out']);
  });
});
