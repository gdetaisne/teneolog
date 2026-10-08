/**
 * S3 — the adaptive discovery of approaches, run IN SILENCE.
 *
 * la note de conception interne and §7.1. The production rule (R0)
 * picks five gates on a circle and routes them. This module does the opposite
 * and measures whether it was worth it: it ROUTES FIRST — rounds of rays whose
 * origins sit on the structuring network — then calls two legs that share
 * their last metres ONE approach.
 *
 * Three things it is not, and must never become:
 *
 *  - it is not a gate rule. Nothing here returns a `Gate`, nothing here reaches
 *    `buildRouteCandidates`. The caller runs it beside R0 and keeps both.
 *  - it fetches no corridor. OSRM and nothing else: the corridor is the
 *    expensive half (0.8 s a leg, measured) and the silent run must cost a
 *    fraction of a second, not a second a leg.
 *  - it never fails a run. A router that does not answer costs one approach,
 *    counted in `legsFailed`, and the discovery returns what it has.
 *
 * The measure of "same approach" is the prototype's, ported verbatim in
 * behaviour (`packages/routes/scripts/ancres-regles.ts`: `lastMetres`,
 * `sampleEvery`, `sharedFraction`): sample the last `windowM` metres every
 * `SAMPLE_STEP_M`, and call two legs the same when each covers the other at
 * `SAME_APPROACH_RATIO` within `SNAP_TOLERANCE_M`. Both directions, because
 * a short leg is trivially covered by a long one.
 *
 * every round routes its origins TWICE: `origin → stop` and
 * `stop → origin`. Entering and leaving are two independent choices
 * (la note de conception interne), and a search that only routed the ways in
 * could not contradict the assumption it exists to test. The ways out are
 * de-duplicated on their FIRST `windowM` metres — the departure approach,
 * measured from the stop, the mirror of the arrival — and kept in their own
 * list. The cost is at most doubled and still buys no corridor.
 */
import type {
  ApproachShortOfRing,
  Discovery,
  DiscoveredApproach,
  DiscoveryCoverage,
  DiscoveryOrigin,
  DiscoveryRound,
  GeoPoint,
} from '@teneolog/domain';
import {
  bearingDeg,
  closestPointOnPolyline,
  haversineM,
  isDrivableWay,
  offsetPoint,
  type RoadNeighbourhood,
  type RoadWay,
} from '@teneolog/topology';

import { mapWithConcurrency } from './concurrency.js';
import { isStructuringWay } from './gates.js';
import type { RoutedPath, RoutingPort } from './ports.js';

/** Step at which a leg's tail is sampled before being compared. */
export const SAMPLE_STEP_M = 10;
/** A sample this close to the other leg's line counts as the same road. */
const SNAP_TOLERANCE_M = 15;
/** Each leg must cover the other at least this much to be the same approach. */
const SAME_APPROACH_RATIO = 0.8;

export interface DiscoveryInput {
  readonly stop: GeoPoint;
  /** The same structuring fetch R0 chose its gates in — one fetch, two rules. */
  readonly neighbourhood: RoadNeighbourhood;
  /** Rays per round, in order. `[4, 8, 24]` = the 36 rays of the reference. */
  readonly rounds: readonly number[];
  /** How far from the stop an origin may sit. */
  readonly radiusM: number;
  /** And how near: R0's own floor, so both rules start outside the same circle. */
  readonly minDistanceM: number;
  /**
   * combien de mètres, À VOL D'OISEAU, le bout d'une jambe doit
   * atteindre pour que la jambe entre en concurrence (principe 7).
   *
   * L'origine d'un rayon est choisie entre `minDistanceM` et `radiusM`, mais
   * c'est un SOMMET DU RÉSEAU, pas un point du cercle : dans un bourg, le
   * sommet structurant le mieux classé d'un secteur peut se trouver à 600 m. La
   * jambe routée jusque-là ne dit alors rien de la façon d'entrer dans le bourg
   * ni d'en sortir — et au jury de Thairé c'est elle qui gagnait, parce qu'elle
   * s'arrêtait juste avant la difficulté (défaut A).
   */
  readonly minReachM: number;
  /** The tail over which two legs are compared. */
  readonly windowM: number;
  /** Alternatives asked of the router per ray — the policy's own number. */
  readonly alternatives: number;
  readonly maxConcurrent: number;
  /**
   * router les tours en UNE vague au lieu de trois en série.
   *
   * Les tours existent pour qu'une recherche adaptative puisse s'arrêter entre
   * deux ; tant que rien ne s'arrête (le critère d'arrêt est mesuré après
   * coup, jamais appliqué — §5 de l'A/B : il n'a coupé sur aucune des huit
   * adresses), les jouer en série fait attendre six barrières pour rien : trois
   * tours × deux directions. À `true`, les origines de TOUS les tours sont
   * calculées d'abord — elles ne dépendent que de la géométrie — puis routées
   * dans une seule fenêtre de concurrence, et repliées tour par tour dans le
   * MÊME ordre qu'avant. Les clés, les `firstRound` et les comptes par tour
   * sont identiques ; seul le mur change.
   *
   * À `false` dès que la découverte s'arrêtera vraiment entre deux tours.
   */
  readonly singleWave?: boolean;
  /** The run's one instant. */
  readonly fetchedAt: string;
}

/** An approach before the caller has said whether R0 covers it. */
export type DraftApproach = Omit<DiscoveredApproach, 'coveredByCandidateId'>;

/**
 * What this module can say on its own.
 *
 * `coverageByR0` and `stopCriterion` need the R0 candidates and the projected
 * verdicts, which belong to the pipeline; `obviousStop` needs S2. They are
 * filled in downstream — this module measures geometry, never verdicts.
 */
export interface DiscoveryDraft
  extends Omit<
    Discovery,
    'approaches' | 'approachesOut' | 'coverageByR0' | 'stopCriterion' | 'obviousStop'
  > {
  readonly approaches: readonly DraftApproach[];
  /** the ways out, same measure read from the stop. */
  readonly approachesOut: readonly DraftApproach[];
  /** les jambes écartées parce qu'elles n'atteignent pas le cercle. */
  readonly shortOfRing: readonly ApproachShortOfRing[];
}

/**
 * Play every round and return the distinct approaches found.
 *
 * In silence, every round is played: the point is to measure what the later
 * rounds would have added, which an early stop would hide. The adaptive stop
 * is decided by the caller, on `stopCriterion`.
 */
export async function discoverApproaches(
  input: DiscoveryInput,
  routing: RoutingPort,
): Promise<DiscoveryDraft> {
  const startedAt = Date.now();
  const vertices = structuringVertices(input);

  const rounds: DiscoveryRound[] = [];
  /** One accumulator per direction: same rule, two tails, two lists. */
  const inbound = newDirection('in');
  const outbound = newDirection('out');

  const plan = planRounds(input, vertices);

  const { answered, routingCalls } = await routeAllRays(input, plan, routing);

  // Le repli reste tour par tour et direction par direction, dans l'ordre des
  // origines : « le premier rencontré gagne » ne doit pas dépendre de l'ordre
  // dans lequel le routeur a répondu.
  for (const { roundIndex, rays, origins } of plan) {
    const legsOf = (direction: 'in' | 'out'): readonly RoutedLeg[] =>
      origins.map(
        (origin) =>
          answered.get(`${roundIndex}:${direction}:${pointKey(origin.at)}`) ?? {
            origin,
            paths: [] as readonly RoutedPath[],
            failed: true,
          },
      );
    const reach: ReachRule = { stop: input.stop, minReachM: input.minReachM };
    const inCounts = keepLegs(inbound, legsOf('in'), roundIndex, input.windowM, reach);
    const outCounts = keepLegs(outbound, legsOf('out'), roundIndex, input.windowM, reach);

    rounds.push({
      index: roundIndex,
      rays,
      origins,
      legsRouted: inCounts.routed,
      legsKept: inCounts.kept,
      legsFailed: inCounts.failed,
      legsRoutedOut: outCounts.routed,
      legsKeptOut: outCounts.kept,
      legsFailedOut: outCounts.failed,
    });
  }

  return {
    windowM: input.windowM,
    minReachM: input.minReachM,
    rounds,
    approaches: inbound.approaches,
    approachesOut: outbound.approaches,
    // Les entrantes puis les sortantes, dans l'ordre des tours : la liste se lit
    // comme le tableau du jury, une ligne par jambe écartée.
    shortOfRing: [...inbound.shortOfRing, ...outbound.shortOfRing],
    budget: {
      maxRounds: input.rounds.length,
      playedRounds: rounds.length,
      // will size the budget on the built environment; until it does,
      // the budget is the whole round list and the setting is unknown — which
      // is not the same as "rural".
      settingKind: null,
    },
    cost: { routingCalls, durationMs: Date.now() - startedAt },
    // même raison : la mesure par largeur appartient au pipeline.
    byWidth: null,
    fetchedAt: input.fetchedAt,
  };
}

/** Un appel au routeur : quel tour, quel sens, quelle origine. */
interface RayCall {
  readonly round: number;
  readonly direction: 'in' | 'out';
  readonly origin: DiscoveryOrigin;
}

/** Où une réponse se range : `<tour>:<sens>:<origine>`. */
function slotKeyOf(call: RayCall): string {
  return `${call.round}:${call.direction}:${pointKey(call.origin.at)}`;
}

/**
 * Router tous les rayons, et rendre les réponses rangées par créneau.
 *
 * Les deux directions sont routées sur les MÊMES origines : le §7.2 dit
 * qu'entrer et sortir sont deux choix indépendants, et les router à un tour
 * d'écart ferait dépendre le second de ce que le premier a trouvé.
 *
 * Sorti de `discoverApproaches` parce que la fonction dépassait la
 * borne du cliquet (principe 26). La coupure est celle du sujet : ici on parle
 * au routeur, là-bas on replie ce qu'il a dit.
 */
async function routeAllRays(
  input: DiscoveryInput,
  plan: readonly { readonly roundIndex: number; readonly origins: readonly DiscoveryOrigin[] }[],
  routing: RoutingPort,
): Promise<{ readonly answered: ReadonlyMap<string, RoutedLeg>; readonly routingCalls: number }> {
  const calls: RayCall[] = [];
  for (const { roundIndex, origins } of plan) {
    for (const direction of ['in', 'out'] as const) {
      for (const origin of origins) calls.push({ round: roundIndex, direction, origin });
    }
  }

  const answered = new Map<string, RoutedLeg>();
  let routingCalls = 0;
  const runCalls = async (subset: readonly RayCall[]): Promise<void> => {
    const results = await mapWithConcurrency(subset, input.maxConcurrent, async (call): Promise<RoutedLeg> => {
      try {
        const paths =
          call.direction === 'in'
            ? await routing.route(call.origin.at, input.stop, input.alternatives)
            : await routing.route(input.stop, call.origin.at, input.alternatives);
        return { origin: call.origin, paths, failed: false };
      } catch {
        // A router that does not answer costs one approach, never the run.
        return { origin: call.origin, paths: [] as readonly RoutedPath[], failed: true };
      }
    });
    subset.forEach((call, i) => answered.set(slotKeyOf(call), results[i] as RoutedLeg));
    routingCalls += subset.length;
  };

  if (input.singleWave === true) {
    await runCalls(calls);
  } else {
    for (const { roundIndex } of plan) {
      await runCalls(calls.filter((call) => call.round === roundIndex && call.direction === 'in'));
      await runCalls(calls.filter((call) => call.round === roundIndex && call.direction === 'out'));
    }
  }
  return { answered, routingCalls };
}

// ------------------------------------------------------- one round, one way --

/** One routed leg of a round, or the origin the router stayed silent on. */
interface RoutedLeg {
  readonly origin: DiscoveryOrigin;
  readonly paths: readonly RoutedPath[];
  readonly failed: boolean;
}

/** What one direction of the search has kept so far. */
interface DirectionState {
  readonly direction: 'in' | 'out';
  readonly approaches: DraftApproach[];
  /** Tails already kept, one per approach — the comparison set, sampled once. */
  readonly keptTails: { readonly tail: readonly GeoPoint[]; readonly samples: readonly GeoPoint[] }[];
  /** les jambes de cette direction qui n'ont pas atteint le cercle. */
  readonly shortOfRing: ApproachShortOfRing[];
}

function newDirection(direction: 'in' | 'out'): DirectionState {
  return { direction, approaches: [], keptTails: [], shortOfRing: [] };
}

/** Ce qu'il faut du run pour juger si une jambe porte jusqu'au cercle. */
interface ReachRule {
  readonly stop: GeoPoint;
  readonly minReachM: number;
}

/**
 * JUSQU'OÙ PORTE UNE JAMBE : la distance à vol d'oiseau entre l'arrêt et le
 * bout de la jambe, à l'opposé de l'arrêt.
 *
 * Une entrante va de l'origine vers l'arrêt : son bout est son PREMIER sommet.
 * Une sortante part de l'arrêt : son bout est le DERNIER. C'est dans les deux
 * cas l'origine du rayon telle que le routeur l'a accrochée au réseau — jamais
 * le point théorique qu'on lui avait demandé.
 *
 * Exporté pour que le test d'acceptation de Thairé mesure les
 * approches du run du jury avec CETTE fonction, et non avec une deuxième
 * arithmétique écrite dans le test — qui prouverait seulement que le test sait
 * faire un haversine.
 */
export function approachReachM(
  stop: GeoPoint,
  polyline: readonly GeoPoint[],
  direction: 'in' | 'out',
): number {
  const far = (direction === 'in' ? polyline[0] : polyline[polyline.length - 1]) as GeoPoint;
  return haversineM(stop, far);
}

/**
 * Les origines de tous les tours, calculées avant le moindre appel au routeur.
 *
 * Sorti de `discoverApproaches` : elles ne dépendent QUE de la
 * géométrie du voisinage, jamais de ce qu'un tour précédent a routé, et c'est
 * cette indépendance qui permet de router en une seule vague sans rien changer
 * à ce qui est trouvé. L'avoir à part le dit mieux qu'un commentaire.
 */
function planRounds(
  input: DiscoveryInput,
  vertices: readonly Vertex[],
): readonly { readonly roundIndex: number; readonly rays: number; readonly origins: DiscoveryOrigin[] }[] {
  const usedAzimuths: number[] = [];
  const usedOrigins = new Set<string>();
  const plan: { readonly roundIndex: number; readonly rays: number; readonly origins: DiscoveryOrigin[] }[] = [];
  for (const [index, rays] of input.rounds.entries()) {
    const roundIndex = index + 1;
    const origins: DiscoveryOrigin[] = [];
    for (const azimuthDeg of azimuthsOf(rays, roundIndex, input.rounds.length, usedAzimuths)) {
      usedAzimuths.push(azimuthDeg);
      const origin = originFor(input, vertices, azimuthDeg, rays);
      // Two rounds may resolve to the same summit; routing it twice would buy
      // nothing and cost a call. The ray is recorded in `rays`, not in `origins`.
      const key = pointKey(origin.at);
      if (usedOrigins.has(key)) continue;
      usedOrigins.add(key);
      origins.push(origin);
    }
    plan.push({ roundIndex, rays, origins });
  }
  return plan;
}

/**
 * Fold one round's legs into the approaches of ONE direction.
 *
 * The tail compared is the end of the journey in both cases, which for an
 * outbound leg is its beginning: `stop → origin` reversed is `origin → stop`,
 * and reversing is how the departure approach is measured with the arrival's
 * own rule rather than a second one written for the occasion.
 *
 * UNE JAMBE TROP COURTE EST ÉCARTÉE AVANT LE DÉDOUBLONNAGE, et cet
 * ordre est la règle, pas un détail : une jambe de 887 m couvre les derniers
 * mètres de toutes celles qui arrivent par le même côté, donc la garder dans
 * l'ensemble de comparaison lui laisserait effacer l'approche complète qui la
 * prolonge. C'est la moitié cachée du défaut A du jury — non seulement la
 * jambe tronquée gagnait, mais elle empêchait la vraie de se former.
 */
function keepLegs(
  state: DirectionState,
  legs: readonly RoutedLeg[],
  roundIndex: number,
  windowM: number,
  reach: ReachRule,
): { routed: number; kept: number; failed: number } {
  let routed = 0;
  let kept = 0;
  let failed = 0;
  for (const leg of legs) {
    if (leg.failed) {
      failed += 1;
      continue;
    }
    for (const [alt, path] of leg.paths.entries()) {
      if (path.polyline.length < 2) continue;
      routed += 1;
      const key = `r${roundIndex}@${padAzimuth(leg.origin.azimuthDeg)}${state.direction === 'in' ? '' : ':out'}${alt === 0 ? '' : `:alt${alt}`}`;
      const reachM = approachReachM(reach.stop, path.polyline, state.direction);
      if (reachM < reach.minReachM) {
        state.shortOfRing.push({
          key,
          direction: state.direction,
          reachM,
          routedDistanceM: path.distanceM,
        });
        continue;
      }
      const tail =
        state.direction === 'in'
          ? lastMetres(path.polyline, windowM)
          : lastMetres([...path.polyline].reverse(), windowM);
      const samples = sampleEvery(tail, SAMPLE_STEP_M);
      // First met wins: rounds are played in order and origins in azimuth
      // order, so the approach keeps the earliest round that found it.
      if (state.keptTails.some((held) => sameApproach(samples, tail, held.samples, held.tail))) {
        continue;
      }
      state.keptTails.push({ tail, samples });
      state.approaches.push({
        key,
        direction: state.direction,
        firstRound: roundIndex,
        originAzimuthDeg: leg.origin.azimuthDeg,
        distanceM: path.distanceM,
        durationS: path.durationS,
        // Referenced, not copied: the router owns these points and they are
        // discarded with the run. Only the KEPT legs carry their line.
        polyline: path.polyline,
        // mesurer les largeurs d'une approche demande un corridor, et
        // la découverte n'en fetche aucun, par contrat. C'est le pipeline qui
        // remplit ces deux champs, après coup, ou les laisse à null.
        widthProfile: null,
        gateByWidth: null,
      });
      kept += 1;
    }
  }
  return { routed, kept, failed };
}

// ------------------------------------------------------------------ origins --

/**
 * The azimuths of one round: `rays` equally spaced, offset from every other
 * round so two rounds never fire the same ray.
 *
 * The offset walks a full step across the rounds — round 1 starts at 0, the
 * last round is offset by nearly one of its own steps. With the policy's
 * `[4, 8, 24]` that gives 0/90/180/270, then 15+45k, then 10+15k: 36 distinct
 * bearings. An azimuth that would repeat one already fired is dropped rather
 * than trusted to the arithmetic — the rule must hold for any round list.
 */
export function azimuthsOf(
  rays: number,
  roundIndex: number,
  roundCount: number,
  already: readonly number[],
): readonly number[] {
  if (rays <= 0) return [];
  const step = 360 / rays;
  const offset = roundCount <= 1 ? 0 : (step * (roundIndex - 1)) / roundCount;
  const out: number[] = [];
  for (let i = 0; i < rays; i += 1) {
    const azimuthDeg = (offset + i * step) % 360;
    if (already.some((held) => Math.abs(held - azimuthDeg) < 1e-9)) continue;
    if (out.some((held) => Math.abs(held - azimuthDeg) < 1e-9)) continue;
    out.push(azimuthDeg);
  }
  return out;
}

interface Vertex {
  readonly at: GeoPoint;
  readonly wayId: string;
  readonly azimuthDeg: number;
  readonly distanceM: number;
  readonly classRank: number;
}

/** Every structuring vertex in the band, measured once for all the rounds. */
function structuringVertices(input: DiscoveryInput): readonly Vertex[] {
  const out: Vertex[] = [];
  for (const way of input.neighbourhood.ways) {
    if (!isDrivableWay(way) || !isStructuringWay(way)) continue;
    const rank = highwayRankOf(way);
    for (const at of way.geometry) {
      const distanceM = haversineM(input.stop, at);
      if (distanceM < input.minDistanceM || distanceM > input.radiusM) continue;
      out.push({ at, wayId: way.id, azimuthDeg: bearingDeg(input.stop, at), distanceM, classRank: rank });
    }
  }
  return out;
}

/**
 * Rule B'' (§5, recommendation 1): in the ray's sector, the best class first,
 * then the farthest — the plausibility of the departure, which a bare point on
 * the circle does not have.
 *
 * When the sector holds nothing structuring, the origin is the point at
 * `radiusM` on the ray and `wayId` is null: OSRM snaps it to the nearest road,
 * and the run says plainly that this one was not chosen on the network.
 *
 * Sectors touch at their edges (a vertex exactly on a boundary belongs to
 * both) rather than half-open. Two neighbouring rays can therefore elect the
 * same summit — which costs nothing, because the caller routes an origin once.
 */
function originFor(
  input: DiscoveryInput,
  vertices: readonly Vertex[],
  azimuthDeg: number,
  rays: number,
): DiscoveryOrigin {
  const halfSectorDeg = 180 / rays;
  let best: Vertex | null = null;
  for (const vertex of vertices) {
    if (angularDiffDeg(vertex.azimuthDeg, azimuthDeg) > halfSectorDeg) continue;
    if (best === null || betterOrigin(vertex, best)) best = vertex;
  }
  return best === null
    ? { at: offsetPoint(input.stop, azimuthDeg, input.radiusM), azimuthDeg, wayId: null }
    : { at: best.at, azimuthDeg, wayId: best.wayId };
}

function betterOrigin(candidate: Vertex, held: Vertex): boolean {
  if (candidate.classRank !== held.classRank) return candidate.classRank < held.classRank;
  if (candidate.distanceM !== held.distanceM) return candidate.distanceM > held.distanceM;
  return candidate.wayId < held.wayId;
}

/**
 * 0 = motorway … 5 = unclassified, 9 = unknown — the prototype's scale.
 *
 * A BD TOPO way carries no `highway` tag but an `importance` on the same
 * ordering (1 = most structuring), so it is read on the same scale rather than
 * dropped to "unknown": importance 1 sits with the motorways, 4 with the
 * tertiaries.
 */
export function highwayRankOf(way: RoadWay): number {
  const highway = way.tags['highway'];
  if (highway !== undefined) {
    const base = highway.endsWith('_link') ? highway.slice(0, -'_link'.length) : highway;
    const rank = CLASS_RANK[base];
    if (rank !== undefined) return rank;
  }
  return way.importance === null ? 9 : Math.max(0, way.importance - 1);
}

const CLASS_RANK: Readonly<Record<string, number>> = {
  motorway: 0,
  trunk: 1,
  primary: 2,
  secondary: 3,
  tertiary: 4,
  unclassified: 5,
};

// ------------------------------------------------------- the approach measure --

/**
 * Two legs are the same approach when each covers the other over its tail.
 *
 * Symmetric on purpose: a two-kilometre leg trivially covers the last three
 * hundred metres of a short one, and taking that for agreement would fold
 * every approach into the first.
 */
export function sameApproach(
  aSamples: readonly GeoPoint[],
  aTail: readonly GeoPoint[],
  bSamples: readonly GeoPoint[],
  bTail: readonly GeoPoint[],
): boolean {
  const ab = sharedFraction(aSamples, bTail);
  if (ab < SAME_APPROACH_RATIO) return false;
  return sharedFraction(bSamples, aTail) >= SAME_APPROACH_RATIO;
}

/** The last `metres` of a polyline, end included. */
export function lastMetres(polyline: readonly GeoPoint[], metres: number): readonly GeoPoint[] {
  const out: GeoPoint[] = [];
  let acc = 0;
  for (let i = polyline.length - 1; i >= 0; i -= 1) {
    out.unshift(polyline[i]!);
    const prev = polyline[i - 1];
    if (prev === undefined) break;
    acc += haversineM(prev, polyline[i]!);
    if (acc >= metres) {
      out.unshift(prev);
      break;
    }
  }
  return out;
}

/** One point every `stepM` along the line, the first vertex included. */
export function sampleEvery(polyline: readonly GeoPoint[], stepM: number): readonly GeoPoint[] {
  if (polyline.length === 0) return [];
  const out: GeoPoint[] = [polyline[0]!];
  let carry = 0;
  for (let i = 0; i + 1 < polyline.length; i += 1) {
    const a = polyline[i]!;
    const b = polyline[i + 1]!;
    const lengthM = haversineM(a, b);
    if (lengthM === 0) continue;
    let pos = stepM - carry;
    while (pos <= lengthM) {
      const t = pos / lengthM;
      out.push({ lat: a.lat + t * (b.lat - a.lat), lon: a.lon + t * (b.lon - a.lon) });
      pos += stepM;
    }
    carry = lengthM - (pos - stepM);
  }
  return out;
}

/** Share of `samples` lying within `SNAP_TOLERANCE_M` of the line `other`. */
function sharedFraction(samples: readonly GeoPoint[], other: readonly GeoPoint[]): number {
  if (samples.length === 0 || other.length === 0) return 0;
  let hit = 0;
  for (const sample of samples) {
    const closest = closestPointOnPolyline(other, sample);
    if (closest !== null && closest.distanceM <= SNAP_TOLERANCE_M) hit += 1;
  }
  return hit / samples.length;
}

function angularDiffDeg(a: number, b: number): number {
  const d = Math.abs(((a - b) % 360) + 360) % 360;
  return d > 180 ? 360 - d : d;
}

function pointKey(point: GeoPoint): string {
  return `${point.lat.toFixed(6)},${point.lon.toFixed(6)}`;
}

function padAzimuth(azimuthDeg: number): string {
  return azimuthDeg.toFixed(0).padStart(3, '0');
}

/**
 * `disc:r<tour>@<azimut>:<sens>[:altN]` — la jambe découverte, nommée dans la
 * grammaire des identifiants de production.
 *
 * La clé de la découverte (`r3@085:out:alt1`) porte le sens au milieu ; les
 * identifiants de S3 le portent à l'avant-dernière place, et c'est ce que
 * `wireCandidateId`, `gateKeyOf` et `pairIdOf` savent lire. On réordonne donc,
 * plutôt que d'apprendre un deuxième format à trois lecteurs.
 *
 * Ici et non dans le pipeline : c'est ce module qui frappe les clés,
 * donc c'est à lui de dire comment elles se traduisent. Le test d'acceptation
 * de Thairé s'en sert aussi, et une deuxième traduction écrite dans un test
 * aurait fini par diverger — elle avait commencé à le faire.
 */
export function discoveredLegId(approach: {
  readonly key: string;
  readonly direction: 'in' | 'out';
}): string {
  const alt = /:alt\d+$/.exec(approach.key)?.[0] ?? '';
  const base = approach.key.replace(/:out(?=$|:)/, '').replace(/:alt\d+$/, '');
  return `disc:${base}:${approach.direction}${alt}`;
}

// --------------------------------------------------------- what R0 covers --

/** One R0 leg, reduced to what the approach measure needs. */
export interface R0InboundLeg {
  readonly id: string;
  readonly polyline: readonly GeoPoint[];
}

export interface CoverageResult {
  /** The draft approaches, each now saying which R0 candidate covers it. */
  readonly approaches: readonly DiscoveredApproach[];
  readonly coverage: DiscoveryCoverage;
  /**
   * For each R0 inbound candidate, the approach it shares — which is what
   * says at which round the adaptive search would have held THAT leg.
   */
  readonly approachOfCandidate: ReadonlyMap<string, DiscoveredApproach>;
}

/**
 * Join the discovered approaches to the R0 candidates, on the very measure
 * that de-duplicated them.
 *
 * This is the number the silent run exists to produce: how much of what a full
 * search finds, the five-gate rule already reaches — and which of its own legs
 * go somewhere the search never saw. An R0 leg with no discovered twin is not
 * a bonus; it is a leg the A/B will have to explain.
 */
export function coverApproaches(
  draft: readonly DraftApproach[],
  inbound: readonly R0InboundLeg[],
  windowM: number,
  /**
   * Which end of the legs is compared. `in` compares the last
   * metres — the arrival; `out` the first — the departure. Both sides of the
   * join use the same end, so an outbound R0 candidate is matched against an
   * outbound approach and never against an inbound one.
   */
  direction: 'in' | 'out' = 'in',
): CoverageResult {
  const tailOf = (polyline: readonly GeoPoint[]): readonly GeoPoint[] =>
    direction === 'in'
      ? lastMetres(polyline, windowM)
      : lastMetres([...polyline].reverse(), windowM);

  const legs = inbound
    .filter((leg) => leg.polyline.length >= 2)
    .map((leg) => {
      const tail = tailOf(leg.polyline);
      return { id: leg.id, tail, samples: sampleEvery(tail, SAMPLE_STEP_M) };
    });
  const tails = draft.map((approach) => {
    const tail = tailOf(approach.polyline);
    return { tail, samples: sampleEvery(tail, SAMPLE_STEP_M) };
  });

  const approaches: DiscoveredApproach[] = [];
  const keyOfCandidate = new Map<string, string>();
  const covered = new Set<string>();

  draft.forEach((approach, j) => {
    const mine = tails[j]!;
    let first: string | null = null;
    for (const leg of legs) {
      if (!sameApproach(mine.samples, mine.tail, leg.samples, leg.tail)) continue;
      covered.add(leg.id);
      if (first === null) first = leg.id;
      // First approach met wins, so a candidate names one approach, not several.
      if (!keyOfCandidate.has(leg.id)) keyOfCandidate.set(leg.id, approach.key);
    }
    approaches.push({ ...approach, coveredByCandidateId: first });
  });

  const byKey = new Map(approaches.map((approach) => [approach.key, approach]));
  const approachOfCandidate = new Map<string, DiscoveredApproach>();
  for (const [candidateId, key] of keyOfCandidate) {
    const approach = byKey.get(key);
    if (approach !== undefined) approachOfCandidate.set(candidateId, approach);
  }

  return {
    approaches,
    coverage: {
      approachesTotal: approaches.length,
      coveredByR0: approaches.filter((approach) => approach.coveredByCandidateId !== null).length,
      r0CandidatesUncovered: legs.filter((leg) => !covered.has(leg.id)).map((leg) => leg.id),
    },
    approachOfCandidate,
  };
}
