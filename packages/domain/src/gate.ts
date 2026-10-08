/**
 * S3 — the grey layer of the gate search (produit : l'« ancrage »).
 *
 * A gate — *ancre* in the product's vocabulary, see la note de conception interne —
 * is the point of the structuring network by which an itinerary enters or
 * leaves the neighbourhood. `findStructuringGates` keeps five of them and drops
 * everything else on the floor: the ways that were not structuring, the ones
 * whose vertices all sat too close or too far, and the ones whose best vertex
 * pointed at an azimuth an already-held gate had taken. None of that reached
 * `FullAnalysis`, so nobody could confirm the five kept were the best five —
 * only that they were the five the rule produced.
 *
 * Same shape as `StreetSearch` (S0) and for the same reason: a winner
 * alone is not an explanation.
 *
 * AGGREGATED BY WAY, never by vertex. Two kilometres of structuring network
 * carry thousands of vertices; one row each would be a megabyte of noise where
 * the question is which ROADS were looked at. One row per way, carrying the
 * vertex that mattered.
 */
import type { AxisSearch, UncontrolledApproach } from './axis.js';
import type { GeoPoint } from './geo.js';

/**
 * Where a way stood when the gate search ended.
 *
 * The order is the order of the funnel: the first two never get measured, the
 * third is measured and out of reach, the next two reached the selection and
 * lost it, the last won.
 */
export type ConsideredGateStage =
  /** A `highway` class no delivery vehicle can be on. Never measured. */
  | 'not_drivable'
  /** Drivable, but not part of the structuring network — a gate there is a second delivery street. */
  | 'not_structuring'
  /**
   * Structuring, but no vertex could become a gate: all of them sat beyond
   * `searchRadiusM`, or nearer than the floor a gate must clear — which is
   * `minReachM`, `minDistanceM` staying the floor of what the
   * study measures at all. `shortOfRing` names the ways that fell on the
   * second reason, so the two are never confused.
   */
  | 'no_vertex_in_range'
  /** Its best vertex pointed within `minSeparationDeg` of a gate already held — see `conflictsWith`. */
  | 'azimuth_conflict'
  /** Reached when the `gateCount` slots were already full: never compared to anything. */
  | 'slots_full'
  /** At least one of its vertices is a gate. */
  | 'retained';

export type ConsideredGateOutcome = 'retained' | 'rejected';

/**
 * une voie structurante dont aucun sommet ne porte jusqu'au cercle.
 *
 * Le pendant, côté R0, de `ApproachShortOfRing` : même règle (principe 7), même
 * mot, et le même nombre de policy. La différence est l'objet sur lequel elle
 * se lit — la découverte mesure le bout d'une jambe ROUTÉE, R0 mesure le sommet
 * d'où la jambe partirait, parce que pour R0 les deux sont le même point.
 *
 * Une ligne par voie, pas une par sommet : ce qu'un lecteur veut savoir est
 * quelle rue a été écartée et de combien il s'en est fallu, pas que le
 * boulevard avait quarante sommets trop près.
 */
export interface GateShortOfRing {
  readonly wayId: string;
  readonly name: string | null;
  /** Le meilleur sommet que la voie pouvait offrir : le plus lointain sous le seuil. */
  readonly at: GeoPoint;
  readonly azimuthDeg: number;
  /** Sa distance à l'arrêt, à vol d'oiseau — la portée de la jambe qui en serait partie. */
  readonly reachM: number;
}

/** One vertex of a way, as the selection saw it. */
export interface GateCandidatePoint {
  readonly at: GeoPoint;
  /** Bearing from the stop towards the vertex, degrees clockwise from north. */
  readonly azimuthDeg: number;
  readonly distanceM: number;
}

/** One way the gate search examined, and what became of it. */
export interface ConsideredGateWay {
  readonly wayId: string;
  readonly name: string | null;
  /** The raw OSM `highway` tag, so a reader can see what was filtered on its class. */
  readonly highway: string | null;
  /** BDTOPO importance class. Lower is more structuring; null on OSM ways. */
  readonly importance: number | null;
  /** The way's own line, as the source drew it. Referenced, never redrawn. */
  readonly geometry: readonly GeoPoint[];
  readonly vertexCount: number;
  /** Vertices between `minDistanceM` and `searchRadiusM` — the ones that became candidates. */
  readonly inRangeVertexCount: number;
  /**
   * Distance from the stop to the nearest / farthest vertex of the way,
   * measured over ALL its vertices, in range or not — that is what says
   * whether a `no_vertex_in_range` way sat too close or too far.
   *
   * Null when the way was filtered on its class and never measured: never
   * measured is not zero metres away.
   */
  readonly nearestDistanceM: number | null;
  readonly farthestDistanceM: number | null;
  /**
   * The in-range vertex the selection looked at first — the farthest one, since
   * the selection walks candidates by descending distance. The way's fate is
   * this vertex's fate, unless another of its vertices was retained later.
   *
   * Null when no vertex was in range.
   */
  readonly bestCandidate: GateCandidatePoint | null;
  readonly outcome: ConsideredGateOutcome;
  readonly stage: ConsideredGateStage;
  /**
   * For `azimuth_conflict`: the `wayId` of the gate already held that stood
   * within `minSeparationDeg` of `bestCandidate`. Null otherwise.
   *
   * It names a WAY, not a vertex: a ring road can hold two gates at once, and
   * then only one of them is the one that actually blocked. Read it as "this
   * road's gate took the direction", which is the sentence a reader wants.
   */
  readonly conflictsWith: string | null;
}

/** A gate that was kept, with the round of the greedy selection that kept it. */
export interface RetainedGate {
  readonly at: GeoPoint;
  readonly wayId: string;
  readonly azimuthDeg: number;
  readonly distanceM: number;
  /** 1 = the farthest candidate of the whole neighbourhood, then in selection order. */
  readonly rank: number;
}

/**
 * Everything S3 looked at to place the gates, and the thresholds it looked
 * with — the grey layer under the five gates.
 *
 * It exists to be drawn. the product owner's standing suspicion is that "farthest
 * first" does not find the best gates; this is the object that lets the claim
 * be checked rather than argued.
 */
export interface GateSearch {
  /** The stop: the origin of every distance and azimuth below. */
  readonly stop: GeoPoint;
  /** Radius the structuring network was fetched at — and the far edge of what counts as an approach. */
  readonly searchRadiusM: number;
  /**
   * Le PLANCHER EFFECTIF de la bande où une ancre peut se poser — celui que la
   * sélection a appliqué, c'est-à-dire le plus haut de `gates.minDistanceM` et
   * de `gates.minReachM`. C'est ce nombre que l'écran affiche.
   */
  readonly minDistanceM: number;
  /**
   * le cercle qu'une ancre doit atteindre pour entrer en concurrence
   * (`gates.minReachM`, principe 7).
   *
   * L'ancre EST le bout de la jambe : le routeur part d'elle et s'arrête à
   * l'arrêt. Un sommet posé à 600 m produit donc une jambe qui porte à 600 m,
   * exactement ce que la découverte écarte depuis et la règle ne peut
   * pas valoir pour un producteur de jambes et pas pour l'autre. Le même nombre
   * sert aux deux : c'est `Discovery.minReachM`, lu dans la même clé de policy.
   */
  readonly minReachM: number;
  readonly gateCount: number;
  /** `360 / gateCount / 2` — the angular floor between two kept gates. */
  readonly minSeparationDeg: number;
  /** The gates, in the order `findStructuringGates` returns them (by azimuth), each with its rank. */
  readonly retained: readonly RetainedGate[];
  /**
   * les voies écartées parce qu'aucun de leurs sommets n'atteint le
   * cercle, une ligne par voie : le meilleur sommet qu'elle pouvait offrir.
   *
   * Le pendant de `Discovery.shortOfRing`, même mot et même raison. Vide quand
   * l'anneau utile commence au plancher de l'étude ; jamais une absence de
   * mesure, toujours un compte.
   */
  readonly shortOfRing: readonly GateShortOfRing[];
  /** One entry per way of the fetched neighbourhood, in the order they were examined. */
  readonly considered: readonly ConsideredGateWay[];
  /**
   * The adaptive discovery run BESIDE this selection, in silence.
   *
   * Null when the policy leaves it off, and null on `findStructuringGates`'s
   * own output: the discovery needs a router, the gate selection is pure. The
   * pipeline is what fills it in, after the R0 candidates and without touching
   * one of them.
   */
  readonly discovery: Discovery | null;
  /**
   * L'ÉTAGE « AXES », calculé EN SILENCE à côté de cette sélection.
   *
   * Même posture que `discovery` juste au-dessus, et pour la même raison : il
   * demande la BD TOPO, la sélection R0 est pure. C'est le pipeline qui le
   * remplit, après, sans toucher une ancre. Null quand l'étage n'a pas tourné.
   */
  readonly axes: AxisSearch | null;
  /**
   * PRINCIPE 34 — LES APPROCHES QUE PERSONNE N'ÉTUDIERA, sur le fil.
   *
   * Une ligne par ancre SERVIE posée sous `minReachM`. Vide tant que l'étage
   * axes ne sert pas — le drapeau baissé, le fil de l’API ne change pas d'un
   * octet ; la place est prête pour le jour de l'activation, et c'est là que la
   * phrase « porte à 33 m : l'approche par cet axe d'importance 2 sur 1 967 m
   * ne sera pas étudiée » devra voyager jusqu'à l'opérateur, pas seulement
   * jusqu'à `/explain`.
   *
   * Ce n'est pas `shortOfRing` : celle-là liste ce qui a été ÉCARTÉ faute
   * d'atteindre le cercle, celle-ci liste ce qui a été RETENU quand même,
   * parce que le réseau structurant commence là (Décision produit).
   */
  readonly uncontrolledApproaches: readonly UncontrolledApproach[];
}

// ---------------------------------------------------------------------------
// Discovery: the adaptive search, computed IN SILENCE beside R0.
// ---------------------------------------------------------------------------

/**
 * One origin of one round: where a ray was made to start.
 *
 * `wayId` names the structuring way the origin sits on — rule B'' of
 * la note de conception interne: best class first, then farthest, in
 * the ray's sector. It is null when no structuring vertex stood in that
 * sector at all and the origin is simply the point at `radiusM` on the ray;
 * OSRM snaps it to whatever road is nearest, and saying `wayId: null` is how
 * a reader tells "chosen on the network" from "dropped on the circle".
 */
export interface DiscoveryOrigin {
  readonly at: GeoPoint;
  /** Bearing of the ray, degrees clockwise from north. */
  readonly azimuthDeg: number;
  readonly wayId: string | null;
}

/**
 * One round of the adaptive search — 4 rays, then 8 more, then 24 more.
 *
 * `rays` is what the round ASKED for; `origins` is what it actually routed,
 * which is smaller when two rounds resolve to the same origin. `legsRouted`
 * counts the paths the router returned (alternatives included), `legsKept`
 * the approaches this round added that no earlier leg had already found.
 */
export interface DiscoveryRound {
  readonly index: number;
  readonly rays: number;
  readonly origins: readonly DiscoveryOrigin[];
  readonly legsRouted: number;
  readonly legsKept: number;
  /** Origins the router did not answer for. Never fatal — a missing approach, counted. */
  readonly legsFailed: number;
  /**
   * The same three counts for the OUTBOUND legs of the round: the
   * round routes `stop → origin` for the very origins it routed `origin →
   * stop`, because entering and leaving are two independent choices.
   *
   * Kept apart rather than summed in: the two directions de-duplicate against
   * different tails and a single pair of numbers could not say which half a
   * router failure fell on.
   */
  readonly legsRoutedOut: number;
  readonly legsKeptOut: number;
  readonly legsFailedOut: number;
}

/**
 * One approach kept after de-duplication: a distinct way IN to the address.
 *
 * Two legs that share their last `windowM` metres are one approach, and the
 * first one met is the one kept — so `firstRound` is the earliest round at
 * which the adaptive search would have held this approach in hand.
 */
export interface DiscoveredApproach {
  readonly key: string;
  /**
   * Which way the truck travels on this leg. `in` is a way TO the
   * address, compared on its last metres; `out` is a way OUT of it, compared
   * on its first metres — the departure approach, the mirror of the arrival.
   */
  readonly direction: 'in' | 'out';
  readonly firstRound: number;
  /** Azimuth of the ray whose leg was kept — the direction the truck comes from. */
  readonly originAzimuthDeg: number;
  readonly distanceM: number;
  readonly durationS: number;
  /**
   * The kept leg's own line, as the router drew it. Referenced, never redrawn,
   * and only for the legs that were kept: the discarded ones are counted, not
   * carried.
   */
  readonly polyline: readonly GeoPoint[];
  /** The R0 inbound candidate that shares this approach, or null when R0 missed it. */
  readonly coveredByCandidateId: string | null;
  /**
   * the ways this approach crosses, from the delivery point outward,
   * with the width each one declares. TRUCK-AGNOSTIC, like every road fact.
   *
   * Null when the pass did not run on this approach (policy off, or beyond
   * `gates.byWidth.maxApproaches`). It exists so `gateByWidth` can be replayed
   * for another lorry WITHOUT a network call — the same seam
   * `reprojectTruck` rests on everywhere else: the road half is measured once,
   * the vehicle half is pure.
   */
  readonly widthProfile: readonly ApproachWidthRun[] | null;
  /**
   * where this approach's anchor falls when "safe" is a WIDTH.
   *
   * Null when the anchor by width was not computed at all: the policy leaves
   * it off, or the approach sat beyond `gates.byWidth.maxApproaches`. An
   * approach that WAS measured and found no anchor carries a `GateByWidth`
   * with `basis: 'none'` — "looked, found nothing" is not "did not look".
   */
  readonly gateByWidth: GateByWidth | null;
}

/**
 * One stretch of an approach on ONE way, measured from the delivery point
 * outward.
 *
 * Consecutive samples that snapped to the same way are fused: within a run the
 * road, its width and its class do not change, so the anchor can only ever sit
 * at a run's START — which is why fusing loses nothing and keeps the profile
 * a dozen rows per approach rather than a hundred.
 *
 * `wayId: null` is a stretch no drivable way was near enough to claim. It is
 * not a gap in the record; it IS the record — unknown road is road to control.
 */
export interface ApproachWidthRun {
  /** Distance along the approach, from the delivery point, where the run starts. */
  readonly fromM: number;
  readonly toM: number;
  /** The run's first sample — the point an anchor placed here would sit on. */
  readonly at: GeoPoint;
  readonly wayId: string | null;
  readonly wayName: string | null;
  readonly highway: string | null;
  readonly widthM: number | null;
  /** Where the width came from. Null when the way declares none at all. */
  readonly widthSource: 'bdtopo' | 'osm' | null;
  /** Whether the class alone would vouch for the road, when no width does. */
  readonly structuring: boolean;
}

/**
 * the anchor of one approach, placed on the measured width of the
 * road rather than on its OSM class.
 *
 * la note de conception interne: Le responsable produit settled that the safe
 * network is a width — the BD TOPO one, already grafted onto the corridors
 * since c4a5549 — and that the class is only the fallback where no width is
 * known. Walking the approach OUTWARD from the delivery point, the anchor is
 * the first point from which every way crossed, out to `radiusM`, is wide
 * enough for this lorry (or silent about its width but structuring). Between
 * that point and the delivery point lies the network S4 has to control;
 * beyond it, the road is generic.
 *
 * IN SILENCE. Nothing reads this to choose a gate, route a leg or decide a
 * verdict; 's A/B is what may one day promote it.
 */
export interface GateByWidth {
  /** The anchor itself. Null when none was found (`basis: 'none'`). */
  readonly point: GeoPoint | null;
  /** Bearing from the stop to the anchor — `gate:<wayId>@<azimuthDeg>` is its name. */
  readonly azimuthDeg: number | null;
  /** Distance from the delivery point ALONG the approach, not as the crow flies. */
  readonly distanceFromDeliveryM: number | null;
  readonly wayId: string | null;
  readonly wayName: string | null;
  readonly highway: string | null;
  /** Width of the anchor's own way. Null under the class fallback. */
  readonly widthM: number | null;
  readonly widthSource: GateByWidthSource;
  /**
   * The width this truck needs for the road to stop being a question —
   * `comfortableWidthM` in `@teneolog/projection`, the policy's own numbers.
   * Carried so a reader never has to guess which truck the anchor was placed
   * for.
   */
  readonly requiredWidthM: number;
  readonly basis: 'width' | 'class' | 'none';
  /**
   * The first way, walking out from the delivery point, whose MEASURED width
   * falls short. It is what pushed the anchor outward — or what says why
   * there is none. Null when nothing measured was ever too narrow.
   */
  readonly firstNarrowSegment: { readonly wayId: string; readonly widthM: number; readonly atM: number } | null;
  /** Closed vocabulary — see `GATE_BY_WIDTH_REASONS`. */
  readonly reason: string;
}

/**
 * Where the anchor's width came from.
 *
 * `osm` covers both a `width` tag and the lane-count estimate the corridor
 * annotation already credits (`annotate.ts`): both are OSM's word, neither is
 * measured. `class_fallback` means no width at all was known and the road's
 * class stood in. `unknown` belongs to `basis: 'none'` — no anchor, no width.
 */
export type GateByWidthSource = 'bdtopo' | 'osm' | 'class_fallback' | 'unknown';

/** Why the anchor fell where it did — the closed vocabulary of `reason`. */
export const GATE_BY_WIDTH_REASONS = [
  /** Every way from the delivery point outward is already wide enough: nothing to control. */
  'wide_from_the_delivery_point',
  /** Something too narrow (or unknown and local) stood closer in; the anchor is past it. */
  'first_wide_beyond_the_narrow',
  /** No width anywhere: the anchor sits where the class alone says "structuring". */
  'class_fallback',
  /** No point of the approach holds out to the edge — the whole approach is to be controlled. */
  'never_wide_enough',
  /** The approach carries no line to walk, or the corridor answered nothing. */
  'no_geometry',
] as const;

/**
 * une jambe routée dont le bout n'atteint pas le cercle de 2 km.
 *
 * Principe 7 : « l'ancre reste le point à 2 km ; toute l'approche est
 * contrôlée. » Une approche qui s'arrête à 604 m du point de livraison ne dit
 * pas comment le camion entre dans le bourg ou en ressort — elle dit seulement
 * qu'on a cessé de regarder. Au jury de Thairé (2026-09-12, défaut A) c'est
 * exactement cette jambe-là qui gagnait : `r3@250:alt1` s'arrêtait **juste
 * avant** le seul vrai giratoire de la sortie, et le classement la préférait
 * parce qu'elle portait un point de moins.
 *
 * Une telle jambe n'entre donc pas en concurrence. Elle n'est pas effacée pour
 * autant : elle est comptée ici, avec sa distance, et l'onglet Ancres la montre
 * — « n'atteint pas le cercle ». Ce qu'on ne contrôle pas est listé à l'écran,
 * jamais sauté en silence (principe 1).
 */
export interface ApproachShortOfRing {
  /** La clé qu'aurait portée l'approche : `r3@250:out:alt1`, la même nomenclature. */
  readonly key: string;
  readonly direction: 'in' | 'out';
  /** Distance du bout de la jambe au point de livraison, À VOL D'OISEAU. */
  readonly reachM: number;
  /** Distance routée de la jambe — ce que le routeur a effectivement tracé. */
  readonly routedDistanceM: number;
}

/** What the rule in production (R0) covers of what the search found. */
export interface DiscoveryCoverage {
  readonly approachesTotal: number;
  readonly coveredByR0: number;
  /** R0 inbound candidates whose approach is not one of the discovered ones. */
  readonly r0CandidatesUncovered: readonly string[];
}

/**
 * Where the adaptive search WOULD have stopped, measured on R0's pairs.
 *
 * In silence every round is played, so this is a counterfactual and says so:
 * `evaluatedOn: 'R0'` — the criterion was tested against the pairs the
 * production rule produced, not against the discovered approaches, which have
 * no corridor and no verdict yet ( will give them one).
 *
 * `reasons` names what stood between this run and a stop: the clauses of
 * `discovery.stopWhen` that failed and — when they all passed — why `atRound`
 * could still not be named.
 */
export interface DiscoveryStopCriterion {
  readonly evaluatedOn: 'R0';
  readonly satisfied: boolean;
  readonly atRound: number | null;
  readonly reasons: readonly string[];
}

/**
 * The budget the search was allowed, and what it used.
 *
 * `settingKind` — dense, urbain, bourg, périurbain, rural — is what will size
 * the budget. Null until the built environment is wired in; the
 * budget is the full round list meanwhile.
 */
export interface DiscoveryBudget {
  readonly maxRounds: number;
  readonly playedRounds: number;
  readonly settingKind: string | null;
}

export interface DiscoveryCost {
  /** Calls to the routing port, failures included. */
  readonly routingCalls: number;
  readonly durationMs: number;
}

/**
 * what placing the anchors by width cost, and on what it could.
 *
 * The corridor is the expensive half of S3 (0,8 s a leg, measured in
 * la note de conception interne), and this pass buys one per approach. The count
 * is published rather than estimated so the A/B argues on numbers.
 */
export interface DiscoveryByWidth {
  /** Approaches — ways in AND ways out — the anchor was actually computed for. */
  readonly computedFor: number;
  /** Approaches left out by `gates.byWidth.maxApproaches`. Counted, never silent. */
  readonly skipped: number;
  readonly cost: {
    /** Corridor fetches: one per measured approach, whatever the source behind the port. */
    readonly overpassCalls: number;
    /**
     * Corridor fetches the BD TOPO actually answered for — i.e. that came back
     * carrying at least one grafted width.
     *
     * The port says nothing about whether a donor was ASKED (the graft is a
     * wrapper, and a mute donor is indistinguishable from an absent one), so
     * this counts the answers, not the questions. It is a floor.
     */
    readonly bdtopoQueries: number;
    readonly ms: number;
  };
  /** Distinct ways loaded across every approach — the overlap near the stop, netted out. */
  readonly waysLoaded: number;
  /** Of those, how many carry a width grafted from the BD TOPO. */
  readonly waysWithBdtopoWidth: number;
  /** The width threshold every anchor was placed against, and the truck it belongs to. */
  readonly requiredWidthM: number;
  readonly truckId: string;
}

/**
 * The adaptive discovery, run beside R0 and changing nothing.
 *
 * la note de conception interne: rounds of routed rays, de-duplicated
 * by final approach, that would stop as soon as a pair is beyond doubt. Here
 * every round is played and nothing is acted on — the point is to measure what
 * R0 misses and where the criterion would have cut, before the A/B.
 */
export interface Discovery {
  /** Window over which two legs are compared to be called the same approach. */
  readonly windowM: number;
  /**
   * le cercle qu'une jambe doit atteindre, à vol d'oiseau, pour
   * entrer en concurrence. Porté ici pour la même raison que
   * `GateByWidth.requiredWidthM` : un lecteur ne doit jamais avoir à deviner le
   * seuil contre lequel une jambe a été écartée.
   */
  readonly minReachM: number;
  readonly rounds: readonly DiscoveryRound[];
  /** The ways IN, de-duplicated on their last `windowM` metres. */
  readonly approaches: readonly DiscoveredApproach[];
  /**
   * the ways OUT, de-duplicated on their FIRST `windowM` metres.
   *
   * Same shape and same measure as `approaches`, read from the other end: the
   * truck may enter by one anchor and leave by another, so a run that only
   * routed the ways in could not form a single plan the engine does not
   * already assume. `coveredByCandidateId` names the R0 OUT candidate that
   * departs the same way, never an inbound one.
   */
  readonly approachesOut: readonly DiscoveredApproach[];
  /**
   * les jambes routées qui n'atteignent pas le cercle, écartées.
   *
   * Dans les deux directions, dans l'ordre où la recherche les a rencontrées.
   * Vide quand toutes les jambes portent jusqu'au cercle ; ce n'est donc jamais
   * « on n'a pas regardé ».
   */
  readonly shortOfRing: readonly ApproachShortOfRing[];
  readonly coverageByR0: DiscoveryCoverage;
  readonly stopCriterion: DiscoveryStopCriterion;
  /** S2 said the stop is obvious: round 0 of §7.1, no search needed. */
  readonly obviousStop: boolean;
  readonly budget: DiscoveryBudget;
  readonly cost: DiscoveryCost;
  /**
   * the anchor-by-width pass, run over the approaches above.
   *
   * Null when `gates.byWidth.enabled` is false, and null on the discovery's
   * own output: placing an anchor by width needs a corridor, which the
   * discovery deliberately never fetches. The pipeline fills it in.
   */
  readonly byWidth: DiscoveryByWidth | null;
  /** The run's one instant — the same the R0 candidates carry. */
  readonly fetchedAt: string;
}
