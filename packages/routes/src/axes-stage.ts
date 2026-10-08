/**
 * L'ÉTAGE « AXES », de bout en bout : chercher, poser, choisir.
 *
 * Trois temps, celui de l'engine (`searchSemiNetworkAnchorsBdtopo` →
 * `computePhase1AxisDiagnostics` → `discoverAxisGateCandidates` →
 * `selectItinerariesForAnalysis`) :
 *
 *  1. **Le rayon adaptatif.** On demande les axes (importance ≤ 3) dans un
 *     petit disque, et on cherche le premier ANNEAU dont les PORTES RETENUES
 *     couvrent assez de directions (`gates.axes.minGateDirections`, 2). Si
 *     aucun ne suffit, on redemande plus large, et ainsi de suite jusqu'à
 *     15 km. L'engine fait exactement ça avec trois vagues (500 m urbain, puis
 *     5 km et 15 km ruraux) ; les rayons de requête sont en policy pour que le
 *     nombre de requêtes soit un réglage visible. **L'ordre de cette recherche
 *     est celui du principe 34, et il tient en trois temps** : le cercle de
 *     2 000 m sur le réseau structurant, puis la classe 4 SUR LE CERCLE (la
 *     bande 1 800–2 000 m, jamais plus près), puis seulement l'escalade — voir
 *     `sweepAll`, plus bas.
 *  2. **Les portes** sur les axes retenus, avec les rues locales du même
 *     rayon.
 *  3. **La sélection** par secteurs, jusqu'à `gateCount`.
 *
 * LES TROIS TEMPS NE SONT PLUS EN FILE, ILS SONT
 * IMBRIQUÉS. Le critère d'arrêt compte les directions des portes RETENUES, donc
 * juger un anneau demande d'aller jusqu'au bout des trois temps pour cet
 * anneau : chercher, poser, choisir, puis compter. La règle et ce qu'elle
 * change à celle de l'engine sont dans `axes-rings.ts` ; ce que ça coûte est
 * publié anneau par anneau dans `AxisSearch.ringProbes`, et le pool de rues
 * locales (plus bas) est ce qui empêche ce coût d'être multiplié par le nombre
 * d'anneaux.
 *
 * UN INCONNU N'EST JAMAIS UN REFUS (principe 5). Sans source BD TOPO, sans
 * axe à 15 km, ou sans porte sur les axes trouvés, l'étage rend un `AxisSearch`
 * qui DIT lequel des trois cas s'est produit, et la sélection R0 reste. Rien
 * ne lève d'exception : une BD TOPO muette dégrade une lecture, elle
 * n'interrompt aucune analyse — la leçon de F1 (fiche S3 §8).
 *
 * DEUX RÈGLES DE CHOIX, ET CE FICHIER NE PORTE NI L'UNE
 * NI L'AUTRE. `gates.axes.selection` décide : `sectors` (les trois temps
 * ci-dessus, la règle livrée) ou `axes` (l'ancrage à l'échelle du lieu,
 * `axes-scale.ts`). Ce qui reste ici est l'orchestration — le budget, les
 * vagues, le pool, ce qu'on publie — et les deux règles y sont branchées de la
 * même façon. Ce que l'étage DEMANDE aux données a été sorti le même jour dans
 * `axes-fetch.ts` (principe 26 : ce qui dépasse se découpe quand on y touche).
 */
import type {
  AxisFetchReport,
  AxisRingProbe,
  AxisSearch,
  AxisSearchReason,
  AxisSelectionMode,
  GeoPoint,
} from '@teneolog/domain';

import { probeBand } from './axes-band.js';
import {
  AxisWaves,
  LocalWayPool,
  type AxisSourcePort,
  type Mutable,
} from './axes-fetch.js';
import { axisPassOf, type AxisPass } from './axes-pass.js';
import { betterRing, probeOf, searchRingsForDirections, type AxisRingAttempt } from './axes-rings.js';
import { assemble, empty } from './axes-publish.js';
import { DEFAULT_AXIS_SELECTION, sweepByScale } from './axes-scale.js';

export type { AxisSourcePort } from './axes-fetch.js';

export interface AxisStageParams {
  readonly enabled: boolean;
  /**
   * QUELLE RÈGLE CHOISIT LES ANCRES, EN SILENCE.
   *
   * `sectors` (la valeur livrée, et l'absence de clé) : la règle du
   * 2026-09-14 — quotas par secteurs fixes, classe 4 sur le cercle en repli.
   * `axes` : l'ancrage à l'échelle du lieu, une ancre par axe fiable et par
   * côté (`axes-scale.ts`, où la règle et les mots du responsable produit sont écrits).
   * Date de décision dans la note de conception interne; retour arrière : reposer
   * `sectors`, rien d'autre.
   */
  readonly selection?: AxisSelectionMode;
  /** Importance maximale d'un axe. L'engine dit 3 : l'autoroute (1) est exclue, 2 et 3 sont gardées. */
  readonly importanceMax: number;
  /** Importance minimale d'un axe — 2 chez l'engine (`BDTOPO_ANCHOR_MIN_IMPORTANCE`). */
  readonly importanceMin: number;
  /** Les classes des rues locales qui font une porte en rejoignant un axe. */
  readonly localImportance: { readonly min: number; readonly max: number };
  readonly ringsM: readonly number[];
  /** Les rayons successivement demandés à la source, croissants. */
  readonly fetchRadiiM: readonly number[];
  readonly sectorCount: number;
  /**
   * LE CRITÈRE D'ARRÊT : combien de DIRECTIONS
   * distinctes (secteurs de 30°) les PORTES RETENUES doivent couvrir pour
   * qu'un anneau suffise. La règle, sa source et ce qu'elle change à celle de
   * l'engine sont dans `axes-rings.ts` ; le nombre et sa mesure, dans
   * `config/policy.example.json`.
   */
  readonly minGateDirections: number;
  /**
   * L'ÉCART SOUS LEQUEL DEUX PORTES SONT LA MÊME
   * DIRECTION. 60° livrés, soit deux secteurs de 30°. L'écart se mesure ENTRE
   * DEUX PORTES, jamais de proche en proche : un éventail continu de 150° est
   * trois approches, pas une (mesuré, rapport §12.2). La règle et sa source
   * sont dans `distinctDirections` (`axes-geometry.ts`) ; le constat qui
   * l'impose est Thairé, quatre portes aux azimuts 290–307° que l'ancien
   * compte lisait comme deux directions.
   */
  readonly minDirectionSeparationDeg: number;
  /**
   * LA CLASSE 4 SUR LE CERCLE, avant d'aller
   * chercher plus loin.
   *
   * Le responsable produit, sur Thairé : les routes qui comptent y sont des importance 4
   * (la D203E5 et la D113), et l'étage partait à 5 km poser quatre portes à
   * 4,7–5,0 km. La règle : quand aucun anneau ≤ `escalationBoundM` n'offre le
   * compte de directions avec les axes d'importance 2–3, l'étage cherche les
   * portes de classe 4 **dans la bande `minReachM` – `escalationBoundM`**
   * (1 800–2 000 m) — les axes de cette classe qui COUPENT la bande, une porte
   * par direction là où ils la coupent (`axes-band.ts`) — et seulement
   * ensuite, s'il n'a toujours pas le compte et pas une seule porte, escalade
   * à 5, 10, 15 km sur les 2–3.
   *
   * **JAMAIS SOUS `minReachM`.** C'est le principe 7, et c'est l'écart écrit
   * du principe 34 : importance 2–3 = premier point rencontré ; importance 4 =
   * au cercle, jamais plus près. La première écriture de cette règle rejouait
   * les MÊMES ANNEAUX en classe 4 et s'arrêtait au plus proche : à Thairé,
   * 190 tronçons d'importance 4 dans le cercle, un axe à 1 m de l'arrêt, une
   * ancre posée à 24 m et 1,78 km d'approche déclarés non étudiés. La classe 4
   * n'y est pas « les deux départementales » : c'est le réseau du village.
   *
   * SANS EFFET EN MODE `axes` (2026-09-15). « oublie départementale,
   * il y a de tout là-dedans. Par contre imp 2-3 c'est fiable. » — la bande de
   * classe 4 n'existe pas dans ce mode, et cette clé n'y est pas lue.
   *
   * SOURCE, ET L'ÉCART À L'ENGINE (principe 29, écrit comme le principe 34 le
   * demande). L'engine a un repli « secondaire 4 »
   * (`pickTopSecondaryFallbackAnchors`, `bdtopo-anchor-reliability.ts`), dont
   * la condition est « aucune importance 1–3 ne coupe AUCUN anneau jusqu'à
   * 5 km » : chez lui l'anneau s'élargit AVANT le repli. Ici la condition est
   * « aucune 2–3 ne donne le compte SOUS 2 km », donc le repli passe AVANT
   * l'élargissement — c'est le principe 34 qui l'impose (« si on trouve une
   * départementale à moins de 2 km je vois mal l'intérêt d'aller chercher plus
   * loin »), et c'est l'écart assumé. À égalité ou moins que `importanceMax`,
   * la passe ne sert à rien et n'est pas jouée.
   */
  readonly circleFallbackImportanceMax: number;
  /**
   * Plafond de lignes de la requête d'AXES ; l'atteindre exactement veut dire
   * « il en manque peut-être » (`AxisFetchReport.truncated`).
   *
   * Séparé du plafond local depuis la relecture du 2026-09-14 : l'engine tient
   * ses 500 lignes parce qu'il RATTRAPE ce que la troncature lui a caché
   * (BUG-045, un re-fetch à 300 m aux bouts d'axe qu'aucune porte ne couvre) ;
   * l'app ne porte pas encore ce sauvetage, et les huit adresses du corpus
   * rendent toutes `truncated: true`. Deux plafonds plutôt qu'un : large sur
   * les axes, où le tri par distance coupe les branches lointaines d'une
   * requête de 15 km, serré sur les rues locales, où un disque de 1 500 m
   * autour d'un axe rend déjà tout ce qui compte. Mesuré dans le rapport.
   */
  readonly maxAxisSegmentsPerFetch: number;
  /** Plafond de lignes d'une requête de rues locales (engine : `BDTOPO_SEMI_NETWORK_FETCH_LIMIT`). */
  readonly maxLocalSegmentsPerFetch: number;
  /**
   * Le budget serveur d'une requête, en millisecondes — LU PAR LE CÂBLAGE, pas
   * par l'étage, qui ne connaît pas la source. Il vit ici pour que le nombre et
   * sa mesure tiennent dans le même bloc de policy que le reste de l'étage.
   */
  readonly queryTimeoutMs?: number;
  /**
   * LE BUDGET DE TOUT L'ÉTAGE, et non d'une requête.
   *
   * `queryTimeoutMs` borne UNE requête ; l'étage en enchaîne jusqu'à trois
   * (les rayons d'axes) plus une (la classe 4 sur le cercle, qui ne demande
   * aucune rue locale) puis, avec le pool PAR ANNEAU (rapport §9), jusqu'à 7
   * (le disque autour de l'arrêt, redemandé à chaque rayon distinct — pas 1,
   * un par anneau) plus 48 (le chapelet le long des axes, budget global),
   * toutes EN SÉRIE : 3 + 1 + 7 + 48 = 59 requêtes, et non 49 ou 52. Au pire
   * théorique, 59 × 8 s font 7 min 52 s — et `sealAxes` les fait attendre à
   * la fin du run (`full.ts`, puis `run.status = 'complete'` dans
   * l'API (hors instantané)), drapeau baissé compris.
   *
   * RELU LE 2026-09-14 (principe 34, `axes-rings.ts`) : le garde-fou qui
   * arrête l'escalade dès qu'une porte est retenue sous 2 km NE BAISSE PAS ce
   * plafond théorique — il ne peut PAS le baisser, parce que le pire cas est
   * précisément celui où rien n'est jamais trouvé sous 2 km (l'escalade
   * complète jusqu'à 15 km est alors légitime, principe 34 lui-même). Ce que
   * le garde-fou supprime, c'est un cas intermédiaire qui existait avant lui :
   * une porte trouvée tôt (250 m, une seule direction) n'empêchait pas
   * l'étage de continuer à payer jusqu'à 15 km pour rien — ce cas-là plafonne
   * maintenant à 2 vagues d'axes + 1 vague de classe 4 + 4 disques (50, 250,
   * 500, 2 000) + le chapelet, soit 55 au pire. Une lecture qui ne déplace aucun verdict ne
   * peut pas tenir un run en otage : passé ce budget, l'étage rend un
   * `AxisSearch` de motif `timeout` et libère la fin du run. La requête
   * restée en vol finit d'elle-même sur son `statement_timeout` côté serveur ;
   * personne ne lit ce qu'elle rapporte.
   *
   * EN MODE `axes` (2026-09-30), le compte ci-dessus ne tient plus :
   * le sauvetage BUG-045 (`axes-rescue.ts`) ajoute jusqu'à dix disques de
   * 300 m par axe distinct rencontré, trois à la fois, hors du budget du
   * chapelet et sans plafond en nombre — comme dans l'engine. Ce budget-ci est
   * alors sa SEULE borne, et le relevé du corpus chiffre ce qu'il coûte
   * (`AxisFetchReport.rescue`). Le mode `sectors` n'en fait aucun.
   *
   * C'est une horloge de mur, volontairement : `now` sert à CHIFFRER l'étage,
   * pas à le borner — un test qui fige l'horloge ne doit pas désarmer le
   * garde-fou.
   *
   * RELU LE 2026-09-14 — SUR `timeout`, R0 SERT TOUJOURS (`fallback:
   * 'r0_timeout'`), même quand le meilleur anneau déjà trouvé portait déjà
   * des portes retenues : un étage coupé au budget n'a pas fini de JUGER cet
   * anneau (principe 5, « un étage inachevé n'est pas une décision »). Ce
   * meilleur anneau reste PUBLIÉ — visible dans l'onglet Ancres, en lecture —
   * mais jamais SERVI (`gate-stage.ts`, `gatesOf`).
   */
  readonly stageTimeoutMs: number;
  /**
   * LES RUES LOCALES SE CHERCHENT AUSSI LE LONG DES AXES.
   *
   * Un disque de rues locales centré sur l'ADRESSE ne sert à rien quand l'axe
   * est à 4 km : les 500 lignes les plus proches sont toutes au pied de
   * l'adresse, et aucune ne touche l'axe. Mesuré à Thairé le 2026-09-14 —
   * anneau 5 000 m, trois axes à 3 663, 4 749 et 4 887 m, 462 rues locales
   * rendues, ZÉRO porte. C'est le `fetchLocal45SegmentsAroundAxis` de
   * l'engine (`AXIS_LOCAL_FETCH_RADIUS_M`, `AXIS_LOCAL_FETCH_POINT_SPACING_M`,
   * `AXIS_LOCAL_FETCH_MAX_POINTS`), et sans lui l'étage est muet en rural.
   */
  readonly localFetchRadiusM: number;
  readonly localFetchSpacingM: number;
  readonly localFetchMaxPointsPerAxis: number;
  /** Plafond global de requêtes locales, toutes axes confondues (engine : 48). */
  readonly localFetchMaxPoints: number;
  readonly gateCount: number;
  /**
   * PRINCIPE 34 — le cercle de `gates.minReachM`, ET CE QU'IL BORNE.
   *
   * **Sur le réseau structurant (importance 2–3), il ne borne rien** : l'ancre
   * est le premier point du réseau rencontré en remontant du point de
   * livraison, même à 300 m (Décision produit). Il sert alors uniquement
   * à DIRE combien de mètres d'approche une porte laisse hors étude
   * (`AxisGate.uncontrolledBeyondM`, `AxisSearch.uncontrolled`).
   *
   * **En classe 4, il est le bord intérieur de la bande** où les portes se
   * posent (`axes-band.ts`, 2026-09-14 au soir) : importance 2–3 = premier
   * point rencontré ; importance 4 = au cercle, jamais plus près (principe 7).
   *
   * Le plancher lui-même reste la règle des jambes R0 et découvertes
   * (/415), qui partent de l'ancre et non du réseau.
   */
  readonly minReachM: number;
  /**
   * LE CERCLE : celui dans lequel l'étage cherche
   * d'abord, et au-delà duquel il n'élargit que faute de mieux.
   *
   * C'est `gates.searchRadiusM` (2 000 m), pas un nombre nouveau (principe 23)
   * — distinct de `minReachM` ci-dessus, qui dit ce qu'une jambe doit
   * ATTEINDRE pour concourir, pas jusqu'où l'ancrage CHERCHE. Il borne les
   * DEUX temps du cercle (`sweepAll`) : le réseau structurant d'abord, la
   * classe 4 ensuite. Sans lui, un anneau court qui ne rendait qu'une
   * direction (Auxerre, 33 m) faisait quand même demander les trois vagues
   * jusqu'à 15 km — l'inverse exact de ce que le responsable produit a tranché le jour
   * même.
   */
  readonly escalationBoundM: number;
}

export interface AxisStageInput {
  readonly stop: GeoPoint;
  readonly source: AxisSourcePort | null;
  readonly params: AxisStageParams;
  readonly now?: () => number;
}

/**
 * Ce que la recherche a déjà établi au moment où le budget expire.
 *
 * Objet PARTAGÉ, muté par `search()` au fil de sa boucle — c'est la seule
 * façon de le lire depuis `onExpiry()` : `work` reste en vol dans sa propre
 * fermeture, et Node ne permet pas d'inspecter une promesse abandonnée.
 */
interface StageProgress {
  best: AxisRingAttempt | null;
  probes: AxisRingProbe[];
}

/** L'étage entier. Ne lève jamais : un échec devient un motif. */
export async function runAxisStage(input: AxisStageInput): Promise<AxisSearch> {
  const clock = input.now ?? ((): number => Date.now());
  const startedAt = clock();
  const fetch: Mutable<AxisFetchReport> = {
    radiiM: [],
    axisSegments: 0,
    localSegments: 0,
    truncated: false,
    ms: 0,
    wallMs: 0,
    queries: 0,
  };

  if (input.source === null) {
    return empty(input.params, fetch, 'no_source', clock() - startedAt);
  }

  const progress: StageProgress = { best: null, probes: [] };
  const work = search(input, fetch, clock, startedAt, progress);
  // Si le budget gagne la course, l'échec éventuel de la recherche restée en
  // vol n'a plus d'appelant : on le marque comme traité ici, sinon Node le
  // remonte en « unhandled rejection » longtemps après le run.
  void work.catch(() => undefined);
  try {
    return await raceBudget(work, input.params.stageTimeoutMs, () => {
      fetch.wallMs = clock() - startedAt;
      // LE MEILLEUR ANNEAU DÉJÀ TROUVÉ N'EST PLUS JETÉ : ce qu'on a
      // mesuré avant le budget vaut mieux que rien (principe 5). `progress`
      // porte ce que la boucle en vol avait déjà établi au moment où le
      // minuteur a gagné.
      //
      // RELU LE 2026-09-14 — `fetch` ET `progress.probes` restent MUTÉS par
      // `search()`, resté en vol : Node n'annule aucune promesse abandonnée,
      // et rien ne l'empêche de continuer à écrire dans ces deux objets
      // PARTAGÉS après que ce minuteur a déjà rendu un résultat. `full.ts`
      // sérialise l'analyse à CHAQUE poll (l'API (hors instantané)) : sans
      // copie ici, un run déjà `complete` continuerait de changer sous les
      // yeux d'un client qui le relit. On COPIE donc les deux avant de les
      // publier — `fetch` (un objet muté champ par champ) et `probes` (un
      // tableau muté par `push`) — pour que ce qui a été RENDU reste figé,
      // quoi que fasse la recherche abandonnée ensuite.
      const publishedFetch: Mutable<AxisFetchReport> = { ...fetch };
      const publishedProbes = [...progress.probes];
      return progress.best === null
        ? empty(input.params, publishedFetch, 'timeout', publishedFetch.wallMs, publishedProbes)
        : assemble({
            stage: input.params,
            best: progress.best,
            reason: 'timeout',
            boundedByPrinciple34: false,
            fetch: publishedFetch,
            probes: publishedProbes,
            costMs: publishedFetch.wallMs,
          });
    });
  } catch {
    fetch.wallMs = clock() - startedAt;
    return empty(input.params, fetch, 'fetch_failed', fetch.wallMs);
  }
}

/**
 * Le travail, ou le budget — le premier des deux qui répond.
 *
 * Le minuteur est TOUJOURS annulé : un étage rapide ne doit pas laisser un
 * `setTimeout` tenir la boucle d'événements ouverte pendant le reste du budget.
 */
async function raceBudget(
  work: Promise<AxisSearch>,
  budgetMs: number,
  onExpiry: () => AxisSearch,
): Promise<AxisSearch> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<AxisSearch>((resolve) => {
    timer = setTimeout(() => resolve(onExpiry()), budgetMs);
  });
  try {
    return await Promise.race([work, expiry]);
  } finally {
    clearTimeout(timer);
  }
}


async function search(
  input: AxisStageInput,
  fetch: Mutable<AxisFetchReport>,
  clock: () => number,
  startedAt: number,
  progress: StageProgress,
): Promise<AxisSearch> {
  const { params, stop } = input;
  const source = input.source as AxisSourcePort;
  const outcome = await sweepAll({
    params,
    stop,
    waves: new AxisWaves({ source, stop, params, report: fetch, clock }),
    pool: new LocalWayPool({ source, stop, params, report: fetch, clock }),
    progress,
  });

  fetch.wallMs = clock() - startedAt;
  const { best, probes } = progress;
  if (best === null) return empty(params, fetch, 'no_axis_within_max', fetch.wallMs, probes);
  return assemble({
    stage: params,
    best,
    reason: outcome.reason,
    boundedByPrinciple34: outcome.boundedByPrinciple34,
    fetch,
    probes,
    costMs: fetch.wallMs,
  });
}

/** Ce que l'étage a sous la main pendant qu'il cherche. */
interface SearchContext {
  readonly params: AxisStageParams;
  readonly stop: GeoPoint;
  readonly waves: AxisWaves;
  readonly pool: LocalWayPool;
  readonly progress: StageProgress;
}

/** La fenêtre d'anneaux d'un temps, et les rayons de requête qui la couvrent. */
interface RingWindow {
  /** Anneau à partir duquel on sonde, EXCLU — ce qu'un temps précédent a déjà couvert. */
  readonly fromM: number;
  /** Dernier anneau de la fenêtre, INCLUS. */
  readonly toM: number;
  readonly radiiM: readonly number[];
}

/**
 * LES TROIS TEMPS DE L'ÉTAGE, dans cet ordre — c'est le principe 34 en entier
 * (2026-09-14 au soir).
 *
 *  1. **Le cercle, sur le réseau structurant** (importance 2–3), jusqu'à
 *     `escalationBoundM` (2 000 m, la valeur de `gates.searchRadiusM`). C'est
 *     là que le principe 34 veut l'ancre : « le premier point du réseau
 *     structurant rencontré en remontant du point de livraison ».
 * 2. **La classe 4 SUR LE CERCLE** — Décision produit, sur
 *     Thairé : les routes qui comptent y sont des importance 4 (D203E5, D113),
 *     et l'étage partait à 5 km poser quatre portes à 4,7–5,0 km, toutes dans
 *     la même approche. Ce temps ne parcourt AUCUN anneau : il regarde la
 *     bande `minReachM` – `escalationBoundM` (1 800–2 000 m) et rien d'autre,
 *     parce qu'une ancre de classe 4 se pose sur le cercle et jamais plus près
 *     (principe 7 ; `axes-band.ts`). Motif `ring_class4` quand elle suffit.
 *  3. **L'escalade** (5, 10, 15 km) sur le réseau structurant — et seulement
 *     si NI le cercle en 2–3 NI la bande en classe 4 n'ont rendu une seule
 *     porte retenue. C'est le garde-fou du principe 34, devenu une fenêtre
 *     d'anneaux plutôt qu'un drapeau dans la boucle : « si on trouve une
 *     départementale à moins de 2 km je vois mal l'intérêt d'aller chercher
 *     plus loin. »
 *
 * CE QUE ÇA COÛTE, nommé : une adresse dont le cercle ne donne pas le compte
 * paie UNE requête d'axes de plus (la classe 4 sur le cercle) et PAS UNE SEULE
 * requête de rues locales — une porte de bande n'est pas une jonction, elle
 * n'a besoin d'aucune rue locale. Les vagues d'axes déjà demandées ne le sont
 * jamais deux fois (`AxisWaves`), et les rues locales pas davantage
 * (`LocalWayPool`) — le temps 3 relit donc la vague de 5 000 m sans la
 * redemander.
 */
async function sweepAll(
  ctx: SearchContext,
): Promise<{ readonly reason: AxisSearchReason; readonly boundedByPrinciple34: boolean }> {
  const { params } = ctx;
  // L'AUTRE RÈGLE, EN SILENCE : l'ancrage à l'échelle du
  // lieu. Une seule boucle d'anneaux, une ancre par axe et par côté, pas de
  // bande de classe 4. Tout est dans `axes-scale.ts` ; ici on ne fait que la
  // brancher sur les mêmes vagues et le même pool.
  if ((params.selection ?? DEFAULT_AXIS_SELECTION) === 'axes') return sweepScale(ctx);

  const bound = params.escalationBoundM;
  const structuring = axisPassOf(params, params.importanceMax);

  const circle = await sweep(ctx, structuring, { fromM: 0, toM: bound, radiiM: params.fetchRadiiM });
  if (circle.qualified) return { reason: 'ring_reached', boundedByPrinciple34: false };

  const band = await sweepBand(ctx);
  if (band.qualified) return { reason: 'ring_class4', boundedByPrinciple34: true };

  // Une porte sur le cercle, même seule, vaut mieux qu'une ancre à 5 km :
  // l'escalade ne sert que quand le cercle n'a RIEN rendu, en 2–3 comme en 4.
  if (circle.retainedAny || band.retainedAny) {
    return { reason: 'best_ring_kept', boundedByPrinciple34: true };
  }

  const beyond = await sweep(ctx, structuring, {
    fromM: bound,
    toM: Number.POSITIVE_INFINITY,
    radiiM: params.fetchRadiiM,
  });
  return {
    reason: beyond.qualified ? 'ring_reached' : 'best_ring_kept',
    boundedByPrinciple34: false,
  };
}

/**
 * L'ANCRAGE À L'ÉCHELLE DU LIEU, branché.
 *
 * L'étage ne fait ici que fournir à `axes-scale.ts` ce qu'il sait faire et que
 * la règle n'a pas à savoir : les vagues d'axes mémoïsées, le pool cumulatif de
 * rues locales, et la comptabilité des anneaux sondés. La règle elle-même — une
 * ancre par axe et par côté, l'arrêt à deux directions, l'anneau de plus pour
 * la moitié vide — vit là-bas, avec les mots du responsable produit qui l'ont tranchée.
 *
 * `boundedByPrinciple34` garde son sens : « on ne cherche pas plus loin parce
 * que le lieu a répondu ». Vrai quand la recherche s'est arrêtée par choix,
 * faux quand les anneaux ont été épuisés jusqu'à 15 km.
 */
async function sweepScale(
  ctx: SearchContext,
): Promise<{ readonly reason: AxisSearchReason; readonly boundedByPrinciple34: boolean }> {
  const { params, progress } = ctx;
  const outcome = await sweepByScale({
    stop: ctx.stop,
    ringsM: params.ringsM,
    fetchRadiiM: params.fetchRadiiM,
    pass: axisPassOf(params, params.importanceMax),
    sectorCount: params.sectorCount,
    gateCount: params.gateCount,
    minReachM: params.minReachM,
    minGateDirections: params.minGateDirections,
    minDirectionSeparationDeg: params.minDirectionSeparationDeg,
    waveAt: async (radiusM) =>
      ctx.waves.at(radiusM, { min: params.importanceMin, max: params.importanceMax }),
    localWaysFor: async (axes, ringM, fetchRadiusM) => ctx.pool.forRing(axes, ringM, fetchRadiusM),
    // le sauvetage BUG-045, dans ce mode seulement (`axes-rescue.ts`).
    rescueWays: async (points, radiusM) => ctx.pool.rescueAt(points, radiusM),
    // La même comptabilité que les anneaux de l'autre mode : un anneau sans
    // aucun axe est PUBLIÉ (on a regardé, principe 1) mais ne peut pas devenir
    // « le meilleur anneau » — il n'y a rien à y retenir.
    record: (attempt) => {
      progress.probes.push(probeOf(attempt));
      if (attempt.axes.length > 0) progress.best = betterRing(attempt, progress.best);
    },
  });
  return {
    reason: outcome.qualified ? 'ring_reached' : 'best_ring_kept',
    boundedByPrinciple34: outcome.stoppedEarly,
  };
}

/**
 * LE DEUXIÈME TEMPS : les portes de classe 4 sur le cercle.
 *
 * Une requête d'axes (la classe 4 au rayon du cercle), aucune requête de rues
 * locales, un seul « anneau » sondé — la bande. La règle elle-même vit dans
 * `axes-band.ts` ; ici on ne fait que la brancher sur la même comptabilité que
 * les anneaux (`ringProbes`, `betterRing`), pour que l'étage n'ait qu'une seule
 * notion de « meilleur anneau ».
 */
async function sweepBand(
  ctx: SearchContext,
): Promise<{ readonly qualified: boolean; readonly retainedAny: boolean }> {
  const { params, progress } = ctx;
  if (params.circleFallbackImportanceMax <= params.importanceMax) {
    return { qualified: false, retainedAny: false };
  }
  // LA CLASSE QUE LE PREMIER TEMPS A REFUSÉE, et elle seule : les axes 2–3 ont
  // déjà été regardés dans le cercle, avec leurs jonctions. Les reprendre ici
  // serait une SECONDE règle sur les mêmes objets, et le motif cesserait de
  // dire ce qu'il dit. Une requête plus étroite, aussi : à Thairé la BD TOPO
  // rend les mêmes 190 tronçons, ailleurs elle en rend moins.
  const wave = await ctx.waves.at(params.escalationBoundM, {
    min: params.importanceMax + 1,
    max: params.circleFallbackImportanceMax,
  });
  const attempt = probeBand({
    stop: ctx.stop,
    network: wave.network,
    axisWays: wave.axisWays,
    ringsM: params.ringsM,
    bandFromM: params.minReachM,
    bandToM: params.escalationBoundM,
    sectorCount: params.sectorCount,
    gateCount: params.gateCount,
    minDirectionSeparationDeg: params.minDirectionSeparationDeg,
    minReachM: params.minReachM,
    importanceMax: params.circleFallbackImportanceMax,
  });
  progress.probes.push(probeOf(attempt));
  if (attempt.axes.length === 0) return { qualified: false, retainedAny: false };

  const qualified = attempt.directions.length >= params.minGateDirections;
  progress.best = qualified ? attempt : betterRing(attempt, progress.best);
  return { qualified, retainedAny: attempt.selection.retained.length > 0 };
}

/** Un temps : ses vagues, ses anneaux, et ce qu'ils ont rendu. */
async function sweep(
  ctx: SearchContext,
  pass: AxisPass,
  window: RingWindow,
): Promise<{ readonly qualified: boolean; readonly retainedAny: boolean }> {
  const { params, progress } = ctx;
  let retainedAny = false;

  for (const radiusM of window.radiiM) {
    // Une vague qui ne descend pas plus loin que ce qu'un temps précédent a
    // déjà sondé n'a aucun anneau à offrir à celui-ci.
    if (radiusM <= window.fromM) continue;
    const wave = await ctx.waves.at(radiusM, {
      min: params.importanceMin,
      max: pass.importanceMax,
    });
    const round = await searchRingsForDirections({
      stop: ctx.stop,
      network: wave.network,
      axisWays: wave.axisWays,
      ringsM: params.ringsM,
      fetchRadiusM: radiusM,
      pass,
      sectorCount: params.sectorCount,
      gateCount: params.gateCount,
      minReachM: params.minReachM,
      minGateDirections: params.minGateDirections,
      minDirectionSeparationDeg: params.minDirectionSeparationDeg,
      fromRingM: window.fromM,
      toRingM: window.toM,
      localWaysFor: async (axes, ringM) => ctx.pool.forRing(axes, ringM, radiusM),
    });
    progress.probes.push(...round.probes);
    if (round.best !== null) progress.best = betterRing(round.best, progress.best);
    if (round.retainedAny) retainedAny = true;
    if (round.qualified) {
      progress.best = round.best;
      return { qualified: true, retainedAny: true };
    }
    // La fenêtre est couverte : demander plus large n'y ajouterait aucun anneau.
    if (radiusM >= window.toM) break;
  }
  return { qualified: false, retainedAny };
}
