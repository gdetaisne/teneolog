/**
 * The orchestrator on stub ports: sequencing, the widening ladder, and the
 * assembly of facts across sources. The measurement logic itself is tested in
 * its own packages — here the fixtures only need enough road to steer the
 * control flow.
 */
import { describe, expect, it } from 'vitest';
import type { GeocodeOpinion, GeoPoint } from '@teneolog/domain';
import type { RoadNeighbourhood, RoadWay, Surface } from '@teneolog/topology';

import { analyseAddress, ElevationNoDataError, type PipelineParams, type PipelinePorts } from '../src/analyse.js';

const O: GeoPoint = { lat: 47.0, lon: 1.0 };
const NOW = (): string => '2026-08-24T00:00:00Z';
const M_PER_DEG_LAT = 111_320;

function at(base: GeoPoint, northM: number, eastM: number): GeoPoint {
  return {
    lat: base.lat + northM / M_PER_DEG_LAT,
    lon: base.lon + eastM / (M_PER_DEG_LAT * Math.cos((base.lat * Math.PI) / 180)),
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
    tags: {},
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

const PARAMS: PipelineParams = {
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

/**
 * A through street whose continuations only appear in the wider fetch.
 *
 * The street's tips sit at ±90 m — OUTSIDE an 80 m fetch — so the small world
 * honours the port contract (a way touching a point inside R is present; ways
 * touching only exterior nodes may be absent) and the 80 m answer is a
 * non-interior dead end, which is exactly the "fetch wider" signal.
 */
function ladderWorld(radiusM: number): RoadNeighbourhood {
  const street = way('street', ['a', 'b'], [at(O, 0, -90), at(O, 0, 90)], {
    name: 'Rue Test',
    declaredWidthM: 5,
  });
  if (radiusM <= 80) return hoodOf(O, radiusM, [street]);
  const west = way('west', ['w', 'a'], [at(O, 0, -170), at(O, 0, -90)]);
  const east = way('east', ['b', 'e'], [at(O, 0, 90), at(O, 0, 170)]);
  return hoodOf(O, radiusM, [street, west, east]);
}

function ports(overrides: Partial<PipelinePorts> = {}): PipelinePorts {
  const opinion: GeocodeOpinion = { source: 'ban', point: O, score: 0.95, formatted: '1 Rue Test', banId: '36044_1234_00001', positionType: 'housenumber' };
  return {
    geocode: { geocode: async () => [opinion] },
    graph: { fetchNeighbourhood: async (c, r) => ladderWorld(r) },
    surfaces: { fetchSurfaces: async (): Promise<readonly Surface[]> => [] },
    ...overrides,
  };
}

describe('analyseAddress', () => {
  it('runs S0→S2 end to end from a text address', async () => {
    const outcome = await analyseAddress(
      { kind: 'address', address: '1 Rue Test, 36000 Châteauroux' },
      ports(),
      PARAMS,
      NOW,
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.facts.anchor.point.known).toBe(true);
    expect(outcome.facts.anchor.normalisedAddress).toBe('1 rue test, 36000 chateauroux');
    expect(outcome.facts.topology.topology.kind).toBe('THROUGH');
    expect(outcome.facts.stop.width.known).toBe(true);
  });

  it('obeys the widening ladder: the 80 m world is a false dead end, 160 m resolves it', async () => {
    const calls: number[] = [];
    const outcome = await analyseAddress(
      { kind: 'point', point: O },
      ports({
        graph: {
          fetchNeighbourhood: async (c, r) => {
            calls.push(r);
            return ladderWorld(r);
          },
        },
      }),
      PARAMS,
      NOW,
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(calls).toContain(160);
    expect(outcome.facts.resolvedAtRadiusM).toBe(160);
    expect(outcome.facts.topology.topology.kind).toBe('THROUGH');
  });

  it('a geocoder returning nothing fails at the geocode stage, no invented point', async () => {
    const outcome = await analyseAddress(
      { kind: 'address', address: 'nowhere' },
      ports({ geocode: { geocode: async () => [] } }),
      PARAMS,
      NOW,
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.stage).toBe('geocode');
  });

  it('a BAN hit under geocoding.minBanScore is an unknown, not a point — the run stops at geocode', async () => {
    // "200 Rue de la Loi Bruxelles" → BAN answers "Rue de Bruxelles 44300 Nantes" at 0.537.
    const homonym: GeocodeOpinion = { source: 'ban', point: O, score: 0.537, formatted: 'Rue de Bruxelles 44300 Nantes', banId: null, positionType: 'street' };
    const graphCalls: number[] = [];
    const outcome = await analyseAddress(
      { kind: 'address', address: '200 Rue de la Loi Bruxelles' },
      ports({
        geocode: { geocode: async () => [homonym] },
        graph: { fetchNeighbourhood: async (c, r) => { graphCalls.push(r); return ladderWorld(r); } },
      }),
      PARAMS,
      NOW,
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.stage).toBe('geocode');
    expect(outcome.why).toBe('below_confidence');
    // Nothing downstream ran on the homonym.
    expect(graphCalls).toHaveLength(0);
    // The anchor says what was refused: the point is unknown with its cause,
    // and BAN's own label is kept for the interface to show.
    expect(outcome.anchor).toBeDefined();
    if (outcome.anchor === undefined) return;
    expect(outcome.anchor.requestedAddress).toBe('200 Rue de la Loi Bruxelles');
    expect(outcome.anchor.point.known).toBe(false);
    if (outcome.anchor.point.known) return;
    expect(outcome.anchor.point.why).toBe('below_confidence');
    expect(outcome.anchor.geocodeAgreement.known).toBe(true);
    if (!outcome.anchor.geocodeAgreement.known) return;
    expect(outcome.anchor.geocodeAgreement.value.chosen.formatted).toBe('Rue de Bruxelles 44300 Nantes');
    expect(outcome.anchor.geocodeAgreement.value.chosen.score).toBe(0.537);
  });

  it('a hit exactly at the threshold passes; the threshold is inclusive', async () => {
    const borderline: GeocodeOpinion = { source: 'ban', point: O, score: 0.6, formatted: '1 Rue Test', banId: null, positionType: 'housenumber' };
    const outcome = await analyseAddress(
      { kind: 'address', address: '1 Rue Test' },
      ports({ geocode: { geocode: async () => [borderline] } }),
      PARAMS,
      NOW,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.facts.anchor.point.known).toBe(true);
    if (!outcome.facts.anchor.point.known) return;
    expect(outcome.facts.anchor.point.reliability.confidence).toBe(0.6);
  });

  it('a caller-supplied point is not held against the BAN score', async () => {
    const outcome = await analyseAddress(
      { kind: 'point', point: O, label: 'pin' },
      ports({ geocode: { geocode: async () => { throw new Error('must not be called'); } } }),
      PARAMS,
      NOW,
    );
    expect(outcome.ok).toBe(true);
  });

  // -- ce que la suggestion cliquée savait d'elle-même -------------

  it("sans opinion relayée, le chemin point est exactement celui d'avant", async () => {
    const outcome = await analyseAddress({ kind: 'point', point: O, label: 'pin' }, ports(), PARAMS, NOW);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.facts.anchor.geocodeAgreement).toEqual({ known: false, why: 'not_applicable' });
  });

  it('une opinion relayée devient un fait, sans appeler le géocodeur', async () => {
    const outcome = await analyseAddress(
      {
        kind: 'point',
        point: O,
        label: '12 Rue de l’Exemple 17290 Thairé',
        opinion: { score: 0.97, banId: '17444_9999_00012', positionType: 'housenumber' },
      },
      ports({ geocode: { geocode: async () => { throw new Error('must not be called'); } } }),
      PARAMS,
      NOW,
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const agreement = outcome.facts.anchor.geocodeAgreement;
    expect(agreement.known).toBe(true);
    if (!agreement.known) return;
    expect(agreement.provenance.method).toBe('caller-relayed-suggestion');
    expect(agreement.value.opinions).toEqual([
      {
        source: 'ban',
        point: O,
        score: 0.97,
        formatted: '12 Rue de l’Exemple 17290 Thairé',
        banId: '17444_9999_00012',
        positionType: 'housenumber',
      },
    ]);
    expect(agreement.value.maxDisagreementM).toBe(0);
    // Le point reste pris au pied de la lettre : l'opinion ne le renote pas.
    expect(outcome.facts.anchor.point.known).toBe(true);
    if (!outcome.facts.anchor.point.known) return;
    expect(outcome.facts.anchor.point.reliability.confidence).toBe(1);
    expect(outcome.facts.anchor.point.provenance.method).toBe('caller-supplied-point');
  });

  it("test d'or — le point et la rue sont identiques avec et sans les nouveaux champs", async () => {
    const bare = await analyseAddress({ kind: 'point', point: O, label: 'pin' }, ports(), PARAMS, NOW);
    const enriched = await analyseAddress(
      {
        kind: 'point',
        point: O,
        label: 'pin',
        opinion: { score: 0.97, banId: '17444_9999_00012', positionType: 'housenumber' },
      },
      ports(),
      PARAMS,
      NOW,
    );

    expect(bare.ok).toBe(true);
    expect(enriched.ok).toBe(true);
    if (!bare.ok || !enriched.ok) return;
    expect(enriched.facts.anchor.point).toEqual(bare.facts.anchor.point);
    expect(enriched.facts.anchor.street).toEqual(bare.facts.anchor.street);
    expect(enriched.facts.anchor.streetSearch).toEqual(bare.facts.anchor.streetSearch);
    expect(enriched.facts.stop).toEqual(bare.facts.stop);
    expect(enriched.facts.topology).toEqual(bare.facts.topology);
    // Seul l'accord des géocodeurs change : c'est toute la mesure de l'ajout.
    expect(enriched.facts.anchor.geocodeAgreement).not.toEqual(bare.facts.anchor.geocodeAgreement);
  });

  it("une opinion sans score reste sans objet — un score est la façon de peser une opinion", async () => {
    const outcome = await analyseAddress(
      { kind: 'point', point: O, label: 'pin', opinion: { score: Number.NaN, positionType: 'street' } },
      ports(),
      PARAMS,
      NOW,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.facts.anchor.geocodeAgreement).toEqual({ known: false, why: 'not_applicable' });
  });

  it('every S0–S2 fact carries the one fetchedAt of the run, including the topology (observedAt is not a policy value)', async () => {
    let calls = 0;
    const clock = (): string => {
      calls += 1;
      return `2026-09-09T10:00:00.00${calls}Z`;
    };
    // An 80 m-only ladder leaves the street a (non-interior) dead end, so the
    // topology has to publish a turnaround and an entry direction — the two
    // facts that used to carry the boot-time `observedAt`.
    const outcome = await analyseAddress(
      { kind: 'point', point: O },
      ports(),
      { ...PARAMS, fetchLadderM: [80] },
      clock,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(calls).toBe(1);
    const stamp = '2026-09-09T10:00:00.001Z';
    expect(outcome.facts.anchor.point.known && outcome.facts.anchor.point.provenance.fetchedAt).toBe(stamp);
    expect(outcome.facts.anchor.street.known && outcome.facts.anchor.street.provenance.fetchedAt).toBe(stamp);
    expect(outcome.facts.stop.width.known && outcome.facts.stop.width.provenance.fetchedAt).toBe(stamp);
    const topology = outcome.facts.topology.topology;
    if (topology.kind === 'THROUGH') throw new Error('fixture must read as a dead end at 80 m');
    expect(topology.turnaround.known && topology.turnaround.provenance.fetchedAt).toBe(stamp);
    expect(topology.entryDirection.known && topology.entryDirection.provenance.fetchedAt).toBe(stamp);
  });

  it('BUG-016: the spread between geocoder opinions is recorded as a fact', async () => {
    const near: GeocodeOpinion = { source: 'ban', point: O, score: 0.95, formatted: 'x', banId: null, positionType: 'housenumber' };
    const far: GeocodeOpinion = { source: 'google', point: at(O, 200, 100), score: 0.9, formatted: 'x', banId: null, positionType: null };
    const outcome = await analyseAddress(
      { kind: 'address', address: 'x' },
      ports({ geocode: { geocode: async () => [near, far] } }),
      PARAMS,
      NOW,
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const agreement = outcome.facts.anchor.geocodeAgreement;
    expect(agreement.known).toBe(true);
    if (!agreement.known) return;
    expect(agreement.value.maxDisagreementM).toBeGreaterThan(200);
  });

  it('BUG-087 posture: the secondary source joins the legal merge — an OSM-only limit reaches the band', async () => {
    const bdtopoWay = way('bd-1', ['x', 'y'], [at(O, 2, -60), at(O, 2, 60)], {
      source: 'bdtopo-postgis',
    });
    const osmWithLimit = ladderWorld(160).ways.map((w) =>
      w.id === 'street'
        ? { ...w, limits: { ...w.limits, maxWeightT: 7.5 } }
        : w,
    );

    const outcome = await analyseAddress(
      { kind: 'point', point: O },
      ports({
        graph: { fetchNeighbourhood: async (c, r) => hoodOf(O, r, r <= 80 ? osmWithLimit.filter((w) => w.id === 'street') : osmWithLimit) },
        secondaryGraph: { fetchNeighbourhood: async (c, r) => hoodOf(O, r, [bdtopoWay]) },
      }),
      PARAMS,
      NOW,
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const weight = outcome.facts.stop.legal.maxWeightT;
    expect(weight.known).toBe(true);
    if (!weight.known) return;
    expect(weight.value.value).toBe(7.5);
    // Both sources described the street; only OSM stated the limit.
    expect(weight.value.sources).toEqual(['osm-overpass']);
  });

  it('no street within snap: fails at the street stage and still returns the anchor', async () => {
    const outcome = await analyseAddress(
      { kind: 'point', point: at(O, 500, 500) },
      ports(),
      PARAMS,
      NOW,
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.stage).toBe('street');
    expect(outcome.anchor?.point.known).toBe(true);
  });

  it('measures slope along the east-west delivery axis, not north-south', async () => {
    const calls: GeoPoint[][] = [];
    const outcome = await analyseAddress(
      { kind: 'point', point: O },
      ports({
        elevation: {
          getElevations: async (points) => {
            calls.push([...points]);
            return points.map((at, i) => ({ at, elevationMeters: 10 + i * 5 }));
          },
        },
      }),
      PARAMS,
      NOW,
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(calls).toHaveLength(1);
    const pair = calls[0];
    expect(pair).toBeDefined();
    const [from, to] = pair as [GeoPoint, GeoPoint];
    expect(from.lon).toBeLessThan(O.lon);
    expect(to.lon).toBeGreaterThan(O.lon);
    expect(Math.abs(from.lat - O.lat)).toBeLessThan(0.00001);
    expect(Math.abs(to.lat - O.lat)).toBeLessThan(0.00001);
    expect(outcome.facts.stop.slopePct.known).toBe(true);
    if (!outcome.facts.stop.slopePct.known) return;
    expect(outcome.facts.stop.slopePct.value).toBeGreaterThan(0);
  });

  it('the slope is signed by the port that read the heights (IGN RGE ALTI), never by a hard-coded Google', async () => {
    const outcome = await analyseAddress(
      { kind: 'point', point: O },
      ports({
        elevation: {
          source: 'ign-rge-alti',
          getElevations: async (points) => points.map((at, i) => ({ at, elevationMeters: 10 + i * 5 })),
        },
      }),
      PARAMS,
      NOW,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok || !outcome.facts.stop.slopePct.known) throw new Error('slope expected');
    expect(outcome.facts.stop.slopePct.provenance.method).toBe('ign-rge-alti-delivery-axis');
  });

  it('does not invent a slope when the elevation port is absent', async () => {
    const outcome = await analyseAddress({ kind: 'point', point: O }, ports(), PARAMS, NOW);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.facts.stop.slopePct.known).toBe(false);
  });

  it('a failing elevation provider leaves slope unknown, never 0 %', async () => {
    const outcome = await analyseAddress(
      { kind: 'point', point: O },
      ports({
        elevation: {
          getElevations: async () => {
            throw new Error('timeout');
          },
        },
      }),
      PARAMS,
      NOW,
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.facts.stop.slopePct.known).toBe(false);
    if (outcome.facts.stop.slopePct.known) return;
    expect(outcome.facts.stop.slopePct.why).toBe('provider_error');
  });

  it('a point the model does not cover is no data, not a provider failure (relecture du 2026-09-30)', async () => {
    const outcome = await analyseAddress(
      { kind: 'point', point: O },
      ports({
        elevation: {
          getElevations: async () => {
            throw new ElevationNoDataError(2);
          },
        },
      }),
      PARAMS,
      NOW,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok || outcome.facts.stop.slopePct.known) throw new Error('slope unknown expected');
    expect(outcome.facts.stop.slopePct.why).toBe('no_data');
  });
});

/**
 * S0 publie son propre doute avec ses facts.
 *
 * Le lecteur (le prédicat de l'arrêt évident, `/explain`) ne relit jamais
 * `considered[]` : il lit ce champ. Ces deux tests vérifient donc la seule
 * chose que le câblage doit garantir — que le champ existe, et qu'il porte les
 * seuils sous lesquels il a été lu.
 */
describe('analyseAddress — le doute de S0', () => {
  it('sans paramètres de doute, le champ existe et ne dit rien', async () => {
    const outcome = await analyseAddress({ kind: 'point', point: O }, ports(), PARAMS, NOW);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.facts.streetDoubt?.doubtful).toBe(false);
    expect(outcome.facts.streetDoubt?.reasons).toEqual([]);
  });

  it('avec la règle posée, le doute porte les seuils sous lesquels il a été lu', async () => {
    const outcome = await analyseAddress(
      { kind: 'point', point: O },
      ports(),
      { ...PARAMS, streetDoubt: { enabled: true, nearMissM: 2, minConfidence: 0.9 } },
      NOW,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.facts.streetDoubt?.details).toMatchObject({
      maxSnapM: 30,
      ambiguityWindowM: 12,
      nearMissM: 2,
      minConfidence: 0.9,
    });
  });
});
