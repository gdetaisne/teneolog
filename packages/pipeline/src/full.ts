/**
 * The whole analysis, S0 → S6, over injected ports — what an API endpoint
 * calls and what every harness reuses. One address, one truck, one policy.
 *
 * The expensive half (S0–S4) is truck-agnostic by construction; the caller
 * may keep `FullAnalysis.road` and re-run only `projectTruck` for another
 * vehicle — the replay the product's "tester un autre camion" rests on.
 */
import type {
  CommonTrunk,
  Discovery,
  Fact,
  GateSearch,
  GeoPoint,
  LegPriority,
  Phase2Plan,
  PointVerdict,
  RouteCandidate,
  SkippedLeg,
  TruckProfile,
} from '@teneolog/domain';
import { collectCriticalPoints, type CollectedPoints, type CollectPointsParams } from '@teneolog/points';
import { projectTruck, type Projection, type ProjectionPolicy } from '@teneolog/projection';
import { summariseConclusion, type ConclusionSummary } from '@teneolog/report';
import {
  buildRouteCandidatesWithCorridors,
  type AxisSourcePort,
  type AxisStageParams,
  candidateFromRoutedLeg,
  coverApproaches,
  discoverApproaches,
  discoveredLegId,
  findStructuringGatesWithSearch,
  mapWithConcurrency,
  orderLegsByCertainty,
  type BatchReport,
  type CorridorPort,
  type DedupOptions,
  type DiscoveryDraft,
  type RoutedLegShape,
  type RoutingPort,
  type WayTilePort,
} from '@teneolog/routes';
import type { GraftOptions, RoadNeighbourhood, RoadWay } from '@teneolog/topology';

import { analyseAddress, type AnalyseInput, type PipelineParams, type PipelinePorts, type S0S2Facts } from './analyse.js';
import { discoveryInputOf } from './discovery-input.js';
import { stopPointsInputOf } from './stop-points-input.js';
import { sealDiscovery } from './discovery-seal.js';
import { replaceGatesByWidth, withGatesByWidth } from './gate-by-width-stage.js';
import { gateSearchInputOf } from './gate-input.js';
import { runGateStage, sealAxes } from './gate-stage.js';
import { DEFAULT_GRAFT } from './graft-defaults.js';
import { analyseWithoutR0 } from './no-r0.js';
import { reprojectNoRouteTruck, validUntilFrom } from './no-route.js';
import { obviousStopOf, stopTurnaroundOf, type ObviousStopThresholds } from './obvious-stop.js';
import {
  DEFAULT_PHASE2,
  measureCommonTrunk,
  tiledCorridorFor,
  worstVerdictOf,
  type Phase2Params,
} from './phase2.js';
import { EMPTY_PROMOTION, promoteDiscoveredLegs } from './promotion.js';

export interface FullPorts extends PipelinePorts {
  readonly routing: RoutingPort;
  readonly corridor: CorridorPort;
  /** Arterials-only fetch for gate discovery; a full urban fetch times out. */
  readonly structuring: {
    fetchStructuring(centre: { lat: number; lon: number }, radiusM: number): Promise<RoadNeighbourhood>;
  };
  /**
   * la matière première du cache de voies par tuile, les deux
   * sources séparées. Optionnel : un appelant qui ne le fournit pas garde le
   * chemin d'avant, un corridor = une requête.
   */
  readonly corridorTiles?: WayTilePort | null;
  /**
   * Les tolérances de la greffe BD TOPO, rejouées par corridor sur les voies
   * du cache. Optionnel pour la même raison.
   */
  readonly graft?: GraftOptions | null;
  /** la BD TOPO par classe d'importance, pour l'étage axes. Absent : `no_source`. */
  readonly axes?: AxisSourcePort | null;
}

export interface FullParams {
  readonly pipeline: PipelineParams;
  readonly gates: {
    readonly searchRadiusM: number;
    readonly gateCount: number;
    readonly minDistanceM: number;
    /**
     * le cercle qu'une jambe doit atteindre pour entrer en
     * concurrence (principe 7). Lu par R0 (le sommet de l'ancre) ET par la
     * découverte (le bout de la jambe routée) : une seule source.
     */
    readonly minReachM: number;
    /**
     * l'ancre par largeur, EN SILENCE. Optionnelle : un appelant
     * écrit avant la tâche compile et ne paie rien, comme `projection.plans`.
     */
    readonly byWidth?: GateByWidthParams;
    /** l'étage axes, EN SILENCE. Absent : l'étage ne tourne pas du tout. */
    readonly axes?: AxisStageParams;
  };
  readonly candidates: {
    readonly alternativesPerGate: number;
    readonly corridorMarginM: number;
    readonly sampleStepM: number;
    readonly snapM: number;
    readonly approachWindowM: number;
    readonly laneWidthM: number;
    readonly minCorridorCoverage: number;
    readonly maxConcurrentFetches: number;
  };
  readonly points: CollectPointsParams;
  readonly projection: ProjectionPolicy;
  /**
   * the silent discovery. `enabled: false` and S3 is exactly what it
   * was; nothing below it reads any of these numbers.
   */
  readonly discovery: DiscoveryParams;
  /**
   * l'organisation de la phase 2 : la destination d'abord, l'ordre
   * des jambes, le cache de voies, et les deux drapeaux d'arrêt. Optionnelle :
   * un appelant écrit avant la tâche compile et prend `DEFAULT_PHASE2`, comme
   * `gates.byWidth`.
   */
  readonly phase2?: Phase2Params;
  /**
   * les règles d'ITINÉRAIRE portées de l'engine, en silence :
   * aujourd'hui le seul dédoublonnage des candidats R0. Optionnelle, comme
   * `phase2` : un appelant écrit avant la tâche compile et ne paie rien.
   */
  readonly routes?: RoutesParams;
  /** thresholds — read here only to record `Discovery.obviousStop`. */
  readonly obviousStop: Omit<ObviousStopThresholds, 'publishableConfidence'>;
  readonly policyVersion: string;
  readonly reportShelfLifeDays: number;
}

/**
 * ce que la policy dit de l'ancre par largeur, et rien de plus.
 *
 * Pas de seuil ici, volontairement : « large sans doute » est
 * `comfortableWidthM` (`@teneolog/projection`), c'est-à-dire la largeur du
 * camion, `projection.lateralClearanceM` et `projection.comfortMarginM`. En
 * poser un deuxième ferait deux définitions d'une route assez large.
 */
/**
 * `routes` en policy : ce que S3 fait des jambes qu'il vient de
 * router, avant de payer leurs corridors.
 */
export interface RoutesParams {
  readonly dedup: DedupOptions;
}

export interface GateByWidthParams {
  readonly enabled: boolean;
  /** Plafond d'approches mesurées — un corridor chacune, c'est le coût. */
  readonly maxApproaches: number;
}

export interface DiscoveryParams {
  readonly enabled: boolean;
  /** Rays per round, in order — `[4, 8, 24]`, the 36 rays of the reference. */
  readonly rounds: readonly number[];
  readonly radiusM: number;
  /** The tail over which two legs are called the same approach. */
  readonly windowM: number;
  readonly maxConcurrent: number;
  readonly stopWhen: { readonly minMarginM: number };
  /**
   * router les 36 rayons en une vague au lieu de trois tours en
   * série. Optionnel : absent, on garde les trois tours.
   */
  readonly singleWave?: boolean;
  /**
   * LES JAMBES DÉCOUVERTES DEVIENNENT DES CANDIDATS.
   *
   * À `false` (le défaut, et l'état de 61efed8), la découverte reste ce
   * qu'elle était : elle route des rayons, compte ce que R0 couvre, et rien en
   * aval ne la lit. À `true`, chaque approche que R0 ne couvre pas — entrante
   * ET sortante — reçoit son corridor, ses points de passage (S4) et son
   * verdict de jambe (S5), exactement comme un itinéraire de production, et
   * entre dans les plans.
   *
   * Optionnel, et séparé de `projection.conclusion.mode` à dessein : ce sont
   * deux moitiés d'activation, et le harnais doit pouvoir jouer l'une sans
   * l'autre pour savoir laquelle a changé quoi.
   */
  readonly feedsCandidates?: boolean;
}

export interface FullAnalysis {
  readonly facts: S0S2Facts;
  readonly candidates: Fact<readonly RouteCandidate[]>;
  readonly collected: CollectedPoints | null;
  readonly projection: Projection | null;
  readonly summary: ConclusionSummary | null;
  /**
   * every structuring way S3 examined to place the gates, and where
   * each one fell. Never persisted and never put on the l’API wire: it is
   * what `/explain` draws the grey layer from.
   *
   * Null when no search ever ran: a run rehydrated from disk (the snapshot
   * does not carry it) or any shell built without going through S3.
   */
  readonly gateSearch: GateSearch | null;
  /**
   * ce que la phase 2 a fait de son temps : le tronc commun, l'ordre
   * dans lequel les corridors sont partis, et ce qu'un arrêt aurait coupé.
   *
   * **Additif.** Drapeaux baissés, retirer ce champ rend un `FullAnalysis`
   * identique au bit près à celui d'avant la tâche — c'est ce que le test d'or
   * de `packages/pipeline` vérifie. Null quand la phase 2 n'a pas tourné.
   */
  readonly phase2: Phase2Plan | null;
}

export type FullOutcome =
  | { readonly ok: true; readonly analysis: FullAnalysis }
  | { readonly ok: false; readonly stage: string; readonly why: string };

export async function runFullAnalysis(
  input: AnalyseInput,
  truck: TruckProfile,
  ports: FullPorts,
  params: FullParams,
  now: () => string,
): Promise<FullOutcome> {
  // one run, one acquisition instant. The clock is read once here
  // and every fact of S0–S6 carries that same `fetchedAt` — architecture §7
  // asks that the same snapshot of facts yield the same verdict bit for bit,
  // which a run stamped at three different milliseconds cannot promise.
  const fetchedAt = now();
  const frozen = (): string => fetchedAt;
  const s0s2 = await analyseAddress(input, ports, params.pipeline, frozen);
  if (!s0s2.ok) return { ok: false, stage: s0s2.stage, why: s0s2.why };
  return continueFromFacts(s0s2.facts, truck, ports, params, frozen);
}

/**
 * S3 → S6 over already-established road facts — the split the progressive
 * job rests on: the caller answers with the S0–S2 deliverability card first,
 * then finishes the analysis behind the response.
 */
export async function continueFromFacts(
  facts: S0S2Facts,
  truck: TruckProfile,
  ports: FullPorts,
  params: FullParams,
  now: () => string,
): Promise<FullOutcome> {
  const stop = facts.anchor.point.known ? facts.anchor.point.value : null;
  if (stop === null) return { ok: false, stage: 'geocode', why: 'no_point' };

  // Read once: S3 candidates, S4 points and the report's validity all date
  // from the same instant. In the progressive job this half runs
  // later than S0–S2 and honestly carries its own, later, stamp.
  const fetchedAt = now();

  // R0 et l'étage axes, au même endroit (`gate-stage.ts`). Le
  // drapeau `gates.axes.enabled` décide laquelle des deux règles SERT.
  const { wide, gates, gateSearch: r0Search, pendingAxes } = await runGateStage(stop, ports, params);

  const stopTurnaround = stopTurnaroundOf(facts);

  // ── l'organisation de la phase 2 ────────────────────────────────
  const phase2 = params.phase2 ?? DEFAULT_PHASE2;
  const startedAt = Date.now();
  const tiles = tiledCorridorFor(
    ports.corridorTiles,
    phase2,
    ports.graft ?? DEFAULT_GRAFT,
    params.candidates.maxConcurrentFetches,
  );
  const corridorPort: CorridorPort = tiles ?? ports.corridor;

  // La destination d'abord : les derniers mètres appartiennent à toutes les
  // jambes, et les charger de front avant la première est ce qui fait que la
  // première ne paie pas pour les quinze autres. On n'attend pas : le cache
  // dédoublonne les tuiles en vol, donc une jambe qui arrive pendant le
  // préchargement s'y raccroche au lieu de le doubler.
  const preloaded =
    tiles === null
      ? Promise.resolve()
      : tiles.preloadAround(stop, phase2.destinationRadiusM).catch(() => undefined);

  let legOrder: readonly LegPriority[] = [];
  let commonTrunk: CommonTrunk | null = null;
  let skipReason: SkippedLeg['reason'] = 'not_needed';

  const { candidates, corridors, skipped, stoppedAfterBatch } = await buildRouteCandidatesWithCorridors(
    {
      stop,
      gates,
      stopTurnaround,
      ...candidatesInputOf(params),
      fetchedAt,
      orderLegs: (legs) => {
        legOrder = orderLegsByCertainty({
          legs,
          neighbourhood: wide,
          minTurnDeg: phase2.legOrder.minTurnDeg,
          minSegmentM: phase2.legOrder.minSegmentM,
          snapM: phase2.legOrder.snapM,
          batchSize: params.candidates.maxConcurrentFetches,
        });
        return legOrder.map((leg) => leg.id);
      },
      onRouted: async (legs) => {
        await preloaded;
        commonTrunk = await measureCommonTrunk(
          {
            stop,
            legs,
            topology: facts.topology.topology,
            terminalNodeInterior: facts.topology.terminalNodeInterior,
            stopFacts: facts.stop,
            truck,
            points: params.points,
            projection: params.projection,
            policyVersion: params.policyVersion,
            candidates: params.candidates,
            phase2,
            fetchedAt,
          },
          corridorPort,
        );
        // Le refus commun : un point que TOUTES les jambes traversent refuse ce
        // camion, donc toutes les jambes refusent. On garde la première paire
        // de l'ordre — il faut une jambe réelle pour que la conclusion ait un
        // itinéraire à nommer — et on renonce aux autres.
        if (!phase2.commonRefusalStops || commonTrunk === null || commonTrunk.worstVerdict !== 'NO') {
          return null;
        }
        skipReason = 'common_refusal';
        return firstPairOf(legs);
      },
      ...(phase2.stopBetweenBatches ? { onBatch: (built: BatchReport) => {
            const collected = collectCriticalPoints(
              { candidates: built.candidates, corridors: built.corridors, ...stopPointsInputOf(facts, fetchedAt) },
              params.points,
            );
            const partial = projectTruck({
              candidates: built.candidates,
              collected,
              truck,
              policy: params.projection,
              policyVersion: params.policyVersion,
              validUntil: fetchedAt,
              routerFailed: false,
              stopShape: {
                kind: facts.topology.topology.kind,
                turnaround: stopTurnaround,
                provenTopology: facts.topology.terminalNodeInterior,
              },
            });
            return planBeyondDoubt(partial, params.projection.comfortMarginM) ? 'stop' : 'continue';
          } }
        : {}),
    },
    { routing: ports.routing, corridor: corridorPort },
  );
  await preloaded;

  const phase2Plan: Phase2Plan = {
    commonTrunk,
    legOrder,
    skippedLegs: skipped.map((leg) => ({
      id: leg.id,
      direction: leg.direction,
      reason: skipReason,
      priority: legOrder.find((held) => held.id === leg.id)?.rank ?? 0,
    })),
    stopBetweenBatches: phase2.stopBetweenBatches,
    commonRefusalStops: phase2.commonRefusalStops,
    stoppedAfterBatch,
    // Relevé à la toute fin (`sealed`), pas ici : l'ancre par largeur tourne
    // après les candidats et consomme les mêmes tuiles. Un relevé pris ici
    // dirait que la moitié du partage n'a pas eu lieu.
    tiles: null,
    durationMs: 0,
  };

  /** Le compte rendu, scellé au moment de rendre — tuiles et mur compris. */
  const sealed = (): Phase2Plan => ({
    ...phase2Plan,
    tiles: tiles === null ? null : tiles.stats(),
    durationMs: Date.now() - startedAt,
  });

  // la découverte, EN SILENCE. Elle tourne APRÈS les candidats R0 et
  // ne touche ni `gates`, ni `candidates`, ni rien en aval : elle ne fait que
  // router des rayons et compter. Le test d'or (full-discovery.test.ts) en est
  // le juge, pas ce commentaire.
  const draft = params.discovery.enabled
    ? await discoverApproaches(discoveryInputOf(stop, wide, params, fetchedAt), ports.routing)
    : null;

  // l'ancre par LARGEUR, en silence elle aussi. Elle se pose sur les
  // approches que la découverte vient de garder : un corridor par approche, la
  // greffe BD TOPO comprise, et le point où la voie cesse d'être « large sans
  // doute » pour CE camion. Rien d'autre ne bouge — `gates`, `candidates`, les
  // verdicts, le classement et les plans sont identiques, et c'est le test d'or
  // (`full-gate-by-width.test.ts`) qui le juge, pas ce commentaire.
  const discovered =
    draft === null ? draft : await withGatesByWidth(draft, stop, truck, corridorPort, params, fetchedAt);

  // l'étage axes rejoint ICI : éteint, il n'a rien décidé (`gate-stage.ts`).
  const gateSearch = await sealAxes(r0Search, pendingAxes);

  const obviousStop = obviousStopOf(facts, truck, params);

  // AUCUNE ANCRE R0 N'EST PAS UNE FIN DE RUN. Les jambes
  // découvertes qui atteignent le cercle sont promues et jugées, et s'il ne
  // reste vraiment rien la conclusion porte son motif : `no-r0.ts`.
  if (!candidates.known) {
    const withoutR0 = await analyseWithoutR0({
      facts, truck, params, phase2, candidates, gateSearch, discovered, obviousStop,
      neighbourhood: wide, corridor: corridorPort, stopTurnaround, fetchedAt,
    });
    return { ok: true, analysis: { ...withoutR0, phase2: sealed() } };
  }

  // + CE QUE R0 NE COUVRE PAS DEVIENT UN CANDIDAT.
  //
  // La couverture se mesure ici, une fois, contre les candidats de R0 SEULS :
  // la mesurer après la promotion ferait couvrir chaque approche par le
  // candidat qu'elle vient elle-même de produire, et `coveredByR0` ne voudrait
  // plus rien dire. `measureAgainstR0` reçoit donc ce relevé plutôt que d'en
  // refaire un.
  const coverage = discovered === null ? null : coverDiscovery(discovered, candidates.value);
  const promoted =
    coverage === null || params.discovery.feedsCandidates !== true
      ? EMPTY_PROMOTION
      : await promoteDiscoveredLegs(coverage, wide, corridorPort, params, phase2, fetchedAt);
  const allCandidates = [...candidates.value, ...promoted.candidates];
  const allCorridors = new Map(corridors);
  for (const [id, ways] of promoted.corridors) allCorridors.set(id, ways);

  const collected = collectCriticalPoints(
    { candidates: allCandidates, corridors: allCorridors, ...stopPointsInputOf(facts, fetchedAt) },
    params.points,
  );

  const projection = projectTruck({
    candidates: allCandidates,
    collected,
    truck,
    policy: params.projection,
    policyVersion: params.policyVersion,
    validUntil: validUntilFrom(fetchedAt, params.reportShelfLifeDays),
    // une route perdue par le routeur ne doit jamais valoir un NO.
    routerFailed: candidates.reliability.reasonCodes.includes('some_gate_routes_failed'),
    // la forme de la rue à l'arrêt décide de la manœuvre entre les
    // deux jambes d'un plan. C'est la MÊME mesure que celle portée par
    // `egressOf.turnaround` — lue ici à sa source, S1.
    // et la preuve de la forme avec elle — un plan n'a le droit de
    // refuser le demi-tour que sur une impasse établie, comme le point.
    stopShape: {
      kind: facts.topology.topology.kind,
      turnaround: stopTurnaround,
      provenTopology: facts.topology.terminalNodeInterior,
    },
  });

  return {
    ok: true,
    analysis: {
      facts,
      candidates:
        promoted.candidates.length === 0
          ? candidates
          : { ...candidates, value: allCandidates },
      collected,
      projection,
      summary: summariseConclusion(projection.conclusion, truck.label),
      gateSearch:
        discovered === null || coverage === null
          ? gateSearch
          : {
              ...gateSearch,
              discovery: measureAgainstR0(
                discovered,
                coverage,
                allCandidates,
                projection,
                params,
                obviousStop,
              ),
            },
      phase2: sealed(),
    },
  };
}

/**
 * La première paire de l'ordre de certitude : la jambe entrante la mieux
 * classée et la sortante de la même ancre.
 *
 * Le refus commun a besoin d'une paire réelle — une conclusion doit pouvoir
 * nommer l'itinéraire par lequel elle refuse — et d'une seule : le tronc
 * commun est sur toutes, apprendre seize fois la même chose ne s'appelle pas
 * une mesure.
 */
function firstPairOf(legs: readonly RoutedLegShape[]): readonly string[] {
  const inbound = legs.find((leg) => leg.direction === 'in');
  if (inbound === undefined) return legs.slice(0, 1).map((leg) => leg.id);
  const gate = inbound.id.slice(0, inbound.id.indexOf(':'));
  const outbound = legs.find((leg) => leg.direction === 'out' && leg.id.startsWith(`${gate}:`));
  return outbound === undefined ? [inbound.id] : [inbound.id, outbound.id];
}

/**
 * « Sans raison de douter », sur les plans DÉJÀ contrôlés.
 *
 * Les trois clauses sont celles de la tâche : le meilleur plan est OK, sa pire
 * marge atteint la marge de confort, et il ne reste aucune question à poser à
 * un humain. Ce sont aussi trois des quatre clauses du critère d'arrêt du §7.1
 * de la note de conception interne — la quatrième, le corridor complet, est déjà dans
 * le verdict du plan.
 */
function planBeyondDoubt(projection: Projection, comfortMarginM: number): boolean {
  const best = projection.conclusion.plans[0];
  if (best === undefined) return false;
  return (
    best.verdict === 'OK' &&
    best.humanPointCount === 0 &&
    best.worstMarginM !== null &&
    best.worstMarginM >= comfortMarginM
  );
}

// ---------------------------------------------------------------------------
// les jambes découvertes deviennent des itinéraires de production
// ---------------------------------------------------------------------------

/**
 * Ce que R0 couvre, relevé UNE FOIS — avant toute promotion.
 *
 * L'ordre compte plus qu'il n'en a l'air : une approche promue devient un
 * candidat, et un candidat couvre l'approche dont il est né. Mesurer la
 * couverture après la promotion rendrait donc `coveredByR0` systématiquement
 * total, et la seule question à laquelle la découverte répond — « que la règle
 * actuelle ne trouve-t-elle pas ? » — n'aurait plus de réponse.
 */
export interface DiscoveryCoverage {
  readonly approaches: Discovery['approaches'];
  readonly approachesOut: Discovery['approachesOut'];
  readonly coverage: Discovery['coverageByR0'];
  readonly approachOfCandidate: ReadonlyMap<string, Discovery['approaches'][number]>;
}

function coverDiscovery(
  draft: DiscoveryDraft,
  r0: readonly RouteCandidate[],
): DiscoveryCoverage {
  const { approaches, coverage, approachOfCandidate } = coverApproaches(
    draft.approaches,
    r0.filter((c) => c.direction === 'in').map(({ id, polyline }) => ({ id, polyline })),
    draft.windowM,
  );
  // les sorties se joignent aux sorties de R0, sur leurs PREMIERS
  // mètres. La couverture publiée (`coverageByR0`) reste celle des entrées :
  // c'est elle que le critère d'arrêt et l'A/B lisent, et lui ajouter les
  // sorties changerait un compte déjà servi.
  const { approaches: approachesOut } = coverApproaches(
    draft.approachesOut,
    r0.filter((c) => c.direction === 'out').map(({ id, polyline }) => ({ id, polyline })),
    draft.windowM,
    'out',
  );
  return { approaches, approachesOut, coverage, approachOfCandidate };
}

/**
 * les réglages des candidats, plus ce que `routes` dit du
 * dédoublonnage.
 *
 * Une seule entrée : c'est `buildRouteCandidatesWithCorridors` qui écarte un
 * doublon, et il doit pouvoir le faire AVANT que le corridor parte.
 */
function candidatesInputOf(
  params: FullParams,
): FullParams['candidates'] & { readonly dedup?: DedupOptions } {
  const dedup = params.routes?.dedup;
  return dedup === undefined ? params.candidates : { ...params.candidates, dedup };
}

/** Les itinéraires que la règle actuelle a produits — sans les jambes promues. */
function r0Only(candidates: readonly RouteCandidate[]): readonly RouteCandidate[] {
  return candidates.filter((candidate) => candidate.generatedBy !== 'discovered');
}

// ---------------------------------------------------------------------------
// ce que R0 couvre, et où le critère d'arrêt aurait coupé
// ---------------------------------------------------------------------------

/**
 * Le critère d'arrêt de la note de conception interne, joué sur les paires de R0.
 *
 * « Sans raison de douter » : une paire au verdict OK, aucun point HUMAIN
 * retenu, la pire marge mesurée au-dessus de la marge de confort, et un
 * corridor complet des deux côtés. Les quatre clauses sont testées sur la
 * MEILLEURE paire — celle que le moteur a retenue — parce que c'est elle qui
 * répond pour l'adresse ; `reasons` nomme celles qui ont manqué.
 *
 * `atRound` est un contrefactuel assumé, et il se lit ainsi :
 *   - `0` quand l'arrêt est évident (tour 0 du §7.1 : pas de recherche du tout) ;
 *   - `null` quand le critère n'est pas satisfait — aucun tour n'aurait coupé,
 *     et c'est bien pour ça qu'on joue tous les tours en silence ;
 *   - sinon, le `firstRound` de l'approche que la jambe entrante gagnante
 *     partage : c'est le premier tour où la recherche adaptative aurait eu
 *     CETTE approche en main, donc le premier où elle aurait pu conclure. Si
 *     la découverte n'a jamais trouvé cette approche-là, `atRound` reste
 *     `null` avec `winning_approach_not_discovered` : la recherche n'aurait pas
 *     coupé plus tôt, elle aurait cherché ailleurs.
 */
function measureAgainstR0(
  draft: DiscoveryDraft,
  covered: DiscoveryCoverage,
  candidates: readonly RouteCandidate[],
  projection: Projection,
  params: FullParams,
  obviousStop: boolean,
): Discovery {
  const { approaches, coverage, approachOfCandidate, approachesOut } = covered;

  const { conclusion } = projection;
  const outbound = candidates.find((candidate) => candidate.id === conclusion.viaCandidateId) ?? null;
  // l'entrante retenue se lit sur le PLAN quand un plan décide :
  // `egressOf` n'apparie que la même ancre, et le plan retenu peut entrer par
  // une autre. Le repli reste `egressOf`, qui est la règle en mode `pairs`.
  const inboundId = conclusion.retainedPlan?.inboundId ?? outbound?.egressOf?.inboundId ?? null;
  const byRef = new Map<string, PointVerdict>(
    projection.pointVerdicts.map((verdict) => [verdict.pointRef, verdict]),
  );
  const retained = conclusion.retainedPointRefs.flatMap((ref) => {
    const verdict = byRef.get(ref);
    return verdict === undefined ? [] : [verdict];
  });

  const reasons: string[] = [];
  if (conclusion.overall !== 'OK') reasons.push('no_pair_ok');
  if (retained.some((verdict) => verdict.verdict === 'HUMAN')) reasons.push('human_point_on_pair');

  const margins = retained
    .map((verdict) => verdict.marginM)
    .filter((marginM): marginM is number => marginM !== null);
  if (margins.length === 0) {
    // Aucune marge mesurée n'est un silence, pas une marge nulle : la clause
    // ne peut ni passer ni tomber, et elle le dit.
    reasons.push('no_measured_margin');
  } else if (Math.min(...margins) < params.discovery.stopWhen.minMarginM) {
    reasons.push('margin_below_min');
  }

  const pairLegs = [outbound, candidates.find((leg) => leg.id === inboundId) ?? null];
  if (pairLegs.some((leg) => leg?.corridorReasonCodes.includes('corridor_partial') === true)) {
    reasons.push('corridor_partial_on_pair');
  }
  if (outbound === null || inboundId === null) reasons.push('no_pair_retained');

  const satisfied = reasons.length === 0;
  const winning = inboundId === null ? undefined : approachOfCandidate.get(inboundId);
  if (satisfied && winning === undefined) reasons.push('winning_approach_not_discovered');

  return sealDiscovery(draft, {
    approaches,
    approachesOut,
    coverage,
    stopCriterion: {
      evaluatedOn: 'R0',
      satisfied,
      atRound: obviousStop ? 0 : satisfied && winning !== undefined ? winning.firstRound : null,
      reasons,
    },
    obviousStop,
  });
}

/** Re-project another truck over an analysis whose road half is kept. */
export function reprojectTruck(
  analysis: FullAnalysis,
  truck: TruckProfile,
  params: FullParams,
  now: () => string,
): FullAnalysis {
  // sans ancre R0, `collected` est nul : le garde-fou de portée se
  // rejoue pour CE camion (`reprojectNoRouteTruck`), au lieu de rendre
  // `analysis` telle quelle et de réciter le premier camion trois fois.
  if (!analysis.candidates.known) return reprojectNoRouteTruck(analysis, truck, params, now);
  if (analysis.collected === null) return analysis;
  const projection = projectTruck({
    candidates: analysis.candidates.value,
    collected: analysis.collected,
    truck,
    policy: params.projection,
    policyVersion: params.policyVersion,
    validUntil: validUntilFrom(now(), params.reportShelfLifeDays),
    routerFailed: analysis.candidates.reliability.reasonCodes.includes('some_gate_routes_failed'),
    // la forme de la rue ne dépend pas du camion — la faisabilité du
    // demi-tour, si. Rejouer la projection rejoue donc les plans, sur la même
    // mesure et pour le nouveau gabarit.
    stopShape: {
      kind: analysis.facts.topology.topology.kind,
      turnaround: stopTurnaroundOf(analysis.facts),
      provenTopology: analysis.facts.topology.terminalNodeInterior,
    },
  });
  // la découverte est gardée telle quelle : ses tours, ses origines
  // et ses approches ne dépendent pas du camion, et rien n'est rerouté. Mais
  // le critère d'arrêt et l'arrêt évident, eux, EN dépendent : les garder tels
  // quels ferait dire à la vue « le tour 1 aurait suffi » pour un 44 t sur la
  // mesure d'un 19 t. On les rejoue, sans réseau.
  //
  // et les ancres par largeur avec eux, pour exactement la même
  // raison : le seuil est celui du camion. Le profil des voies, lui, est un
  // fait de la route et ne se remesure pas — c'est le même partage que
  // `projectTruck`, qui rejoue un verdict sur des faits déjà établis.
  const gateSearch =
    analysis.gateSearch === null || analysis.gateSearch.discovery === null
      ? analysis.gateSearch
      : {
          ...analysis.gateSearch,
          discovery: (() => {
            const replayed = replaceGatesByWidth(
              analysis.gateSearch.discovery,
              analysis.gateSearch.stop,
              truck,
              params,
            );
            // la couverture se remesure contre R0 SEUL. Les jambes
            // promues sont nées des approches ; les laisser couvrir leur propre
            // mère rendrait `coveredByR0` total et muet.
            return measureAgainstR0(
              replayed,
              coverDiscovery(replayed, r0Only(analysis.candidates.value)),
              analysis.candidates.value,
              projection,
              params,
              obviousStopOf(analysis.facts, truck, params),
            );
          })(),
        };
  // le tronc commun ne dépend pas du camion, son VERDICT si : c'est
  // le même partage que `projectTruck` et que les ancres par largeur. Les
  // points sont gardés tels quels et rejugés, sans réseau.
  const phase2 =
    analysis.phase2 === null || analysis.phase2.commonTrunk === null
      ? analysis.phase2
      : {
          ...analysis.phase2,
          commonTrunk: {
            ...analysis.phase2.commonTrunk,
            worstVerdict: worstVerdictOf(
              analysis.phase2.commonTrunk.points,
              truck,
              params.projection,
              params.policyVersion,
              now(),
            ),
          },
        };
  return {
    ...analysis,
    projection,
    summary: summariseConclusion(projection.conclusion, truck.label),
    gateSearch,
    phase2,
  };
}

// `stopTurnaroundOf` et `obviousStopOf` ont déménagé
// dans `obvious-stop.ts` : deux fonctions pures des seuls faits/camion/policy,
// sans rien lire d'autre dans ce fichier, et déjà appelées d'ici ET de
// `reprojectTruck` ci-dessus — le meilleur candidat pour faire baisser un
// fichier gelé (principe 26) au lieu de le faire grossir davantage.
