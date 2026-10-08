/**
 * The degradation contract, stated as tests.
 *
 * The graft is an improvement bolted onto a product that already works. Every
 * way the donor can fail — unconfigured, slow, throwing, repeatedly throwing —
 * must leave the caller with exactly what the primary source returned. Most of
 * these assertions use `toBe`, not `toEqual`: identity is the point. A copy
 * that merely happens to be equal today is a copy that can drift tomorrow.
 */
import type { GeoPoint } from '@teneolog/domain';
import type { RoadNeighbourhood, RoadWay } from '@teneolog/topology';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DONOR_NET_GRACE_MS,
  GraftedRoadSource,
  type GraftedRoadSourceOptions,
  type RoadSource,
} from '../src/grafted.js';

/**
 * Ce que PostgreSQL rend quand il coupe lui-même à l'échéance qu'on lui a
 * donnée — reconnu par son code, jamais par son texte, qui est traduit.
 */
function queryCanceled(): Error {
  const error = new Error('canceling statement due to statement timeout');
  return Object.assign(error, { code: '57014' });
}

const O = { lat: 46.0735, lon: -0.9654 };
const M_PER_DEG_LAT = 111_320;

function at(northM: number, eastM: number): GeoPoint {
  return {
    lat: O.lat + northM / M_PER_DEG_LAT,
    lon: O.lon + eastM / (M_PER_DEG_LAT * Math.cos((O.lat * Math.PI) / 180)),
  };
}

function way(id: string, eastM: number, widthM: number | null, source: RoadWay['source']): RoadWay {
  return {
    id,
    source,
    nodeIds: [`${id}:a`, `${id}:b`],
    geometry: [at(-60, eastM), at(60, eastM)],
    name: null,
    importance: null,
    declaredWidthM: widthM,
    laneCount: null,
    oneWay: 'no',
    isPrivate: false,
    limits: { maxWeightT: null, maxHeightM: null, maxWidthM: null, maxLengthM: null },
    tags: { highway: 'residential' },
  };
}

const OSM_WAYS: readonly RoadWay[] = [way('street', 0, null, 'osm-overpass')];
const PRIMARY_HOOD: RoadNeighbourhood = { centre: O, radiusM: 80, ways: OSM_WAYS, nodes: [] };
const DONOR_WAYS: readonly RoadWay[] = [way('TRONROUT042', 2, 5.2, 'bdtopo-postgis')];

function primarySource(): RoadSource {
  return {
    fetchNeighbourhood: vi.fn(async () => PRIMARY_HOOD),
    fetchCorridor: vi.fn(async () => OSM_WAYS),
  };
}

function build(donor: RoadSource | null, overrides: Partial<GraftedRoadSourceOptions> = {}) {
  const primary = primarySource();
  const onDonorFailure = vi.fn();
  const source = new GraftedRoadSource({
    primary,
    donor,
    graft: { sampleStepM: 10, lateralToleranceM: 5, bearingToleranceDeg: 25, minCoverage: 0.6 },
    donorTimeoutMs: 2_500,
    breakerFailures: 3,
    breakerCooldownMs: 60_000,
    memoTtlMs: 30_000,
    onDonorFailure,
    ...overrides,
  });
  return { source, primary, onDonorFailure };
}

describe('GraftedRoadSource', () => {
  it('grafts the donor width onto the primary way', () => {
    const donor: RoadSource = {
      fetchNeighbourhood: async () => ({ ...PRIMARY_HOOD, ways: DONOR_WAYS }),
      fetchCorridor: async () => DONOR_WAYS,
    };
    const { source } = build(donor);

    return source.fetchNeighbourhood(O, 80).then((hood) => {
      expect(hood.ways[0]?.declaredWidthM).toBe(5.2);
      expect(hood.ways[0]?.attributed?.declaredWidthM?.source).toBe('bdtopo-postgis');
      expect(hood.ways[0]?.id).toBe('street');
    });
  });

  it('judges a long way only inside the neighbourhood it was fetched for', async () => {
    // Overpass returns the whole 800 m street because one node is within
    // 80 m; the BD TOPO answered for those 80 m. Judged on its full length
    // the street would stay mute — Rue Voisine 17 at Thairé.
    const long: RoadWay = { ...way('long', 0, null, 'osm-overpass'), geometry: [at(-740, 0), at(60, 0)] };
    const donor: RoadSource = {
      fetchNeighbourhood: async () => ({ ...PRIMARY_HOOD, ways: DONOR_WAYS }),
      fetchCorridor: async () => DONOR_WAYS,
    };
    const { source, primary } = build(donor);
    vi.mocked(primary.fetchNeighbourhood).mockResolvedValue({ ...PRIMARY_HOOD, ways: [long] });

    const hood = await source.fetchNeighbourhood(O, 80);

    expect(hood.ways[0]?.declaredWidthM).toBe(5.2);
  });

  it('judges a side street only inside the corridor margin', async () => {
    // The side street of a turn leaves the corridor by construction, and its
    // width is exactly what the turn needs. Only its first 30 m were answered.
    const side: RoadWay = { ...way('side', 0, null, 'osm-overpass'), geometry: [at(0, 0), at(0, 400)] };
    const stretch: RoadWay = { ...way('T-side', 0, 3, 'bdtopo-postgis'), geometry: [at(2, 0), at(2, 60)] };
    const donor: RoadSource = {
      fetchNeighbourhood: async () => ({ ...PRIMARY_HOOD, ways: [stretch] }),
      fetchCorridor: async () => [stretch],
    };
    const { source, primary } = build(donor);
    vi.mocked(primary.fetchCorridor).mockResolvedValue([side]);

    const ways = await source.fetchCorridor([at(-60, 0), at(60, 0)], 30);

    expect(ways[0]?.declaredWidthM).toBe(3);
    expect(ways[0]?.attributed?.declaredWidthM?.donorWayId).toBe('T-side');
  });

  it('is a pass-through when no donor is configured', async () => {
    // BDTOPO_POSTGIS_URL unset. The product must behave exactly as before.
    const { source, primary } = build(null);

    const hood = await source.fetchNeighbourhood(O, 80);

    expect(hood).toBe(PRIMARY_HOOD);
    expect(await source.fetchCorridor([at(-60, 0), at(60, 0)], 30)).toBe(OSM_WAYS);
    expect(primary.fetchNeighbourhood).toHaveBeenCalledTimes(1);
  });

  it('returns the primary untouched when the donor throws', async () => {
    const donor: RoadSource = {
      fetchNeighbourhood: async () => { throw new Error('ECONNREFUSED'); },
      fetchCorridor: async () => { throw new Error('ECONNREFUSED'); },
    };
    const { source, onDonorFailure } = build(donor);

    expect(await source.fetchNeighbourhood(O, 80)).toBe(PRIMARY_HOOD);
    expect(onDonorFailure).toHaveBeenCalledTimes(1);
  });

  it('does not graft when the donor has nothing to say', async () => {
    const donor: RoadSource = {
      fetchNeighbourhood: async () => ({ ...PRIMARY_HOOD, ways: [] }),
      fetchCorridor: async () => [],
    };
    const { source } = build(donor);

    expect(await source.fetchNeighbourhood(O, 80)).toBe(PRIMARY_HOOD);
  });

  describe('with fake timers', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('abandons a donor that hangs, and still answers — mais APRÈS le serveur', async () => {
      // ce minuteur n'est plus la lame, c'est le filet. La lame est
      // le `statement_timeout` que le donneur SQL pose sur sa connexion à
      // `donorTimeoutMs` : le serveur coupe le premier et rend la connexion.
      // Le filet ne tombe qu'ensuite, pour le donneur qui n'est pas une base —
      // ou pour la prise muette. S'il tombait avant, on serait revenu au
      // défaut du §7.4 : abandonner sans annuler.
      const donor: RoadSource = {
        fetchNeighbourhood: () => new Promise<RoadNeighbourhood>(() => {}),
        fetchCorridor: () => new Promise<readonly RoadWay[]>(() => {}),
      };
      const { source, onDonorFailure } = build(donor);

      const pending = source.fetchNeighbourhood(O, 80);
      await vi.advanceTimersByTimeAsync(2_500);
      expect(onDonorFailure).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(DONOR_NET_GRACE_MS);

      expect(await pending).toBe(PRIMARY_HOOD);
      expect(onDonorFailure).toHaveBeenCalledTimes(1);
    });

    it('il faut SIX dépassements de budget pour ouvrir le disjoncteur, pas trois', async () => {
      // un dépassement ne coûte plus que sa propre requête : il rend
      // sa connexion, il ne bouche plus la pool. Trois corridors trop gros à
      // Paris ne sont donc plus une preuve que la base ne suit pas ; six à la
      // suite, oui. Avant, trois suffisaient à priver l'adresse ENTIÈRE de ses
      // largeurs pendant une minute (§7.4).
      const fetchNeighbourhood = vi.fn(async (): Promise<RoadNeighbourhood> => {
        throw queryCanceled();
      });
      const { source } = build({ fetchNeighbourhood, fetchCorridor: async () => [] });

      for (let i = 0; i < 5; i += 1) await source.fetchNeighbourhood(at(i, 0), 80);
      expect(fetchNeighbourhood).toHaveBeenCalledTimes(5);

      for (let i = 5; i < 9; i += 1) await source.fetchNeighbourhood(at(i, 0), 80);
      expect(fetchNeighbourhood).toHaveBeenCalledTimes(6);
    });

    it('ouvert sur des dépassements, il se referme en cinq secondes — pas en une minute', async () => {
      // une analyse dure de 8 à 36 s (A/B §7.1). Un repos de 60 s ne
      // prive pas quelques corridors de leurs largeurs, il prive l'adresse
      // entière ET la suivante, le processus étant partagé. Un repos plus
      // court que l'analyse rend la largeur en cours de route.
      const fetchNeighbourhood = vi.fn(async (): Promise<RoadNeighbourhood> => {
        throw queryCanceled();
      });
      const { source } = build({ fetchNeighbourhood, fetchCorridor: async () => [] });

      for (let i = 0; i < 6; i += 1) await source.fetchNeighbourhood(at(i, 0), 80);
      expect(fetchNeighbourhood).toHaveBeenCalledTimes(6);

      vi.setSystemTime(Date.now() + 4_999);
      await source.fetchNeighbourhood(at(50, 0), 80);
      expect(fetchNeighbourhood).toHaveBeenCalledTimes(6);

      vi.setSystemTime(Date.now() + 2);
      await source.fetchNeighbourhood(at(51, 0), 80);
      expect(fetchNeighbourhood).toHaveBeenCalledTimes(7);
    });

    it('une poignée de main trop lente compte comme une lenteur, pas comme une mort', async () => {
      //, mesuré le 2026-09-11 : ouvrir une connexion à travers le
      // tunnel réseau coûte 1,4 s, et le premier run de vérification en a manqué
      // huit d'affilée — « timeout exceeded when trying to connect ». Classées
      // en panne, trois suffisaient à ouvrir le disjoncteur pour une minute et
      // l'adresse rendait 0 largeur BD TOPO sur 5 778 voies. Le lien est
      // encombré, la base est vivante : c'est l'autre colonne.
      const fetchNeighbourhood = vi.fn(async (): Promise<RoadNeighbourhood> => {
        throw new Error('timeout exceeded when trying to connect');
      });
      const { source } = build({ fetchNeighbourhood, fetchCorridor: async () => [] });

      for (let i = 0; i < 5; i += 1) await source.fetchNeighbourhood(at(i, 0), 80);

      expect(fetchNeighbourhood).toHaveBeenCalledTimes(5);
    });

    it('une base MUETTE garde le seuil de trois et la pleine minute', async () => {
      // l'autre colonne. Une connexion refusée ne changera pas d'ici
      // la requête suivante : c'est la panne pour laquelle le disjoncteur a
      // été écrit, et son calibrage reste celui-là.
      const fetchNeighbourhood = vi.fn(async (): Promise<RoadNeighbourhood> => {
        throw new Error('ECONNREFUSED');
      });
      const { source } = build({ fetchNeighbourhood, fetchCorridor: async () => [] });

      for (let i = 0; i < 6; i += 1) await source.fetchNeighbourhood(at(i, 0), 80);
      expect(fetchNeighbourhood).toHaveBeenCalledTimes(3);

      vi.setSystemTime(Date.now() + 5_001);
      await source.fetchNeighbourhood(at(50, 0), 80);
      expect(fetchNeighbourhood).toHaveBeenCalledTimes(3);

      vi.setSystemTime(Date.now() + 55_000);
      await source.fetchNeighbourhood(at(51, 0), 80);
      expect(fetchNeighbourhood).toHaveBeenCalledTimes(4);
    });

    it('les deux comptes sont consécutifs : une réponse les remet à zéro', async () => {
      // Une base qui répond une fois sur deux n'est pas une base en panne.
      let call = 0;
      const fetchNeighbourhood = vi.fn(async (): Promise<RoadNeighbourhood> => {
        call += 1;
        if (call % 2 === 0) return { ...PRIMARY_HOOD, ways: DONOR_WAYS };
        throw queryCanceled();
      });
      const { source } = build({ fetchNeighbourhood, fetchCorridor: async () => [] });

      for (let i = 0; i < 20; i += 1) await source.fetchNeighbourhood(at(i, 0), 80);

      expect(fetchNeighbourhood).toHaveBeenCalledTimes(20);
    });

    it('opens the breaker after three failures and probes again after the cooldown', async () => {
      // Without this, a dead database costs every analysis four wasted waits,
      // for ever. The breaker turns a permanent outage into three.
      const fetchNeighbourhood = vi.fn(async (): Promise<RoadNeighbourhood> => {
        throw new Error('down');
      });
      const { source } = build({ fetchNeighbourhood, fetchCorridor: async () => [] });

      for (let i = 0; i < 6; i += 1) await source.fetchNeighbourhood(at(i, 0), 80);
      expect(fetchNeighbourhood).toHaveBeenCalledTimes(3);

      vi.setSystemTime(Date.now() + 60_001);
      await source.fetchNeighbourhood(at(99, 0), 80);
      expect(fetchNeighbourhood).toHaveBeenCalledTimes(4);
    });

    it('asks the donor once for a neighbourhood the pipeline fetches twice', async () => {
      // The analysis fetches the same 80 m anchor twice — once to choose the
      // street, once to collect its descriptions. Overpass absorbs that on its
      // disk cache; the BD TOPO adapter has none.
      const fetchNeighbourhood = vi.fn(async () => ({ ...PRIMARY_HOOD, ways: DONOR_WAYS }));
      const { source } = build({ fetchNeighbourhood, fetchCorridor: async () => [] });

      await source.fetchNeighbourhood(O, 80);
      await source.fetchNeighbourhood(O, 80);

      expect(fetchNeighbourhood).toHaveBeenCalledTimes(1);
    });
  });
});
