/**
 * S3 — the candidate set: gates × directions, routed, annotated, wrapped as
 * a fact.
 *
 * Every candidate records how it was generated (`generatedBy`), because a
 * set made only of car-optimal primaries under-samples the arterial routes a
 * large vehicle needs (E3) and the consumer must be able to see that. The
 * inbound and its outbound share a gate and are paired through `egressOf` —
 * feasibility at the stop is a property of the PAIRING, which is how the
 * on-site U-turn stays a measured manoeuvre instead of a silent proposal
 * (BUG-001).
 */
import type {
  Fact,
  GatePassMark,
  GeoPoint,
  RouteCandidate,
  RouteDuplicate,
  Turnaround,
  UnreadStretch,
} from '@teneolog/domain';
import type { RoadWay } from '@teneolog/topology';
import type { Gate } from './gates.js';
import { annotateRoute } from './annotate.js';
import { mapWithConcurrency } from './concurrency.js';
import { dropsLeg, markDuplicates, type DedupOptions } from './dedup.js';
import { detectGatePass, gateKeyOf } from './gate-pass.js';
import type { CorridorPort, RoutedPath, RoutingPort } from './ports.js';

export interface CandidateBuildInput {
  readonly stop: GeoPoint;
  readonly gates: readonly Gate[];
  /** The stop's turnaround measurement, from S1 — joins every out candidate. */
  readonly stopTurnaround: Fact<Turnaround>;
  readonly alternativesPerGate: number;
  readonly corridorMarginM: number;
  readonly sampleStepM: number;
  readonly snapM: number;
  readonly approachWindowM: number;
  /** Width credited per marked lane where no width is declared. */
  readonly laneWidthM: number;
  readonly fetchedAt: string;
  /**
   * Minimum matched/sampled ratio below which a candidate is flagged
   * `corridor_partial`. Defaults to 0.8 when omitted.
   */
  readonly minCorridorCoverage?: number;
  /**
   * Maximum number of in-flight OSRM or corridor requests at once.
   * Defaults to 4 when omitted.
   */
  readonly maxConcurrentFetches?: number;
  /**
   * l'ordre dans lequel les corridors partent.
   *
   * Décision produit : « prioriser les itinéraires qui paraissent les
   * plus certains ; ça doit impacter l'organisation des lots ». La fonction
   * reçoit les jambes ROUTÉES (id, sens, tracé) et rend leurs identifiants
   * dans l'ordre où leurs corridors doivent être demandés.
   *
   * Elle ne change **que l'ordre de départ** : les candidats rendus gardent
   * l'ordre d'origine, celui des ancres par azimut, parce que c'est lui qui
   * apparie une sortante à son entrante (`egressOf`, par index) et que le
   * reste du moteur le lit. Une jambe absente de la réponse part en dernier,
   * dans son ordre d'origine — un tri qui oublie une jambe ne la perd pas.
   */
  readonly orderLegs?: (legs: readonly RoutedLegShape[]) => readonly string[];
  /**
   * le dernier mot avant que le premier corridor parte.
   *
   * Appelée une fois, avec les jambes DÉJÀ TRIÉES, elle rend les identifiants
   * dont le corridor peut être chargé — ou `null` pour « tous », qui est le
   * cas de la production. C'est là que le refus commun (policy
   * `phase2.commonRefusalStops`) se joue : le tronc commun est mesuré sur ces
   * tracés-là, et s'il refuse ce camion, il n'y a plus de raison de payer
   * seize corridors pour l'apprendre seize fois.
   *
   * Les jambes écartées reviennent dans `skipped` : rien n'est sauté en silence.
   */
  readonly onRouted?: (
    legs: readonly RoutedLegShape[],
  ) => Promise<readonly string[] | null> | readonly string[] | null;
  /**
   * ce que l'appelant décide entre deux lots (policy
   * `phase2.stopBetweenBatches`).
   *
   * Appelée après chaque lot de `maxConcurrentFetches` corridors avec les
   * candidats DÉJÀ contrôlés ; `'stop'` interrompt le chargement et les
   * jambes restantes sont rendues dans `skipped`, jamais tues. Absente — le
   * cas de la production — les corridors partent en fenêtre glissante, comme
   * avant, et rien n'attend rien.
   */
  readonly onBatch?: (built: BatchReport) => Promise<'continue' | 'stop'> | 'continue' | 'stop';
  /**
   * le dédoublonnage des candidats, `routes.dedup` en policy.
   *
   * Absent ou baissé : les doublons sont MARQUÉS (`duplicateOf`) et rien
   * d'autre — même jeu de candidats, mêmes corridors, mêmes verdicts. Levé :
   * un doublon est écarté avant que son corridor parte (0,8 s chacun) et
   * l'original dit lesquels (`duplicatesRemoved`).
   */
  readonly dedup?: DedupOptions;
}

/** Une jambe routée, telle que le tri la regarde. */
export interface RoutedLegShape {
  readonly id: string;
  readonly direction: 'in' | 'out';
  readonly polyline: readonly GeoPoint[];
}

/** Ce qu'un lot vient de rendre, pour que l'appelant décide de la suite. */
export interface BatchReport {
  /** 1 pour le premier lot. */
  readonly batch: number;
  /** Les candidats construits depuis le début, dans l'ordre de sortie. */
  readonly candidates: readonly RouteCandidate[];
  readonly corridors: ReadonlyMap<string, readonly RoadWay[]>;
  /** Les jambes pas encore chargées, dans l'ordre de départ prévu. */
  readonly pending: readonly RoutedLegShape[];
}

export interface CandidatePorts {
  readonly routing: RoutingPort;
  readonly corridor: CorridorPort;
}

/**
 * The candidates fact plus the corridor already fetched for each candidate.
 * full.ts passes these corridors to collectCriticalPoints without a second
 * fetch — one deserialization and JSON.parse per candidate, not two.
 */
export interface CandidatesResult {
  readonly candidates: Fact<readonly RouteCandidate[]>;
  readonly corridors: Map<string, readonly RoadWay[]>;
  /**
   * les jambes dont le corridor n'a pas été chargé, parce que
   * `onBatch` a dit d'arrêter. Vide dans tous les autres cas, donc vide en
   * production tant que `phase2.stopBetweenBatches` est baissé.
   */
  readonly skipped: readonly RoutedLegShape[];
  /** Le lot après lequel `onBatch` a coupé, 1-based. Null quand rien n'a coupé. */
  readonly stoppedAfterBatch: number | null;
}

export async function buildRouteCandidatesWithCorridors(
  input: CandidateBuildInput,
  ports: CandidatePorts,
): Promise<CandidatesResult> {
  const empty = (why: 'no_data' | 'provider_error'): CandidatesResult => ({
    candidates: { known: false, why },
    corridors: new Map(),
    skipped: [],
    stoppedAfterBatch: null,
  });

  if (input.gates.length === 0) return empty('no_data');

  const limit = input.maxConcurrentFetches ?? 4;
  const minCoverage = input.minCorridorCoverage ?? 0.8;

  // ── Steps 1-3: router chaque (ancre × sens), aplatir en tâches corridor ──
  const { tasks: routed, routerFailures } = await routeGateLegs(input, ports, limit);

  // ── les doublons et les traversées d'ancre, EN SILENCE ─────────
  //
  // Ici, et pas après : un doublon écarté avant l'étape 4 est un corridor de
  // moins (0,8 s mesuré), une annotation de moins et une jambe de moins dans
  // le classement. Drapeau baissé, `removed` est vide et il ne reste que des
  // marques — le test d'or le vérifie.
  const marks = markRoutedLegs(routed, input);
  const corridorTasks = routed.filter((task) => !marks.removed.has(task.id));

  if (corridorTasks.length === 0) return empty(routerFailures > 0 ? 'provider_error' : 'no_data');

  // ── Step 4: corridor fetch + annotation, dans l'ORDRE DE CERTITUDE ───────
  //
  // l'ordre de DÉPART change, l'ordre de SORTIE jamais. Les slots
  // sont remplis à leur place d'origine, celle des ancres par azimut, parce
  // que c'est elle qui apparie une sortante à son entrante par index.
  const order = executionOrder(corridorTasks, input.orderLegs);
  const allowed =
    input.onRouted === undefined
      ? null
      : await input.onRouted(order.map((slot) => legShapeOf(corridorTasks[slot] as CorridorTask)));
  const runnable =
    allowed === null
      ? order
      : order.filter((slot) => allowed.includes((corridorTasks[slot] as CorridorTask).id));

  const corridors = new Map<string, readonly RoadWay[]>();
  const loaded = new Set<number>();
  let stoppedAfterBatch: number | null = null;

  const fetchOne = async (slot: number): Promise<void> => {
    const task = corridorTasks[slot] as CorridorTask;
    corridors.set(task.id, await ports.corridor.fetchCorridor(task.path.polyline, input.corridorMarginM));
    loaded.add(slot);
  };

  if (input.onBatch === undefined) {
    // La production : une fenêtre glissante, exactement comme avant.
    await mapWithConcurrency(runnable, limit, fetchOne);
  } else {
    for (let start = 0; start < runnable.length; start += limit) {
      const batch = runnable.slice(start, start + limit);
      await mapWithConcurrency(batch, limit, fetchOne);
      const batchIndex = Math.floor(start / limit) + 1;
      const pending = runnable.slice(start + limit).map((slot) => legShapeOf(corridorTasks[slot] as CorridorTask));
      if (pending.length === 0) break;
      const built = assemble(corridorTasks, loaded, corridors, input, minCoverage, marks);
      const verdict = await input.onBatch({ batch: batchIndex, candidates: built.candidates, corridors, pending });
      if (verdict === 'stop') {
        stoppedAfterBatch = batchIndex;
        break;
      }
    }
  }

  const skipped = order
    .filter((slot) => !loaded.has(slot))
    .map((slot) => legShapeOf(corridorTasks[slot] as CorridorTask));

  // ── Step 5: build candidates + corridors map, dans l'ordre d'origine ──────
  const { candidates } = assemble(corridorTasks, loaded, corridors, input, minCoverage, marks);
  if (candidates.length === 0) return empty(routerFailures > 0 ? 'provider_error' : 'no_data');

  return {
    candidates: {
      known: true,
      value: candidates,
      provenance: { source: 'osrm', method: 'gates-and-alternatives', fetchedAt: input.fetchedAt },
      reliability: {
        confidence: 1,
        basis: 'derived',
        // Read by the conclusion (`routerFailed`): with no pair left, this is
        // what turns "no itinerary" into `router_unavailable`.
        reasonCodes: routerFailures > 0 ? ['some_gate_routes_failed'] : [],
      },
    },
    corridors,
    skipped,
    stoppedAfterBatch,
  };
}

/** `wayId@azimut:sens[:altN]` — l'identifiant d'une jambe, en un seul endroit. */
function candidateIdOf(gate: Gate, direction: 'in' | 'out', index: number): string {
  return `${gateKeyOf(gate)}:${direction}${index === 0 ? '' : `:alt${index}`}`;
}

/** Une jambe routée, avec ce qu'il faut pour aller chercher son corridor. */
interface CorridorTask {
  readonly gate: Gate;
  readonly direction: 'in' | 'out';
  readonly path: RoutedPath;
  readonly index: number;
  readonly id: string;
}

/**
 * Étapes 1 à 3 — une requête OSRM par (ancre × sens), aplaties en tâches
 * corridor dans l'ordre des ancres.
 *
 * Sortie de `buildRouteCandidatesWithCorridors` (principe 26 : un
 * fichier gelé se découpe quand on y touche). Aucun comportement ne change :
 * mêmes tâches, même ordre, même compte d'échecs du routeur.
 */
async function routeGateLegs(
  input: CandidateBuildInput,
  ports: CandidatePorts,
  limit: number,
): Promise<{ readonly tasks: readonly CorridorTask[]; readonly routerFailures: number }> {
  interface RouteTask { gate: Gate; direction: 'in' | 'out'; from: GeoPoint; to: GeoPoint }
  const routeTasks: RouteTask[] = [];
  for (const gate of input.gates) {
    for (const direction of ['in', 'out'] as const) {
      routeTasks.push({
        gate,
        direction,
        from: direction === 'in' ? gate.at : input.stop,
        to: direction === 'in' ? input.stop : gate.at,
      });
    }
  }

  interface RouteResult { gate: Gate; direction: 'in' | 'out'; paths: readonly RoutedPath[]; failed: boolean }
  const routeResults = await mapWithConcurrency(
    routeTasks,
    limit,
    async ({ gate, direction, from, to }): Promise<RouteResult> => {
      try {
        return { gate, direction, paths: await ports.routing.route(from, to, input.alternativesPerGate), failed: false };
      } catch {
        return { gate, direction, paths: [], failed: true };
      }
    },
  );

  const tasks: CorridorTask[] = [];
  for (const r of routeResults) {
    if (r.failed) continue;
    for (const [index, path] of r.paths.entries()) {
      // L'identifiant est arrêté ICI et plus bas il est seulement relu : le tri
      // doit pouvoir nommer une jambe avant que son corridor parte.
      tasks.push({ gate: r.gate, direction: r.direction, path, index, id: candidateIdOf(r.gate, r.direction, index) });
    }
  }
  return { tasks, routerFailures: routeResults.filter((r) => r.failed).length };
}

/** Ce que sait des jambes routées, avant qu'un corridor parte. */
export interface RoutedLegMarks {
  /** Par jambe : celle dont elle répète l'itinéraire. */
  readonly duplicates: ReadonlyMap<string, RouteDuplicate>;
  /** Les jambes que les drapeaux écartent — vide quand `dedup.enabled` est baissé. */
  readonly removed: ReadonlySet<string>;
  /** Par original : les jambes écartées en son nom. */
  readonly removedBy: ReadonlyMap<string, readonly string[]>;
  /** Par jambe : l'ancre retenue qu'elle traverse, quand il y en a une. */
  readonly gatePasses: ReadonlyMap<string, GatePassMark>;
}

/**
 * les doublons et les traversées d'ancre des jambes routées.
 *
 * Pure : ni réseau, ni corridor. La traversée d'ancre se mesure toujours (c'est
 * une lecture, elle n'écarte rien) ; le dédoublonnage marque toujours et
 * n'écarte que sous `routes.dedup`.
 */
export function markRoutedLegs(
  tasks: readonly CorridorTask[],
  input: Pick<CandidateBuildInput, 'stop' | 'gates' | 'dedup'>,
): RoutedLegMarks {
  const duplicates = markDuplicates(tasks.map(legShapeOf));
  const options = input.dedup ?? { enabled: false, approach: false };

  const removed = new Set<string>();
  const removedBy = new Map<string, string[]>();
  for (const task of tasks) {
    const mark = duplicates.get(task.id);
    if (mark === undefined || !dropsLeg(mark, options)) continue;
    removed.add(task.id);
    removedBy.set(mark.candidateId, [...(removedBy.get(mark.candidateId) ?? []), task.id]);
  }

  const gatePasses = new Map<string, GatePassMark>();
  for (const task of tasks) {
    const pass = detectGatePass({
      polyline: task.path.polyline,
      gate: task.gate,
      gates: input.gates,
      stop: input.stop,
      direction: task.direction,
    });
    if (pass !== null) gatePasses.set(task.id, pass);
  }

  return { duplicates, removed, removedBy, gatePasses };
}

function legShapeOf(task: {
  readonly id: string;
  readonly direction: 'in' | 'out';
  readonly path: RoutedPath;
}): RoutedLegShape {
  return { id: task.id, direction: task.direction, polyline: task.path.polyline };
}

/**
 * Les indices des tâches, dans l'ordre où leurs corridors doivent partir.
 *
 * Sans `orderLegs`, c'est l'ordre d'origine — donc rien ne change. Avec, c'est
 * l'ordre rendu par le tri, suivi de toute jambe que le tri aurait oubliée :
 * une jambe ne se perd jamais dans un classement.
 */
function executionOrder(
  tasks: readonly { readonly id: string; readonly direction: 'in' | 'out'; readonly path: RoutedPath }[],
  orderLegs: CandidateBuildInput['orderLegs'],
): readonly number[] {
  const natural = tasks.map((_, i) => i);
  if (orderLegs === undefined) return natural;
  const slotOfId = new Map<string, number>();
  tasks.forEach((task, i) => {
    if (!slotOfId.has(task.id)) slotOfId.set(task.id, i);
  });
  const out: number[] = [];
  const seen = new Set<number>();
  for (const id of orderLegs(tasks.map(legShapeOf))) {
    const slot = slotOfId.get(id);
    if (slot === undefined || seen.has(slot)) continue;
    seen.add(slot);
    out.push(slot);
  }
  for (const slot of natural) if (!seen.has(slot)) out.push(slot);
  return out;
}

/**
 * Les candidats des jambes DÉJÀ chargées, dans l'ordre d'origine.
 *
 * Rejouée à chaque lot quand `onBatch` est fourni : l'annotation est pure et
 * ne coûte rien de réseau, et la refaire évite de tenir un état partiel que
 * deux chemins devraient maintenir d'accord.
 */
function assemble(
  tasks: readonly CorridorTask[],
  loaded: ReadonlySet<number>,
  corridors: ReadonlyMap<string, readonly RoadWay[]>,
  input: CandidateBuildInput,
  minCoverage: number,
  marks: RoutedLegMarks,
): { candidates: readonly RouteCandidate[] } {
  // First pass: collect every inbound candidate id per gate so outbounds can
  // reference their matching inbound by index.
  const inboundIdsByGate = new Map<string, string[]>();
  tasks.forEach((task, slot) => {
    if (!loaded.has(slot) || task.direction !== 'in') return;
    const key = gateKeyOf(task.gate);
    const ids = inboundIdsByGate.get(key) ?? [];
    ids.push(task.id);
    inboundIdsByGate.set(key, ids);
  });

  const candidates: RouteCandidate[] = [];
  tasks.forEach((task, slot) => {
    if (!loaded.has(slot)) return;
    const corridor = corridors.get(task.id) ?? [];
    const key = gateKeyOf(task.gate);

    const annotated = annotateRoute({
      polyline: task.path.polyline,
      corridor,
      sampleStepM: input.sampleStepM,
      snapM: input.snapM,
      approachWindowM: input.approachWindowM,
      laneWidthM: input.laneWidthM,
      direction: task.direction,
      fetchedAt: input.fetchedAt,
    });

    let egressOf: RouteCandidate['egressOf'] = null;
    if (task.direction === 'out') {
      // Pair by index; fall back to the last available inbound when there are
      // fewer inbound alternatives than outbound ones. When the inbound leg was
      // lost to the router (`routerFailures`), the id below names a candidate
      // that does not exist: S5 reads that dangling pairing as "the router did
      // not answer", an unknown — never a refusal.
      const inboundIds = inboundIdsByGate.get(key) ?? [];
      const inboundId = inboundIds[task.index] ?? inboundIds.at(-1) ?? `${key}:in`;
      egressOf = { inboundId, turnaround: input.stopTurnaround };
    }

    candidates.push({
      id: task.id,
      direction: task.direction,
      polyline: task.path.polyline,
      segments: annotated.segments,
      coverage: annotated.coverage,
      corridorReasonCodes: corridorReasonCodesFor(annotated.coverage, minCoverage),
      // OÙ la carte a manqué, et rien quand elle n'a pas manqué.
      // Additif comme les marques de retirer ce champ rend le
      // candidat d'avant la tâche, au bit près.
      ...unreadOf(annotated.unread),
      generatedBy: task.index === 0 ? 'car-optimal' : 'alternative',
      distanceM: task.path.distanceM,
      durationS: task.path.durationS,
      egressOf,
      // additifs, et POSÉS SEULEMENT QUAND ILS DISENT QUELQUE CHOSE.
      //
      // Une jambe sans doublon ne porte pas `duplicateOf: null` : un champ nul
      // dirait « mesuré, rien trouvé » sur une jambe DÉCOUVERTE, qui n'est
      // jamais passée par cette mesure (le rejeu de `replay.ts` ne la fait
      // pas). Retirer ces trois champs rend le candidat d'avant la tâche, au
      // bit près — c'est ce que le test d'or vérifie.
      ...marksOf(task.id, marks),
    });
  });

  return { candidates };
}

/**
 * les marques de cette jambe, et rien quand il n'y en a pas.
 *
 * Un objet vide se répand sans laisser de trace : c'est ce qui rend le champ
 * ADDITIF au sens de le retirer rend l'objet d'avant.
 */
function marksOf(id: string, marks: RoutedLegMarks): Partial<RouteCandidate> {
  const duplicateOf = marks.duplicates.get(id);
  const duplicatesRemoved = marks.removedBy.get(id);
  const passesThroughGate = marks.gatePasses.get(id);
  return {
    ...(duplicateOf === undefined ? {} : { duplicateOf }),
    ...(duplicatesRemoved === undefined ? {} : { duplicatesRemoved }),
    ...(passesThroughGate === undefined ? {} : { passesThroughGate }),
  };
}

/**
 * Backward-compatible wrapper — callers that only need the candidates fact
 * (adapter scripts, tests) continue to work unchanged.
 */
export async function buildRouteCandidates(
  input: CandidateBuildInput,
  ports: CandidatePorts,
): Promise<Fact<readonly RouteCandidate[]>> {
  return (await buildRouteCandidatesWithCorridors(input, ports)).candidates;
}

/**
 * Returns `['corridor_partial']` when fewer than `minCoverage` of samples were matched.
 *
 * Exported so the replay of an already-routed leg (`replay.ts`)
 * reads corridor quality with THIS rule rather than a copy of it. Nothing else
 * changes: the function, its body and its only production caller are untouched.
 */
export function corridorReasonCodesFor(
  coverage: { sampled: number; matched: number },
  minCoverage: number,
): readonly string[] {
  if (coverage.sampled === 0) return [];
  return coverage.matched / coverage.sampled < minCoverage ? ['corridor_partial'] : [];
}

/**
 * le champ `corridorUnread`, ou rien du tout.
 *
 * Exporté pour la MÊME raison que `corridorReasonCodesFor` : le rejeu d'une
 * jambe déjà routée (`replay.ts`) doit poser le champ avec cette règle-ci, et
 * non une copie — sans quoi les deux chemins publieraient deux objets et le
 * test de comparaison champ à champ ne prouverait plus rien.
 */
export function unreadOf(unread: readonly UnreadStretch[]): Partial<RouteCandidate> {
  return unread.length === 0 ? {} : { corridorUnread: unread };
}
