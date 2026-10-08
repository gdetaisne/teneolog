/**
 * S6 — l'ORDRE DE PRÉFÉRENCE des paires et des plans.
 *
 * La conclusion est une affirmation d'existence : « une proposition passe ».
 * C'est la bonne réponse pour le client et la mauvaise pour l'opérateur, qui a
 * cent plans devant lui et doit commencer quelque part. Ce module relit donc
 * les MÊMES faits une seconde fois et les ordonne. Il n'élit rien et ne rend
 * aucun verdict.
 *
 * LES QUATRE CRITÈRES, dans l'ordre où ils s'appliquent — principe 28,
 * Décision produit, jury de Thairé :
 *
 *   1. verdict           OK < HUMAIN < NON. Ce qui passe bat ce qui pourrait
 *                        passer, qui bat ce qui ne passe pas.
 *   2. inconnues         « Il faut prendre en compte les inconnues : prioriser
 *                        les itinéraires avec AUCUNE inconnue. » Un point en
 *                        doute parce qu'une donnée MANQUE — largeur déclarée ou
 *                        estimée qu'on ne peut pas refuser, anneau non mesuré,
 *                        topologie non prouvée — n'est pas une difficulté
 *                        mesurée : c'est un trou. Zéro d'abord.
 *   3. pire marge        « Dix petits virages sont plus sûrs qu'un 90°. Donc il
 *                        faut classer les itinéraires en fonction du PIRE
 *                        VIRAGE de l'itinéraire — et comme on doit inclure les
 *                        giratoires aussi, le calcul de marge est pratique. »
 *                        La plus petite marge MESURÉE parmi les virages, les
 *                        giratoires et les retournements. Décroissant.
 *   4. distance          croissant. En dernier, parce que c'est le critère qui
 *                        dit le moins de la possibilité du passage.
 *
 * CE QUI NE CLASSE PLUS, et pourquoi :
 *
 *  - **le nombre de points en doute.** C'était le critère n° 2, et c'est lui
 * qui a fait perdre le plan du responsable produit à Thairé : une jambe tronquée à
 *    604 m portait « un point de moins » qu'une jambe contrôlée jusqu'au
 *    cercle, donc elle gagnait. La règle de juin 2026
 *    (`itinerary-scoring-redesign`, principes 2 et 9) le disait déjà : « no
 *    number of gestures term — an easy maneuver carries no passability risk, so
 *    it must not add points ». Compter les points, c'est préférer l'itinéraire
 *    qu'on a le moins regardé.
 *  - **la pire marge TOUS TYPES CONFONDUS.** Principe 27 : « la largeur seule
 *    n'est presque jamais le problème ; les virages, si. » Une section droite à
 *    3,0 m ne pesait pas moins qu'un angle droit dans du 4 m, et c'est ce qui
 *    faisait perdre l'entrée par le nord-est à Thairé. Les `NARROW` de section
 *    droite et la `DESTINATION` sortent donc de la pire marge — en attendant
 *    leur calibration par gabarit. Elles restent publiées et à l'écran.
 *  - **la classe de route et le réseau local.** La classe n'est pas une preuve
 *    (principe 15 : Thairé, 83 tertiaires, 0 primaire), et les mètres passés
 *    hors réseau structurant en sont une deuxième lecture. Les deux restent
 *    publiés ; aucun des deux ne départage.
 *
 * Les quatre champs retirés du classement sont TOUJOURS MESURÉS ET SERVIS
 * (`humanPointCount`, `worstMarginM`, `worstHighwayRank`,
 * `localNetworkLengthM`) : l'opérateur les lit, l'A/B les compare, et les
 * retirer de la sortie ferait perdre la matière qui dit si le changement a été
 * bon.
 *
 * Lexicographique, jamais pondéré. Un score laisserait acheter un demi-mètre de
 * dégagement avec deux kilomètres de détour, et personne ne pourrait dire
 * ensuite ce que le nombre voulait dire. Chaque critère répond seul ou passe la
 * main.
 */
import type {
  CandidateVerdict,
  CriticalPointType,
  PointRef,
  PointVerdict,
  RankedPair,
  RouteCandidate,
  Verdict,
} from '@teneolog/domain';
import type { CollectedPoints } from '@teneolog/points';
import { highwayRankOf, isStructuringHighway } from '@teneolog/topology';

import {
  hardestPerPlace,
  legPointVerdictReader,
  legsFromMeasured,
  type LegPointVerdicts,
} from './legs.js';
import { formPairs, SEVERITY } from './pairs.js';

/**
 * De quoi lire le verdict d'un lieu, et rien d'autre — ce dont `measureContext`
 * a besoin. Plus étroit que `RankingProjection` à dessein : ce qui mesure une
 * paire n'a aucune raison de voir les verdicts de jambe.
 */
export interface LegVerdictReadings {
  readonly pointVerdicts: readonly PointVerdict[];
  /**
   *, second volet — le verdict de chaque lieu SUR CHAQUE JAMBE, tel
   * que `verdictsPerLeg` (`project.ts`) l'a mesuré.
   *
   * Optionnel, et c'est voulu : un appelant qui ne le fournit pas (le rejeu
   * d'un instantané qui ne porte pas `legVerdicts`) garde la lecture par lieu,
   * c'est-à-dire le comportement d'avant. Fourni, le classement lit la MÊME
   * chose que la conclusion — sans quoi le plan retenu se décidait sur la
   * marge et la distance là où un lieu est partagé (Thairé, coin Exemple /
   * Voisine 23).
   */
  readonly perLeg?: LegPointVerdicts;
}

/**
 * What the ranking needs of a projection: the measured verdicts, not the
 * conclusion. Narrow on purpose — the ranking runs while the conclusion is
 * still being built, and must not be able to read it.
 */
export interface RankingProjection extends LegVerdictReadings {
  readonly candidateVerdicts: readonly CandidateVerdict[];
}

/** The anchor a candidate id belongs to: `<wayId>@<azimuth>`, alternatives dropped. */
export function gateKeyOf(candidateId: string): string {
  return candidateId.replace(/:(in|out)(:.*)?$/, '');
}

/** Everything a pair is compared on, before any comparison is made. */
interface Measured {
  readonly pair: RankedPairFacts;
  /** Rank in the input order — S3's, i.e. azimuth. The last word on a total tie. */
  readonly order: number;
}

type RankedPairFacts = Omit<RankedPair, 'rank' | 'reasons'>;

/**
 * The run's pairs, best first.
 *
 * Pure, and total: every comparison ends, ties included. Two pairs equal on all
 * four criteria are separated by the order S3 produced them in — the same
 * tie-break `concludePairs` applies when it keeps the first best pair it meets,
 * so the two readings never disagree merely because they broke a tie
 * differently.
 */
export function rankPairs(
  candidates: readonly RouteCandidate[],
  collected: CollectedPoints,
  projection: RankingProjection,
): readonly RankedPair[] {
  const legs = legsFromMeasured(
    candidates,
    collected,
    projection.candidateVerdicts,
    projection.pointVerdicts,
    projection.perLeg,
  );
  const { pairs } = formPairs(legs);
  if (pairs.length === 0) return [];

  const context = measureContext(candidates, collected, projection);

  const measured = pairs.map((pair, order): Measured => ({
    order,
    pair: {
      inboundId: pair.inboundId,
      outboundId: pair.outId,
      gateKey: gateKeyOf(pair.outId),
      verdict: pair.verdict,
      ...measureLegPair([pair.inboundId, pair.outId], context),
    },
  }));

  const sorted = [...measured].sort(compare);
  return sorted.map((entry, index) => ({
    rank: index + 1,
    ...entry.pair,
    // Why it sits here: what it beats the pair BELOW it on. The one above is
    // someone else's argument.
    reasons: reasonsAgainst(entry.pair, sorted[index + 1]?.pair),
  }));
}

// ---------------------------------------------------------------------------
// Les inconnues
// ---------------------------------------------------------------------------

/**
 * LES CODES D'UN DOUTE NÉ D'UNE DONNÉE ABSENTE — relevés dans `evaluators.ts`,
 * un par un.
 *
 * Ce sont les seuls chemins de `evaluatePoint` et de `judgeTurnaround` qui
 * passent par `human(…)`, c'est-à-dire qui rendent HUMAIN sans avoir pu
 * mesurer. Les deux « cannot_refuse » en font partie et c'est le cœur du
 * sujet : le calcul a bien produit un nombre négatif, mais sur une largeur que
 * personne n'a mesurée — la règle interdit de refuser là-dessus (principe 5),
 * donc ce qui reste est une QUESTION, pas une difficulté établie.
 *
 * `point_geometry_*` est un préfixe : le suffixe est le `why` du fait, et
 * l'énumérer ici ferait une deuxième liste à tenir à jour.
 */
export const UNKNOWN_REASON_CODES: ReadonlySet<string> = new Set([
  /** Largeur estimée (TURN, NARROW, DESTINATION) : elle peut absoudre, jamais refuser. */
  'unmeasured_width_cannot_refuse',
  /** Largeur ou diamètre seulement DÉCLARÉ (giratoire, retournement) : idem. */
  'declared_width_cannot_refuse',
  /** Anneau roulable jamais mesuré : un anneau non mesuré n'est pas un anneau généreux. */
  'roundabout_annulus_unmeasured',
  /** Virage dont la largeur disponible n'a pas été mesurée. */
  'turn_width_unknown',
  /** Impasse non établie (nœud terminal au bord du fetch, VV1-06 / ). */
  'topology_unproven',
]);

const UNKNOWN_REASON_PREFIXES: readonly string[] = [
  /** `point_geometry_no_data`, `…_not_applicable` — la géométrie n'a pas été établie. */
  'point_geometry_',
  /** `destination_width_no_data`, `narrow_width_…` — `widthFit` sur un fait absent. */
  'destination_width_',
  'narrow_width_',
];

/**
 * Ce qu'il faut d'un jugement pour dire si son doute vient d'un trou.
 *
 * Volontairement plus étroit qu'un `PointVerdict` : la question se
 * pose aussi de la MANŒUVRE à l'arrêt, qui est le même jugement
 * (`judgeTurnaround`) mais n'est pas toujours accrochée à un point. Les deux
 * doivent recevoir la même réponse, donc la règle ne peut pas exiger une
 * référence de point pour se prononcer.
 */
export interface UnknownDoubtFacts {
  readonly verdict: Verdict;
  readonly marginM: number | null;
  readonly reasonCodes: readonly string[];
}

/**
 * Ce point est-il une INCONNUE : un doute que seule une donnée manquante crée ?
 *
 * Deux lectures, et la seconde rattrape la première. Les codes ci-dessus
 * nomment les chemins connus ; `marginM === null` dit la même chose d'une autre
 * façon — sur un point HUMAIN, aucune marge mesurée signifie qu'aucune
 * comparaison n'a pu avoir lieu. Aujourd'hui les deux coïncident exactement
 * (tout `human(…)` de `evaluators.ts` rend `marginM: null`, tout `band(…)` rend
 * un nombre) ; la seconde est là pour qu'un évaluateur NOUVEAU qui oublierait
 * de se déclarer ici soit compté comme une inconnue plutôt que silencieusement
 * ignoré. Se tromper dans ce sens-là fait passer un plan derrière un autre ;
 * l'inverse ferait croire un trou mesuré.
 *
 * `confidence_below_publishable` n'en est PAS une : la quantité a bien été
 * mesurée, c'est la confiance dans la source qui est courte. Le point garde sa
 * marge, et cette marge pèse. Un jour où « confiance faible » voudra dire « pas
 * de mesure », ce sera une décision à écrire, pas un effet de bord.
 */
export function isUnknownDoubt(verdict: UnknownDoubtFacts): boolean {
  if (verdict.verdict !== 'HUMAN') return false;
  if (verdict.marginM === null) return true;
  return verdict.reasonCodes.some(
    (code) =>
      UNKNOWN_REASON_CODES.has(code) ||
      UNKNOWN_REASON_PREFIXES.some((prefix) => code.startsWith(prefix)),
  );
}

/**
 * LES TYPES DE POINTS QUI PÈSENT DANS LA PIRE MARGE — principe 27 et 28.
 *
 * Décision produit : « Ce sont les virages les vrais problèmes. » Un
 * virage de carrefour, un giratoire et un retournement demandent tous les trois
 * au camion de balayer plus large que sa caisse, et la marge les compare sur la
 * même échelle : des mètres de chaussée en trop ou en moins à l'endroit où le
 * véhicule déborde.
 *
 * `NARROW` (section droite) et `DESTINATION` n'y sont pas : « je n'ai jamais vu
 * un 3 m en sens unique où un 19 t ne pouvait vraiment pas passer ». Leur seuil
 * reste à calibrer par gabarit ; jusque-là, les faire peser reviendrait à
 * classer sur du bruit — c'est exactement ce qui faisait perdre l'entrée par le
 * nord-est à Thairé (défaut I).
 */
const MARGIN_WEIGHING_TYPES: ReadonlySet<CriticalPointType> = new Set<CriticalPointType>([
  'TURN',
  'ROUNDABOUT',
  'TURNAROUND',
]);

// ---------------------------------------------------------------------------
// What two legs measure together
// ---------------------------------------------------------------------------

/**
 * Ce qu'une paire — ou un plan — mesure, une fois pour toutes.
 *
 * Partagé pour qu'une paire et un plan faits des deux mêmes jambes portent les
 * mêmes nombres. Mesurés deux fois, ce seraient deux lectures qui s'accordent
 * aujourd'hui, et le désaccord que la conclusion rapporte cesserait de vouloir
 * dire quoi que ce soit.
 */
export interface MeasuredLegPair {
  /** Points en doute par MANQUE de donnée. Le premier critère après le verdict. */
  readonly unknownCount: number;
  /** La plus petite marge mesurée sur un virage, un giratoire ou un retournement. */
  readonly worstTurnMarginM: number | null;
  /** Publié, ne classe plus : le coût de revue, tous types confondus. */
  readonly humanPointCount: number;
  /** Publié, ne classe plus : la pire marge tous types confondus. */
  readonly worstMarginM: number | null;
  readonly worstHighwayRank: number | null;
  readonly localNetworkLengthM: number;
  readonly totalDistanceM: number;
}

/**
 * Ce qu'il faut avoir sous la main pour mesurer une paire, préparé une fois.
 *
 * `rankPlans` appelle `measureLegPair` cent fois sur un run de Thairé : refaire
 * ces trois index à chaque appel serait cent fois le même travail, et surtout
 * deux endroits où les construire.
 */
export interface PairMeasureContext {
  readonly candidateById: ReadonlyMap<string, RouteCandidate>;
  readonly collected: CollectedPoints;
  /**
   * le verdict d'un lieu SUR UNE JAMBE, jamais « le verdict du
   * lieu ». La lecture est celle de `legs.ts`, la même que la conclusion
   * utilise, repli par lieu compris.
   */
  readonly verdictAt: (candidateId: string, ref: PointRef) => PointVerdict | undefined;
  readonly typeByRef: ReadonlyMap<PointRef, CriticalPointType>;
}

export function measureContext(
  candidates: readonly RouteCandidate[],
  collected: CollectedPoints,
  readings: LegVerdictReadings,
): PairMeasureContext {
  return {
    candidateById: new Map(candidates.map((candidate) => [candidate.id, candidate])),
    collected,
    verdictAt: legPointVerdictReader(readings.pointVerdicts, readings.perLeg),
    // Le TYPE du point vient de S4, jamais du verdict : c'est un fait de la
    // route, et `PointVerdict` ne le porte pas.
    typeByRef: new Map(collected.points.map((point) => [point.ref, point.type])),
  };
}

/**
 * LES LIEUX DE CES DEUX JAMBES, CHACUN LU SUR LA JAMBE QUI LE CONDUIT —
 *, second volet.
 *
 * La règle est `hardestPerPlace` (`legs.ts`), écrite une fois pour le moteur et
 * pour le rejeu du fil ; ici on ne lui tend que la matière de S5. Au coin
 * Exemple / Voisine 23 (Thairé), la grise tourne de 57° dans 3,0 m
 * déclarés — une inconnue — et la bleue de 98° dans 5,2 m avec +1,04 m : le
 * pire de TOUTES les jambes du run, ce que le classement lisait avant, prêtait
 * l'inconnue de la grise à tous les plans, la bleue comprise.
 */
function readingsOf(
  legIds: readonly [string, string],
  context: PairMeasureContext,
): readonly PointVerdict[] {
  return hardestPerPlace(
    legIds,
    (id) => context.collected.byCandidate.get(id) ?? [],
    context.verdictAt,
  );
}

export function measureLegPair(
  legIds: readonly [string, string],
  context: PairMeasureContext,
): MeasuredLegPair {
  const legCandidates = legIds.flatMap((id) => {
    const candidate = context.candidateById.get(id);
    return candidate === undefined ? [] : [candidate];
  });

  // A point shared by the two legs is ONE place to review, not two: the
  // operator answers it once. Counting it twice would make a pair look
  // twice as expensive as it is. `readingsOf` dit laquelle des deux lectures
  // porte la question.
  const points = readingsOf(legIds, context);

  const margins = points
    .map((pv) => pv.marginM)
    .filter((margin): margin is number => margin !== null);

  // La pire marge du CLASSEMENT : virages, giratoires, retournements, et rien
  // d'autre (principe 27). Un point dont le type est inconnu du relevé n'y
  // entre pas — on ne devine pas qu'un doute est un virage.
  const turnMargins = points.flatMap((pv) => {
    const type = context.typeByRef.get(pv.pointRef);
    if (type === undefined || !MARGIN_WEIGHING_TYPES.has(type)) return [];
    return pv.marginM === null ? [] : [pv.marginM];
  });

  const segments = legCandidates.flatMap((candidate) => [...candidate.segments]);
  const ranks = segments
    .map((segment) => highwayRankOf(segment.highway))
    .filter((rank): rank is number => rank !== null);

  return {
    unknownCount: points.filter(isUnknownDoubt).length,
    // Aucun virage mesuré est un silence, pas une marge nulle.
    worstTurnMarginM: turnMargins.length === 0 ? null : Math.min(...turnMargins),
    humanPointCount: points.filter((pv) => pv.verdict === 'HUMAN').length,
    // No measured margin is a silence, not a clearance of zero.
    worstMarginM: margins.length === 0 ? null : Math.min(...margins),
    // The smallest road the pair must use: rank 1 is a motorway, 9 a track, so
    // the worst class is the HIGHEST rank.
    worstHighwayRank: ranks.length === 0 ? null : Math.max(...ranks),
    // An untagged segment counts as local: a road that does not say what it
    // is has not earned a place among the structuring ones.
    localNetworkLengthM: segments
      .filter((segment) => !isStructuringHighway(segment.highway))
      .reduce((sum, segment) => sum + segment.lengthM, 0),
    totalDistanceM: legCandidates.reduce((sum, candidate) => sum + candidate.distanceM, 0),
  };
}

// ---------------------------------------------------------------------------
// Les critères
// ---------------------------------------------------------------------------

/**
 * Tout ce que les quatre critères lisent, et rien d'autre.
 *
 * Volontairement plus étroit que `MeasuredLegPair` : ce qui n'est pas là ne
 * peut pas classer. Une paire et un plan lui tendent leurs faits, et c'est la
 * seule chose qui garantit que les deux sont ordonnés par les mêmes questions.
 */
export interface RankableFacts {
  readonly verdict: Verdict;
  readonly unknownCount: number;
  readonly worstTurnMarginM: number | null;
  readonly totalDistanceM: number;
}

/**
 * One criterion: its code, and whether `a` strictly beats `b` on it.
 *
 * `null` from `side` means the two are indistinguishable here — hand over to
 * the next criterion. The list order IS the lexicographic order, and it is the
 * only place that order is written down.
 */
interface Criterion {
  readonly code: string;
  readonly side: (a: RankableFacts, b: RankableFacts) => 'a' | 'b' | null;
}

/**
 * L'ORDRE — principe 28 à la lettre : verdict, inconnues, pire marge de virage,
 * distance.
 *
 * C'est la seule table du module, et il n'y en a qu'une : `margin_first`, qui a
 * vécu une journée comme interrupteur de policy, a été tranché par
 * Le responsable produit le soir même — « on priorise le minimum d'inconnues » — donc retiré
 * (principe 22 : une règle rejetée sort du code).
 */
const CRITERIA: readonly Criterion[] = [
  {
    // Names the criterion (the verdict), not the value: it fires whenever a
    // proposal's verdict is strictly better, HUMAN over NO included.
    code: 'verdict_ok',
    side: (a, b) => lowerWins(SEVERITY[a.verdict], SEVERITY[b.verdict]),
  },
  { code: 'no_unknowns', side: (a, b) => lowerWins(a.unknownCount, b.unknownCount) },
  {
    code: 'wider_worst_turn_margin',
    side: (a, b) => higherWinsNullLast(a.worstTurnMarginM, b.worstTurnMarginM),
  },
  { code: 'shorter', side: (a, b) => lowerWins(a.totalDistanceM, b.totalDistanceM) },
];

function compare(a: Measured, b: Measured): number {
  return compareOnCriteria(a.pair, b.pair) || a.order - b.order;
}

/**
 * Les quatre critères, dans l'ordre, sur tout ce qui porte les faits.
 *
 * `0` quand tous égalisent : l'appelant tranche avec l'ordre dans lequel le run
 * a produit ses paires (ou ses plans), et rien d'autre.
 */
export function compareOnCriteria(a: RankableFacts, b: RankableFacts): number {
  for (const criterion of CRITERIA) {
    const side = criterion.side(a, b);
    if (side !== null) return side === 'a' ? -1 : 1;
  }
  return 0;
}

/**
 * The criteria on which this proposal beats the one ranked just below it, in
 * criterion order — so the first code is the one that decided, and the rest are
 * the ways it is also better. Empty on the last one, and on one separated from
 * its successor by azimuth order alone.
 */
export function reasonsAgainst(
  facts: RankableFacts,
  next: RankableFacts | undefined,
): readonly string[] {
  if (next === undefined) return [];
  return CRITERIA
    .filter((criterion) => criterion.side(facts, next) === 'a')
    .map((criterion) => criterion.code);
}

function lowerWins(a: number, b: number): 'a' | 'b' | null {
  if (a === b) return null;
  return a < b ? 'a' : 'b';
}

/**
 * Plus large gagne, et une marge jamais mesurée perd contre n'importe quelle
 * marge connue.
 *
 * C'est la règle de la maison et elle vaut ici aussi : **une absence n'achète
 * pas un rang.** Un plan sans aucun virage mesuré n'a pas produit d'argument
 * pour passer devant — le faire gagner ferait d'un silence une permission, ce
 * que le principe 5 interdit dans l'autre sens comme dans celui-ci. Ce qu'un
 * vrai trou coûte est déjà porté par le critère des inconnues, au-dessus. Deux
 * silences s'égalisent : ni l'un ni l'autre n'a rien dit.
 */
function higherWinsNullLast(a: number | null, b: number | null): 'a' | 'b' | null {
  if (a === null && b === null) return null;
  if (a === null) return 'b';
  if (b === null) return 'a';
  if (a === b) return null;
  return a > b ? 'a' : 'b';
}
