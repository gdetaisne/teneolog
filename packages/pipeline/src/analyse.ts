/**
 * S0 → S2 in one pass: address (or point) → anchor, terminal topology, stop
 * constraints.
 *
 * This layer owns exactly two behaviours the pure stages refuse to own:
 *
 * 1. The WIDENING LADDER. A terminal claim marked non-interior means "this
 *    would not survive a wider fetch" — live verification proved it: Clamart
 *    resolves THROUGH at 160 m, the Auxerre N77 at 320 m, and publishing the
 *    80 m shape would have shipped two false dead ends. THROUGH is stable
 *    under widening (more road cannot close an open street), so it exits the
 *    ladder early; a terminal shape exits only once interior.
 *
 * 2. The ASSEMBLY of facts across sources. The geocoders' disagreement, the
 *    street chosen against its rivals, and the merged legal bands each come
 *    from a different port; this is where they become one `S0S2Facts`.
 *
 * Everything numeric arrives in `PipelineParams` — working values chosen by
 * the caller, versioned later by the Policy console. Nothing here is pure
 * (ports do I/O), but nothing here measures either: measurement stays in the
 * stage packages, sequencing stays here.
 */
import { assembleStopConstraints, deliveryAxisBearingDeg, slopePctFromElevations, slopeSamplePoints } from '@teneolog/constraints';
import type {
  DeliveryAnchor,
  Fact,
  GeocodeAgreement,
  GeocodeOpinion,
  GeoPoint,
  LowEmissionZone,
  StopConstraints,
  StreetSearch,
  TopologyAssessment,
  Width,
} from '@teneolog/domain';
import {
  assessTopology,
  closestPointOnPolyline,
  haversineM,
  selectDeliveryStreetWithSearch,
  type DeclaredWay,
  type GeocodePort,
  type RoadGraphPort,
  type RoadNeighbourhood,
  type RoadWay,
  type StreetSelectionInput,
  type StreetSelectionResult,
  type Surface,
  type SurfacePort,
  type TopologyAssessmentInput,
  type TurnaroundMeasurementOptions,
} from '@teneolog/topology';

import { fallbackStopFacts, lowEmissionZoneAt, type FallbackStopFacts } from './fallback-stop.js';
import { streetDoubt, type StreetDoubt, type StreetDoubtParams } from './street-doubt.js';

export interface StopWidthPort {
  /** Measure the carriageway width at the stop, on imagery, anchored there. */
  measureStopWidth(at: GeoPoint, street: RoadWay): Promise<Fact<Width>>;
}

export interface LowEmissionZonePort {
  /** The zone in force at a point, or `null` when the base holds none there. */
  zoneAt(at: GeoPoint): Promise<LowEmissionZone | null>;
}

export interface ElevationSample {
  readonly at: GeoPoint;
  readonly elevationMeters: number;
}

/**
 * A point the elevation model does not cover (the sea, abroad): no height —
 * not a provider failure. S2 reads it `no_data`, never `provider_error`
 * (relecture du 2026-09-30, principe 14). Adapters extend it
 * (`IgnAltimetryNoDataError`); the port declares it, so the pipeline need not
 * know who read the heights.
 */
export class ElevationNoDataError extends Error {
  constructor(readonly missing: number) {
    super(`elevation: no height at ${missing} point(s)`);
    this.name = 'ElevationNoDataError';
  }
}

export interface ElevationPort {
  /**
   * Who reads the heights (`ign-rge-alti`, `google-elevation`) — the slope's
   * provenance says it (`<source>-delivery-axis`): a grade without its source
   * cannot be argued with. Absent: `elevation`.
   */
  readonly source?: string;
  /** Heights at the given points, same order. Throws on provider failure; `ElevationNoDataError` where the model has no height. */
  getElevations(points: readonly GeoPoint[]): Promise<readonly ElevationSample[]>;
}

export interface PipelinePorts {
  readonly geocode: GeocodePort;
  readonly graph: RoadGraphPort;
  readonly surfaces: SurfacePort;
  /** Optional imagery measurement; without it the declared width stands alone. */
  readonly stopWidth?: StopWidthPort;
  /**
   * Optional low-emission-zone lookup. Absent — or failing — the zone fact
   * stays an explicit unknown, which the interface must render as "not
   * checked" and never as "no restriction".
   */
  readonly lowEmissionZones?: LowEmissionZonePort;
  /**
   * Optional elevation lookup. Absent or failing, slope stays unknown — the
   * chip says so; we never invent 0 %.
   */
  readonly elevation?: ElevationPort;
  /**
   * Optional second road-graph source. Its nearest way to the anchor joins the
   * street descriptions fed to the legal-band merge, which is how a weight
   * limit present in one source and absent from the other reaches the report
   * (the BUG-087 posture: BDTOPO and OSM describing the same street).
   */
  readonly secondaryGraph?: RoadGraphPort;
}

export interface PipelineParams {
  /** Ascending fetch radii; the last one is the cost ceiling. */
  readonly fetchLadderM: readonly number[];
  readonly surfacesRadiusM: number;
  readonly selection: Omit<StreetSelectionInput, 'point' | 'neighbourhood' | 'fetchedAt' | 'declaredWay'>;
  /**
   * Topology thresholds. `measurement.observedAt` is deliberately NOT a
   * parameter: the acquisition time is the run's `fetchedAt`, stamped here at
   * the moment the facts are acquired, never frozen in a policy.
   */
  readonly assessment: Omit<
    TopologyAssessmentInput,
    'neighbourhood' | 'surfaces' | 'deliveryWayId' | 'deliveryPoint' | 'measurement'
  > & { readonly measurement: Omit<TurnaroundMeasurementOptions, 'observedAt'> };
  readonly declaredWidthConfidence: number;
  /** Snap used to pair the secondary source's description of the same street. */
  readonly secondaryDescriptionSnapM: number;
  /**
   * comment lire le doute de S0. Absent, et le doute est lu avec la
   * règle éteinte (`STREET_DOUBT_OFF`) : les raisons restent vides et rien en
   * aval ne change. C'est la forme que joue le test d'or.
   */
  readonly streetDoubt?: StreetDoubtParams;
  readonly geocoding: {
    /**
     * BAN's best hit below this score is not a point, it is an
     * unknown (`below_confidence`). BAN always answers with its closest French
     * address — "Rue de la Loi 200 Bruxelles" lands on a Rue de Bruxelles in
     * Nantes at 0.54 — and a run on the wrong country must stop here.
     */
    readonly minBanScore: number;
  };
}

export interface S0S2Facts {
  readonly anchor: DeliveryAnchor;
  readonly topology: TopologyAssessment;
  readonly stop: StopConstraints;
  /** The radius the topology finally resolved at — cost and audit signal. */
  readonly resolvedAtRadiusM: number;
  /**
   * ce que S0 doute de son propre choix de rue, dérivé de l'ancre et
   * de rien d'autre. Optionnel : les facts construits à la main par les tests,
   * et ceux d'un run stocké avant le champ, n'en portent pas — un lecteur qui
   * n'en trouve pas doit se comporter comme avant la règle.
   */
  readonly streetDoubt?: StreetDoubt;
  /**
   * l'arrêt de repli sur la rue d'avant, avec ses contraintes S2,
   * calculé sur toute impasse et jamais choisi ici (principe 10). Absent quand
   * la policy n'en donne pas les bandes, et sur tout fait antérieur au champ.
   */
  readonly fallbackStop?: Fact<FallbackStopFacts>;
}

export type AnalyseInput =
  | { readonly kind: 'address'; readonly address: string }
  | {
      readonly kind: 'point';
      readonly point: GeoPoint;
      readonly label?: string;
      /**
       * ce que le géocodeur savait du point AVANT que le client ne
       * le clique, relayé tel quel. Rien ici n'entre dans le calcul : le point
       * reste pris au pied de la lettre, la rue se choisit comme avant. Ces
       * champs servent uniquement à ce que l'écran cesse de présenter un point
       * cliqué comme un point vérifié.
       */
      readonly opinion?: {
        readonly score: number;
        readonly banId?: string | null;
        readonly positionType?: string | null;
      };
      /**
       * la voie sur laquelle ce point a été mesuré, et qui l'y a
       * posé (`StreetSelectionInput.declaredWay`). L'arrêt de repli du moteur
       * (`fallback_stop`) garde sa rue d'avant sans concours ; un point cliqué
       * (`clicked_point`), accroché par l'aperçu à la chaussée la plus proche,
       * ne fait que départager une égalité du concours de S0.
       */
      readonly onWay?: DeclaredWay;
    };

export type AnalyseOutcome =
  | { readonly ok: true; readonly facts: S0S2Facts }
  | {
      readonly ok: false;
      readonly stage: 'geocode' | 'street';
      /**
       * `geocode` stage: `no_geocoder_result` (nothing came back) or
       * `below_confidence` (a hit came back, under `geocoding.minBanScore`).
       * In the second case `anchor.geocodeAgreement` carries what BAN
       * understood, so the interface can show the rejected label and score.
       */
      readonly why: string;
      readonly anchor?: DeliveryAnchor;
    };

export async function analyseAddress(
  input: AnalyseInput,
  ports: PipelinePorts,
  params: PipelineParams,
  now: () => string,
): Promise<AnalyseOutcome> {
  const fetchedAt = now();

  // ---- S0a: where -----------------------------------------------------------
  const geocode = await resolveGeocode(input, ports, params.geocoding.minBanScore, fetchedAt);
  if (!geocode.point.known) {
    if (geocode.point.why === 'below_confidence') {
      // BAN answered, we refused it. The anchor still carries the opinion so
      // the reader sees "understood as X (score 0.54)" instead of a blank.
      const anchor: DeliveryAnchor = {
        requestedAddress: requestedLabel(input),
        normalisedAddress: normalise(requestedLabel(input)),
        point: geocode.point,
        street: { known: false, why: 'no_data' },
        geocodeAgreement: geocode.agreement,
        // No point, so no neighbourhood was ever fetched: there is nothing the
        // street search could have looked at.
        streetSearch: null,
      };
      return { ok: false, stage: 'geocode', why: 'below_confidence', anchor };
    }
    return { ok: false, stage: 'geocode', why: 'no_geocoder_result' };
  }
  const point = geocode.point.value;

  // ---- S0b + S1: which street, what shape — under the widening ladder -------
  const surfaces = await ports.surfaces.fetchSurfaces(point, params.surfacesRadiusM);
  const shape = await resolveStreetShape(point, surfaces, ports, params, fetchedAt, declaredWayOf(input));
  const { chosen, streetSearch, topology, resolvedAtRadiusM } = shape;

  const anchor: DeliveryAnchor = {
    requestedAddress: requestedLabel(input),
    normalisedAddress: normalise(requestedLabel(input)),
    point: geocode.point,
    street: chosen ?? { known: false, why: 'no_data' },
    geocodeAgreement: geocode.agreement,
    streetSearch,
  };

  if (chosen === null || !chosen.known || topology === null) {
    return {
      ok: false,
      stage: 'street',
      why: chosen !== null && !chosen.known ? chosen.why : 'no_street_resolved',
      anchor,
    };
  }

  // ---- S2: constraints at the stop ------------------------------------------
  const descriptions = await collectDescriptions(chosen.value.segmentId, point, ports, params);

  let measuredWidth: Fact<Width> | undefined;
  if (ports.stopWidth !== undefined) {
    const chosenDescription = descriptions.find((d) => d.id === chosen.value.segmentId);
    if (chosenDescription !== undefined) {
      try {
        measuredWidth = await ports.stopWidth.measureStopWidth(point, chosenDescription);
      } catch {
        // An imagery failure degrades to the declared width; it must never
        // fail the analysis, and never masquerade as a measurement.
        measuredWidth = { known: false, why: 'provider_error' };
      }
    }
  }

  // A zone lookup that fails must leave an unknown, never a reassuring silence.
  const lowEmissionZone: Fact<LowEmissionZone | null> =
    (await lowEmissionZoneAt(ports, point, fetchedAt)) ?? { known: false, why: 'no_data' };

  const measuredSlope = await measureStopSlope(point, descriptions, ports, fetchedAt);

  const stop = assembleStopConstraints({
    // les barrières de la rue retenue voyagent jusqu'à
    // l'arrêt : c'est lui qu'elles ferment, et rien ne les lisait. Sur la même
    // ligne que `at` parce que cette fonction est gelée à sa borne de lignes
    // (principe 26) et que le correctif du jour n'a pas à la découper.
    at: point, barriers: topology.barriers,
    descriptions,
    fetchedAt,
    declaredWidthConfidence: params.declaredWidthConfidence,
    lowEmissionZone,
    ...(measuredWidth === undefined ? {} : { measuredWidth }),
    ...(measuredSlope === undefined ? {} : { measuredSlope }),
  });

  // S2 at the fallback stop, from the rung's own neighbourhood: no
  // refetch, and the same assembly as the delivery stop.
  const fallbackStop = await fallbackStopFacts(topology, shape.neighbourhood, ports, params, fetchedAt);

  return {
    ok: true,
    facts: {
      anchor,
      topology,
      stop,
      resolvedAtRadiusM,
      // le doute de S0, lu sur ce que S0 vient d'écrire. Calculé ici
      // et non chez le lecteur pour qu'il n'existe qu'une seule lecture de
      // `considered[]` — la revue, la découverte silencieuse et `/explain`
      // regardent le même objet.
      streetDoubt: streetDoubt(anchor, params.streetDoubt),
      ...(fallbackStop === undefined ? {} : { fallbackStop }),
    },
  };
}

interface StreetShape {
  readonly chosen: StreetSelectionResult['street'] | null;
  /**
   * The grey layer of the ladder round `chosen` came from. The loop overwrites
   * its own result at each radius, so the search follows the choice
   * rather than accumulating across rounds — showing a rival from a radius the
   * decision no longer stands on would explain the wrong run.
   */
  readonly streetSearch: StreetSearch | null;
  readonly topology: TopologyAssessment | null;
  readonly resolvedAtRadiusM: number;
  /**
   * the neighbourhood of the rung the shape was resolved at, kept so
   * S2 bis can read the parent street without a second fetch. Null when no
   * rung ran.
   */
  readonly neighbourhood: RoadNeighbourhood | null;
}

/**
 * The widening ladder (see the module header): THROUGH exits early, a terminal
 * shape exits once interior. Split out of `analyseAddress` (frozen, principe
 * 26) when needed the rung's neighbourhood after the loop.
 */
async function resolveStreetShape(
  point: GeoPoint,
  surfaces: readonly Surface[],
  ports: PipelinePorts,
  params: PipelineParams,
  fetchedAt: string,
  declaredWay: DeclaredWay | undefined,
): Promise<StreetShape> {
  let chosen: StreetSelectionResult['street'] | null = null;
  let streetSearch: StreetSearch | null = null;
  let topology: TopologyAssessment | null = null;
  let resolvedAtRadiusM = 0;
  let neighbourhood: RoadNeighbourhood | null = null;

  for (const radiusM of params.fetchLadderM) {
    resolvedAtRadiusM = radiusM;
    neighbourhood = await ports.graph.fetchNeighbourhood(point, radiusM);
    const selection = selectDeliveryStreetWithSearch({
      ...params.selection,
      point,
      neighbourhood,
      fetchedAt,
      ...(declaredWay === undefined ? {} : { declaredWay }),
    });
    chosen = selection.street;
    streetSearch = selection.search;
    if (!chosen.known) continue;
    topology = assessTopology({
      ...params.assessment,
      // The pure stage may not read a clock: it is handed the run's own
      // acquisition time, the same one every other fact of this run carries.
      measurement: { ...params.assessment.measurement, observedAt: fetchedAt },
      neighbourhood,
      surfaces,
      deliveryWayId: chosen.value.segmentId,
      deliveryPoint: point,
    });
    if (topology.topology.kind === 'THROUGH' || topology.terminalNodeInterior) break;
  }
  return { chosen, streetSearch, topology, resolvedAtRadiusM, neighbourhood };
}

interface GeocodeFacts {
  readonly point: Fact<GeoPoint>;
  readonly agreement: Fact<GeocodeAgreement>;
}

async function resolveGeocode(
  input: AnalyseInput,
  ports: PipelinePorts,
  minScore: number,
  fetchedAt: string,
): Promise<GeocodeFacts> {
  if (input.kind === 'point') {
    // A caller-supplied point is taken at face value and says so.
    return {
      point: {
        known: true,
        value: input.point,
        provenance: { source: 'human', method: 'caller-supplied-point', fetchedAt },
        reliability: { confidence: 1, basis: 'declared', reasonCodes: ['point_supplied'] },
      },
      // when the caller relays what the geocoder said about the point
      // it clicked, that is an opinion — not a geocoding we performed. It is
      // published under its own method so the reader never mistakes a relayed
      // suggestion for a verification: nothing was called, nothing was
      // compared, and the point above is unchanged either way. Without a score
      // there is no opinion to publish — a score is how an opinion is weighed —
      // and the fact stays `not_applicable`, as it always was.
      agreement: relayedAgreement(input.opinion, input.point, input.label, fetchedAt),
    };
  }

  const opinions = await ports.geocode.geocode(input.address);
  const best = [...opinions].sort((a, b) => b.score - a.score)[0];
  if (best === undefined) {
    return {
      point: { known: false, why: 'no_data' },
      agreement: { known: false, why: 'no_data' },
    };
  }

  // The spread between opinions is a fact about the address (BUG-016: BAN and
  // Google 247 m apart at Aubagne) — recorded even when only one geocoder ran,
  // where it is trivially zero.
  const maxDisagreementM = Math.max(
    0,
    ...opinions.map((o) => haversineM(o.point, best.point)),
  );

  // What the geocoders said is a fact whatever we make of it: kept even when
  // the best opinion is refused below, so the refusal can name what it refused.
  const agreement: Fact<GeocodeAgreement> = {
    known: true,
    value: { opinions, chosen: best, maxDisagreementM },
    provenance: { source: 'geocoder-ban', method: 'opinion-spread', fetchedAt },
    reliability: { confidence: 1, basis: 'derived', reasonCodes: [] },
  };

  // a geocoder always answers with its nearest guess. Under the
  // policy score the guess is not a place we analyse — it is an unknown, and
  // the run stops here rather than measuring a homonym in another town.
  if (!(best.score >= minScore)) {
    return {
      point: {
        known: false,
        why: 'below_confidence',
        provenance: { source: 'geocoder-ban', method: 'best-score-opinion', fetchedAt },
      },
      agreement,
    };
  }

  return {
    point: {
      known: true,
      value: best.point,
      provenance: { source: 'geocoder-ban', method: 'best-score-opinion', fetchedAt },
      reliability: {
        confidence: best.score,
        basis: 'derived',
        reasonCodes: opinions.length > 1 ? ['multi_geocoder'] : ['single_geocoder'],
      },
    },
    agreement,
  };
}

/**
 * What the geocoder said about a point the caller clicked.
 *
 * The nominal path of `/user` is a picked suggestion: no network call, no
 * threshold, `confidence: 1` on a point nobody re-checked. BAN had said more
 * about that point — a score, a numéro id, and WHAT it posed the point on —
 * and every one of those words was dropped between the suggestion list and the
 * analysis. Relayed here, they become one opinion, and the report stops
 * showing a clicked point as a verified one.
 *
 * The opinion is declared, not derived: we are repeating the caller, not
 * calling anyone. `maxDisagreementM` is 0 because there is exactly one opinion
 * and it is, trivially, the point itself.
 */
function relayedAgreement(
  opinion: { readonly score: number; readonly banId?: string | null; readonly positionType?: string | null } | undefined,
  point: GeoPoint,
  label: string | undefined,
  fetchedAt: string,
): Fact<GeocodeAgreement> {
  if (opinion === undefined || !Number.isFinite(opinion.score)) {
    return { known: false, why: 'not_applicable' };
  }
  const relayed: GeocodeOpinion = {
    source: 'ban',
    point,
    score: opinion.score,
    formatted: label ?? '',
    banId: opinion.banId ?? null,
    positionType: opinion.positionType ?? null,
  };
  return {
    known: true,
    value: { opinions: [relayed], chosen: relayed, maxDisagreementM: 0 },
    provenance: { source: 'geocoder-ban', method: 'caller-relayed-suggestion', fetchedAt },
    reliability: { confidence: opinion.score, basis: 'declared', reasonCodes: ['point_supplied'] },
  };
}

/**
 * The chosen street, plus — when a secondary graph exists — that source's own
 * description of the same street, paired by proximity to the anchor.
 */
async function collectDescriptions(
  chosenWayId: string,
  point: GeoPoint,
  ports: PipelinePorts,
  params: PipelineParams,
): Promise<readonly RoadWay[]> {
  const primary = await ports.graph.fetchNeighbourhood(point, params.fetchLadderM[0] ?? 80);
  const chosenWay = primary.ways.find((w) => w.id === chosenWayId);
  const descriptions: RoadWay[] = chosenWay === undefined ? [] : [chosenWay];

  if (ports.secondaryGraph !== undefined) {
    const secondary = await ports.secondaryGraph.fetchNeighbourhood(
      point,
      params.fetchLadderM[0] ?? 80,
    );
    const counterpart = nearestWay(secondary.ways, point, params.secondaryDescriptionSnapM);
    if (counterpart !== null) descriptions.push(counterpart);
  }
  return descriptions;
}

/**
 * Grade along the first description that has a usable street axis. No port,
 * no axis, or a provider hole → unknown, never 0 %.
 */
async function measureStopSlope(
  at: GeoPoint,
  descriptions: readonly RoadWay[],
  ports: PipelinePorts,
  fetchedAt: string,
): Promise<Fact<number> | undefined> {
  if (ports.elevation === undefined) return undefined;

  let axisBearingDeg: number | null = null;
  for (const street of descriptions) {
    axisBearingDeg = deliveryAxisBearingDeg(at, street);
    if (axisBearingDeg !== null) break;
  }
  if (axisBearingDeg === null) return { known: false, why: 'no_data' };

  const sample = slopeSamplePoints(at, axisBearingDeg);
  try {
    const heights = await ports.elevation.getElevations([sample.from, sample.to]);
    const a = heights[0];
    const b = heights[1];
    if (a === undefined || b === undefined) return { known: false, why: 'no_data' };
    const pct = slopePctFromElevations(sample.from, sample.to, a.elevationMeters, b.elevationMeters);
    if (pct === null) return { known: false, why: 'no_data' };
    return {
      known: true,
      value: pct,
      provenance: { source: 'elevation', method: `${ports.elevation.source ?? 'elevation'}-delivery-axis`, fetchedAt },
      reliability: {
        confidence: 0.8,
        basis: 'measured',
        reasonCodes: ['slope_along_delivery_axis'],
      },
    };
  } catch (error) {
    return { known: false, why: error instanceof ElevationNoDataError ? 'no_data' : 'provider_error' };
  }
}

/**
 * Distance to the AXIS, not to the vertices. A straight village street is
 * drawn with two vertices 120 m apart: measured to vertices it sits 60 m from
 * a point on its own carriageway, and no sane snap distance would keep it.
 */
function nearestWay(
  ways: readonly RoadWay[],
  point: GeoPoint,
  maxDistanceM: number,
): RoadWay | null {
  let best: RoadWay | null = null;
  let bestD = maxDistanceM;
  for (const way of ways) {
    const d = closestPointOnPolyline(way.geometry, point)?.distanceM ?? Infinity;
    if (d < bestD) {
      bestD = d;
      best = way;
    }
  }
  return best;
}

/** the way a point was measured on, and who put it there: S0 weighs it by that. */
function declaredWayOf(input: AnalyseInput): DeclaredWay | undefined {
  return input.kind === 'point' ? input.onWay : undefined;
}

function requestedLabel(input: AnalyseInput): string {
  return input.kind === 'address' ? input.address : (input.label ?? 'point');
}

function normalise(address: string): string {
  return address
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}
