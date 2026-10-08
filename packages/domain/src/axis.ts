/**
 * l'étage « axes » de S3 : les ancres posées sur le réseau BD TOPO.
 *
 * PORTAGE DEPUIS L'ENGINE (principe 29). La règle décrite ici est celle de
 * `teneolog-engine/l'API (hors instantané) :
 * `bdtopo-anchor-reliability.ts` (les anneaux et les classes d'importance),
 * `axis-diagnostics.ts` + `phase1-segment-diagnostics/*` (12 secteurs de 30°,
 * la découverte par rencontres), `axis-gate-discovery/*` (les portes sur les
 * axes) et `itinerary-selection.ts` (la répartition par secteurs). Ce qui
 * change et pourquoi est écrit dans la note de conception interne
 *
 * POURQUOI UN ÉTAGE À CÔTÉ ET NON UNE RÈGLE REMPLACÉE. La sélection R0
 * (`packages/routes/src/gates.ts`) choisit un RAYON : elle prend les sommets
 * les plus lointains du voisinage, et comme le voisinage rend les voies
 * entières dès qu'elles touchent le cercle, les cinq ancres finissent à
 * 1 943–1 999 m dans les deux villes mesurées (fiche S3 §H1). La classe ne
 * pèse rien (§H2), les égalités se tranchent sur l'identifiant OSM (§H3), et
 * une ancre monopolise une demi-direction (§H4). L'étage « axes » répond à
 * ces quatre défauts par la question de l'engine : quel RÉSEAU structurant
 * entoure l'adresse, et par où le quitte-t-on ?
 *
 * EN SILENCE (principe 17 et 22). `gates.axes.enabled = false` : l'étage est
 * calculé, publié dans `GateSearch.axes`, et aucune ancre, aucun itinéraire,
 * aucun verdict ne bouge. la note de conception interne porte sa date de décision.
 */
import type { GeoPoint } from './geo.js';

/**
 * Pourquoi la recherche d'axes s'est arrêtée là.
 *
 * `ring_reached` : un anneau a rendu assez de DIRECTIONS DE PORTES RETENUES
 * (`gates.axes.minGateDirections`), c'est lui qui fixe le rayon de l'étage.
 * `ring_class4` (2026-09-14, soir) : aucun anneau du cercle de 2 000 m ne
 * donnait le compte avec le réseau structurant (importance 2–3), et ce sont
 * les axes d'importance 4 qui COUPENT LA BANDE `gates.minReachM` –
 * `gates.searchRadiusM` (1 800–2 000 m) qui l'ont donné, AVANT toute escalade.
 * C'est Thairé : la D203E5 et la D113 sont des 4, et l'étage partait chercher à
 * 5 km quatre portes toutes dans la même approche. **Une porte de classe 4 se
 * pose SUR LE CERCLE, jamais plus près** : c'est le principe 7 (« l'ancre reste
 * le point à 2 km ; toute l'approche est contrôlée »), et c'est l'écart écrit
 * du principe 34 — importance 2–3 = premier point rencontré ; importance 4 = au
 * cercle, jamais plus près.
 * `best_ring_kept` : aucun anneau, jusqu'à 15 km, n'a offert le compte demandé
 * — on garde le meilleur anneau atteint plutôt que rien, parce qu'une
 * direction vaut mieux que zéro (principe 5), et le motif le DIT au lieu de
 * laisser croire que le critère a été rempli. `no_axis_within_max` : aucun axe
 * d'importance suffisante jusqu'au dernier anneau — un inconnu n'est jamais un
 * refus (principe 5), la sélection R0 reste, et l'écran le dit. `no_source` : la
 * BD TOPO n'est pas branchée sur ce serveur ; ce n'est pas « aucun axe »,
 * c'est « on n'a pas regardé ». `fetch_failed` : la source a répondu par une
 * erreur ou s'est tue au-delà du budget d'UNE requête. `timeout` : le budget
 * de TOUT l'étage (`gates.axes.stageTimeoutMs`) est épuisé — l'étage rend la
 * main pour que le run se termine, la requête restée en vol finit d'elle-même
 * sur son `statement_timeout`, et ce qu'elle rapportera n'est lu par personne.
 */
/**
 * LES DEUX RÈGLES DE SÉLECTION D'UNE ANCRE, et laquelle
 * a servi (`gates.axes.selection`).
 *
 * `sectors` — la règle livrée le 2026-09-14 : douze secteurs fixes de 30°,
 * quota 1 puis 2 puis 3, et la classe 4 SUR LE CERCLE quand le réseau
 * structurant ne donne pas le compte sous 2 km.
 *
 * `axes` — la règle que le responsable produit a tranchée le 2026-09-15, EN SILENCE en
 * attendant son A/B : « il faut reproduire ce que fait un humain… Bordeaux on
 * va chercher à 500 m instinctivement. » Une ancre par AXE fiable et par côté,
 * l'arrêt au premier anneau qui rend deux ancres dans deux directions, un
 * anneau de plus pour la moitié vide, et plus de bande de classe 4 —
 * « oublie départementale, il y a de tout là-dedans. Par contre imp 2-3 c'est
 * fiable. »
 */
export type AxisSelectionMode = 'sectors' | 'axes';

export type AxisSearchReason =
  | 'ring_reached'
  | 'ring_class4'
  | 'best_ring_kept'
  | 'no_axis_within_max'
  | 'no_source'
  | 'fetch_failed'
  | 'timeout';

/**
 * Ce que la sélection finale a servi.
 *
 * `axes` : les ancres de l'étage ont remplacé celles de R0 (drapeau levé, et
 * l'étage a trouvé quelque chose). `r0_silent` : le drapeau est baissé, R0
 * sert, l'étage est une lecture. `r0_no_axis` / `r0_no_gate` : le drapeau est
 * levé mais l'étage n'a rien à servir — aucun axe, ou des axes sans porte —
 * donc R0 reste le repli, nommé plutôt que tu.
 *
 * `r0_timeout` (2026-09-14) — le budget de l'étage
 * (`gates.axes.stageTimeoutMs`) a expiré avant qu'un anneau soit JUGÉ, même
 * quand le meilleur anneau déjà trouvé portait déjà des portes retenues. Un
 * étage inachevé n'est pas une décision (principe 5) : ce meilleur anneau
 * reste PUBLIÉ (`AxisSearch.axes`, `.gates`, `.retained`, lisibles dans
 * l'onglet), mais jamais SERVI — sinon `gatesOf` (`gate-stage.ts`) livrerait
 * un ancrage que la recherche n'a pas fini de juger, parfois sur une seule
 * direction. Distinct de `r0_no_axis` / `r0_no_gate`, qui disent une absence
 * établie ; `r0_timeout` dit un inconnu (« on n'a pas fini de regarder »).
 */
export type AxisFallback = 'axes' | 'r0_silent' | 'r0_no_axis' | 'r0_no_gate' | 'r0_timeout';

/**
 * Un axe retenu : un morceau de réseau structurant continu, vu depuis
 * l'adresse dans un secteur donné.
 *
 * C'est la « rencontre » (`encounter`) de l'engine : un tronçon-graine et
 * tous les tronçons de MÊME importance qui le prolongent (moins de 60 m entre
 * deux sommets, orientation non orientée à moins de 45°, et à moins d'un
 * demi-rayon le long de l'axe). Un axe, pas un tronçon : la D113 coupée en
 * onze morceaux par la BD TOPO est un seul axe.
 */
export interface AxisCorridor {
  readonly id: string;
  /** La nature BD TOPO du tronçon représentatif, ou son identifiant faute de mieux. */
  readonly label: string;
  /** Importance BD TOPO de l'axe (toutes ses pièces la partagent). */
  readonly importance: number;
  readonly wayIds: readonly string[];
  /** Le secteur de 30° d'où l'axe a été découvert (0 = [0°, 30°[ depuis le nord). */
  readonly sector: number;
  /** L'anneau auquel la graine est apparue — d'où l'axe vient, pas où il s'arrête. */
  readonly discoveryRingM: number;
  /** Distance de l'arrêt au point le plus proche de l'axe. */
  readonly closestDistanceM: number;
  /** Azimut de l'arrêt vers ce point le plus proche. */
  readonly azimuthDeg: number;
  /** Orientation de l'axe lui-même, du premier au dernier sommet de sa plus longue corde. */
  readonly axisBearingDeg: number;
  /** La plus longue corde de l'axe à l'intérieur du cercle — ce qu'on dessine. */
  readonly geometry: readonly GeoPoint[];
}

/**
 * Une porte sur un axe : là où une rue locale quitte le réseau structurant.
 *
 * `at` est la jonction SUR l'axe ; `inward` est le point à 20 m sur la branche
 * locale, du côté de l'adresse — c'est de là que le routeur part, exactement
 * comme `gateRoutingPoint` de l'engine. Router depuis la jonction elle-même
 * fait passer OSRM sur l'axe et lui fait faire demi-tour (BUG-065 de l'engine).
 */
export interface AxisGate {
  /**
   * `axis:<axisWayId>+<localWayId>` pour une JONCTION,
   * `axis:<axisWayId>@<secteur>` pour une PORTE DE BANDE — stable d'un run à
   * l'autre dans les deux cas.
   */
  readonly id: string;
  readonly at: GeoPoint;
  readonly inward: GeoPoint;
  readonly axisId: string;
  readonly axisWayId: string;
  /**
   * La rue locale par laquelle on quitte l'axe — `null` pour une PORTE DE
   * BANDE (2026-09-14, soir).
   *
   * Une porte de classe 4 n'est pas une jonction : c'est le sommet de l'axe le
   * plus lointain DANS LA BANDE `gates.minReachM` – `gates.searchRadiusM`,
   * exactement la règle de R0 (`measureVertices`, `gates.ts`) réduite à la
   * classe 4. Aucune rue locale n'y entre, donc rien à nommer ici — et un
   * identifiant fabriqué (l'axe recopié en rue locale) serait un fait faux.
   */
  readonly localWayId: string | null;
  readonly label: string;
  readonly importance: number;
  /** L'importance de la rue locale, `null` pour une porte de bande (pas de rue locale). */
  readonly localImportance: number | null;
  readonly azimuthDeg: number;
  readonly distanceM: number;
  readonly sector: number;
  /** Rang de la sélection finale, 1 = première retenue. Null quand la porte n'est pas retenue. */
  readonly rank: number | null;
  /**
   * Ce qu'il faut savoir de cette porte, retenue ou non.
   *
   * Non retenue : `sector_full` (son secteur avait déjà son quota) ou
   * `slots_full` (`gateCount` portes étaient déjà prises). Retenue mais posée
   * sous le cercle de `gates.minReachM` :
   * `approach_uncontrolled_beyond_gate` — voir `uncontrolledBeyondM`.
   */
  readonly reasonCodes: readonly string[];
  /**
   * PRINCIPE 34 — les mètres d'approche que cette porte laisse HORS ÉTUDE.
   *
   * `gates.minReachM − distanceM`, positif, quand la porte est plus près que le
   * cercle que R0 et la découverte imposent à leurs jambes. Null au-delà du
   * cercle : il n'y a rien à dire.
   *
   * Décision produit : « si on trouve une départementale (importance 2-3)
   * à moins de 2 km je vois mal l'intérêt d'aller chercher plus loin ». La
   * porte est donc bien la bonne — et ce que le principe 1 exige en échange,
   * c'est que l'écran DISE ce qui n'est pas contrôlé, jamais qu'il le taise.
   * Le plancher reste la règle des jambes R0 et découvertes (/415);
   * il ne s'applique pas aux portes du réseau structurant.
   */
  readonly uncontrolledBeyondM: number | null;
}

/**
 * PRINCIPE 34 — une approche que personne n'étudiera, nommée.
 *
 * Une ligne par porte retenue posée sous `gates.minReachM` : de quoi écrire
 * « porte à 33 m : l'approche par cet axe d'importance 2 sur 1 967 m ne sera
 * pas étudiée ». Vide quand l'étage est éteint ou quand toutes les portes
 * atteignent le cercle.
 */
export interface UncontrolledApproach {
  readonly gateId: string;
  /** Le nom de l'axe, tel que l'onglet doit l'écrire. */
  readonly axisLabel: string;
  readonly importance: number;
  /** Distance de l'arrêt à la porte. */
  readonly gateDistanceM: number;
  /** Les mètres entre la porte et le cercle, que rien ne contrôlera. */
  readonly uncontrolledM: number;
  /** Le cercle lui-même (`gates.minReachM`), pour que la phrase se relise seule. */
  readonly minReachM: number;
}

/**
 * Une jonction axe × rue locale qui n'a pas passé les filtres.
 *
 * Une ligne par tentative refusée, avec TOUS ses motifs : l'engine les
 * accumule au lieu de s'arrêter au premier, et c'est ce qui permet de lire
 * « refusée pour trois raisons » plutôt que « refusée ».
 */
export interface AxisGateRejected {
  readonly axisWayId: string;
  /** `null` quand le refus ne porte sur aucune rue locale — voir `axis_short_of_ring_band`. */
  readonly localWayId: string | null;
  readonly at: GeoPoint;
  /** Distance de la jonction à l'arrêt. Null quand la jonction n'a pas pu être posée. */
  readonly distanceM: number | null;
  /** Vocabulaire fermé — voir `AXIS_GATE_REJECTIONS`. */
  readonly reasons: readonly string[];
}

/** Pourquoi une jonction n'est pas une porte — le vocabulaire de l'engine, mot pour mot. */
export const AXIS_GATE_REJECTIONS = [
  /** Le bout de la rue locale est à plus de `maxEndpointGapM` de l'axe : elle ne le rejoint pas. */
  'endpoint_too_far_from_axis',
  /** Aucun sommet de la rue locale n'est assez loin du bout pour donner une direction. */
  'no_local_point_away_from_junction',
  /** La branche suit l'axe au lieu de le quitter (moins de `minLeaveAxisDeg`). */
  'branch_parallel_to_axis',
  /** La branche part du côté de l'axe opposé à l'adresse. */
  'branch_wrong_side_of_axis',
  /** La corde jonction → adresse traverse un AUTRE axe retenu : la porte est derrière une porte. */
  'chord_crosses_retained_axis',
  /** La jonction est au-delà du rayon de l'étage (marge de 20 %, comme l'engine). */
  'beyond_search_radius',
  /** La rue locale interdit le gabarit de référence (privée, tonnage, hauteur, largeur). */
  'legal_incompatible',
  /** Loin de l'adresse, la rue locale est un chemin, un sentier, ou trop étroite. */
  'road_quality_rejected',
  /**
   * l'axe de classe 4 ne COUPE PAS la bande
   * `gates.minReachM` – `gates.searchRadiusM` : il s'arrête avant le cercle,
   * donc il ne peut pas porter d'ancre (principe 7). Le seul motif qui ne
   * parle pas d'une rue locale : `localWayId` y est `null`.
   */
  'axis_short_of_ring_band',
] as const;

/** Ce qu'on note sur une porte RETENUE — le vocabulaire fermé de `AxisGate.reasonCodes`. */
export const AXIS_GATE_NOTES = [
  /** Son secteur avait atteint son quota au tour où on l'a regardée. */
  'sector_full',
  /** Les `gateCount` places étaient prises avant qu'on la regarde. */
  'slots_full',
  /** Retenue sous le cercle de `gates.minReachM` : l'approche au-delà n'est pas étudiée (principe 34). */
  'approach_uncontrolled_beyond_gate',
  /**
   * une autre porte DU MÊME AXE couvre
   * déjà cette direction, à moins de `minDirectionSeparationDeg`.
   *
   * « Une ancre par AXE fiable, par côté » : un même axe ne donne deux portes
   * que si leurs azimuts sont séparés d'au moins 60° — une rocade qui passe au
   * nord et à l'ouest, c'est deux approches ; deux sorties voisines de la même
   * départementale, c'est la même. Deux axes DIFFÉRENTS du même côté restent
   * deux ancres (deux routes = deux façons d'arriver) : ce motif ne les
   * concerne pas.
   */
  'axis_direction_taken',
  /**
   * trouvée à l'ANNEAU DE PLUS, hors de la
   * moitié vide qu'il servait à compléter.
   *
   * L'anneau supplémentaire ne sonde que la moitié de cercle qu'aucune ancre
   * n'occupe ; ce qu'il rapporte ailleurs est publié, jamais retenu — sinon
   * l'anneau de plus servirait à densifier une direction déjà tenue au lieu
   * d'en ouvrir une nouvelle.
   */
  'outside_empty_half',
  /**
   * une porte retenue d'un AUTRE axe est
   * déjà au même carrefour, à moins de 35 m (`GATE_SITE_DEDUPE_M`).
   *
   * Décision produit, sur Clamart — deux axes qui se croisent au même
   * carrefour donnaient deux ancres au même point, au mètre et au degré près :
   * « deux ancres à moins de 35 m l'une de l'autre n'en font qu'une » (« 1 oui »).
   * Deux routes qui se croisent au même endroit ne sont pas deux façons
   * d'arriver : c'est un seul point d'entrée. Le nombre est celui de l'engine
   * (`ANCHOR_SITE_DEDUPE_M`), qui ne l'applique qu'au sein d'un même axe ;
   * l'étendre aux axes croisés est l'écart au principe 29 validé ce jour-là.
   */
  'same_site',
] as const;

/**
 * CE QUI MANQUE : un arc du cercle où aucune ancre
 * fiable n'a été trouvée, et jusqu'où on a regardé.
 *
 * Le principe 1 en échange du principe 34 : l'écran doit pouvoir écrire « rien
 * de fiable à l'est sous 5 km » plutôt que de laisser croire que l'ancrage a
 * fait le tour. Un arc va de `fromDeg` à `toDeg` DANS LE SENS DES AZIMUTS
 * CROISSANTS (il peut passer par le nord), et ses deux bornes sont des ancres
 * retenues — sauf quand il n'y en a aucune, auquel cas l'arc est le cercle
 * entier. `widthDeg` lève l'ambiguïté du cas où une seule ancre borne l'arc des
 * deux côtés : `fromDeg === toDeg` et `widthDeg === 360`.
 */
export interface UncoveredArc {
  /** L'azimut où l'arc commence — une ancre retenue, ou 0 quand il n'y en a aucune. */
  readonly fromDeg: number;
  /** L'azimut où l'arc se referme, dans le sens des azimuts croissants. */
  readonly toDeg: number;
  /** La largeur de l'arc, en degrés — la seule lecture qui ne dépend pas du sens. */
  readonly widthDeg: number;
  /** Le plus grand anneau réellement sondé : « rien de fiable là sous X mètres ». */
  readonly searchedToM: number;
}

/**
 * Ce que l'étage a demandé aux données, et ce que ça a coûté.
 *
 * *Corrigé le 2026-09-14* — `ms` était écrasé par le mur total de l'étage
 * juste avant publication (`fetch.ms = clock() - startedAt` dans
 * `axes-stage.ts`), ce qui rendait le §9.3 du rapport invérifiable : le
 * temps SQL cumulé (ce que chaque requête a coûté, additionné) disparaissait
 * derrière le temps total (SQL + préparation du réseau, sélection par
 * secteurs, etc). Deux champs maintenant : `ms` garde son sens d'origine — la
 * somme des requêtes — et `wallMs` porte le mur, séparément.
 */
export interface AxisFetchReport {
  /** Les rayons successivement demandés, dans l'ordre. Le dernier est celui qui a servi. */
  readonly radiiM: readonly number[];
  /** Tronçons d'axe rendus par le dernier rayon. */
  readonly axisSegments: number;
  /** Tronçons locaux (importance 4–5) rendus. */
  readonly localSegments: number;
  /** Vrai quand une requête a rendu exactement son plafond de lignes : il en manque peut-être. */
  readonly truncated: boolean;
  /**
   * Le temps SQL CUMULÉ : la somme de ce que chaque requête a coûté, seule.
   * Depuis le sauvetage BUG-045 (2026-09-30), trois requêtes peuvent
   * tourner ensemble : leurs durées s'additionnent ici, et `ms` peut alors
   * DÉPASSER `wallMs`. C'est une charge sur la base, pas un temps d'attente.
   */
  readonly ms: number;
  /**
   * le MUR de l'étage entier : SQL, mais aussi la
   * préparation du réseau et la sélection par secteurs entre les requêtes.
   * C'est lui, et non `ms`, qui doit se comparer au mur mesuré du rapport
   * (§9.3, colonnes « étage »). ≥ `ms` tant que les requêtes sont en série —
   * le mode `sectors` ; pas en mode `axes`, où le sauvetage en lance trois à
   * la fois (voir `ms`).
   */
  readonly wallMs: number;
  readonly queries: number;
  /**
   * le sauvetage des jonctions tronquées (BUG-045 de
   * l'engine, `axes-rescue.ts`), en mode `axes` seulement : combien de disques
   * de 300 m ont été réellement demandés (déjà comptés dans `queries`), et
   * combien de rues locales ABSENTES du pool ils ont rapportées. Absent quand
   * le sauvetage n'a pas tourné.
   */
  readonly rescue?: { readonly queries: number; readonly newLocalWays: number };
}

/**
 * tout ce que l'étage « axes » a regardé, et ce qu'il propose.
 *
 * Additif à `GateSearch` : éteint, il ne change rien à `retained`, et le test
 * d'or de `packages/pipeline` le prouve.
 */
export interface AxisSearch {
  /** Le drapeau de policy tel qu'il a été lu — pas ce que l'étage a fait. */
  readonly enabled: boolean;
  /**
   * QUELLE RÈGLE A CHOISI LES ANCRES.
   *
   * `sectors` : la règle du 2026-09-14 — quotas par secteurs fixes de 30°,
   * classe 4 sur le cercle en repli. `axes` : la règle du 2026-09-15 — une
   * ancre par AXE fiable et par côté, l'arrêt à l'échelle du lieu, pas de
   * bande de classe 4. Publiée parce qu'un relevé qui ne dit pas de quelle
   * règle il parle ne se compare à rien (`gates.axes.selection`).
   */
  readonly selection: AxisSelectionMode;
  /**
   * Importance BD TOPO maximale d'un axe POUR LA PASSE QUI A SERVI.
   *
   * 3 dans le cas courant (l'engine dit 3 : autoroute 1 exclue, 2 et 3
   * gardées) ; **4 quand le cercle a répondu en classe 4** (`reason:
   * 'ring_class4'`, 2026-09-14 au soir) — c'est ce qui permet à l'onglet
   * d'écrire « portes de classe 4 sur le cercle, faute de 2–3 sous 2 km »
   * plutôt que de laisser croire que le réseau structurant a répondu. Quand
   * rien n'a été retenu, c'est la classe DEMANDÉE, la seule dont on puisse
   * dire quelque chose.
   */
  readonly importanceMax: number;
  readonly ringsM: readonly number[];
  readonly sectorCount: number;
  /**
   * LE CRITÈRE D'ARRÊT, tel qu'il a été demandé.
   *
   * Combien de DIRECTIONS DISTINCTES (secteurs de 30°) les PORTES RETENUES
   * doivent couvrir pour qu'un anneau suffise. Remplace `minSectorsCovered`,
   * qui comptait les secteurs des AXES trouvés : à Aigrefeuille, un seul
   * secteur d'axe portait cinq portes en quatre directions, et exiger deux
   * secteurs d'AXE y envoyait l'anneau à 5 km pour des ancres à 2,3–4,4 km
   * alors qu'un réseau structurant passe à moins de 2 km — l'inverse du
   * principe 34. Une règle, une clé (principe 23).
   */
  readonly minGateDirections: number;
  /**
   * L'ÉCART SOUS LEQUEL DEUX PORTES SONT LA MÊME
   * DIRECTION, tel qu'il a été demandé (`gates.axes.minDirectionSeparationDeg`,
   * 60°).
   *
   * Deux secteurs VOISINS ne sont pas deux directions : à Thairé, quatre
   * portes aux azimuts 290, 294, 305 et 307° (secteurs 9 et 10) satisfaisaient
   * le critère à deux directions alors qu'elles décrivent une seule approche.
   * La règle est dans `distinctDirections` (`packages/routes/src/axes-geometry.ts`).
   */
  readonly minDirectionSeparationDeg: number;
  /** L'anneau qui a suffi. Null quand aucun n'a suffi. */
  readonly reachedRingM: number | null;
  readonly reason: AxisSearchReason;
  /**
   * vrai quand `reason: 'best_ring_kept'`
   * s'arrête PARCE QUE le cercle de `escalationBoundM` (`gates.searchRadiusM`)
   * a déjà rendu au moins une porte retenue : l'escalade au-delà de 2 km n'a
   * pas eu lieu par choix, pas par épuisement des 15 km. Faux pour
   * `ring_reached` (aucun arrêt anticipé n'était nécessaire) et pour
   * `best_ring_kept` quand rien n'a jamais été trouvé sous 2 km — l'escalade
   * complète y est alors légitime (Thairé). Toujours faux pour les autres
   * motifs.
   */
  readonly boundedByPrinciple34: boolean;
  readonly fetch: AxisFetchReport;
  readonly axes: readonly AxisCorridor[];
  /** Les index de secteur couverts par au moins un axe, triés. */
  readonly sectorsCovered: readonly number[];
  /**
   * LE CÔTÉ MESURÉ DU CRITÈRE : une entrée par DIRECTION des portes
   * RETENUES. C'est lui qu'on compare à `minGateDirections`, et il n'a rien à
   * voir avec `sectorsCovered`, qui compte les axes.
   *
   * *Corrigé le 2026-09-14 au soir* : ce n'est plus « les secteurs distincts »
   * mais « un secteur par GROUPE de secteurs qui se touchent » — deux secteurs
   * voisins décrivent la même approche et ne comptent que pour une direction
   * (`minDirectionSeparationDeg`, 60°). Le secteur publié est le premier du
   * groupe ; ce que chaque porte a vraiment couvert reste lisible sur
   * `AxisGate.sector`, porte par porte.
   */
  readonly gateDirections: readonly number[];
  /** Toutes les portes trouvées, retenues ou non, dans l'ordre de la sélection. */
  readonly gates: readonly AxisGate[];
  /** Les portes retenues, par azimut — la forme de `GateSearch.retained`. */
  readonly retained: readonly AxisGate[];
  readonly rejected: readonly AxisGateRejected[];
  /**
   * PRINCIPE 34 — les approches que personne n'étudiera, une par porte retenue
   * posée sous `gates.minReachM`. Vide quand toutes atteignent le cercle.
   */
  readonly uncontrolled: readonly UncontrolledApproach[];
  /**
   * LES ARCS SANS ANCRE FIABLE, et jusqu'où on a
   * regardé. Vide quand les ancres retenues se répartissent sans laisser de
   * vide plus large que `minDirectionSeparationDeg`.
   */
  readonly uncoveredArcs: readonly UncoveredArc[];
  /** Ce qui a réellement servi d'ancres pour ce run. */
  readonly fallback: AxisFallback;
  /**
   * CE QUE LE CRITÈRE A COÛTÉ, anneau par anneau.
   *
   * Compter les directions des portes retenues oblige à faire tourner les
   * filtres de porte à CHAQUE anneau, et non une seule fois à la fin : c'est le
   * prix du bon critère, et il se lit ici plutôt que de se deviner. Une ligne
   * par anneau sondé, dans l'ordre ; la dernière est celle qui a servi quand le
   * motif est `ring_reached`.
   */
  readonly ringProbes: readonly AxisRingProbe[];
  readonly costMs: number;
}

/**
 * un anneau sondé : ce qu'il portait, et combien de directions il a
 * rendues.
 *
 * `directions` est le nombre de DIRECTIONS couvertes par les portes RETENUES à
 * cet anneau — des secteurs de 30° regroupés quand ils se touchent
 * (`minDirectionSeparationDeg`), et c'est le nombre que `minGateDirections`
 * compare.
 */
export interface AxisRingProbe {
  readonly ringM: number;
  /** Le rayon de requête sous lequel cet anneau a été sondé. */
  readonly fetchRadiusM: number;
  /**
   * la classe maximale d'axe de la PASSE qui a
   * sondé cet anneau : 3 pour le réseau structurant, 4 pour la passe « classe
   * 4 dans le cercle ». Sans elle, deux lignes du même anneau (50 m sondé deux
   * fois, une fois par passe) seraient illisibles.
   */
  readonly importanceMax: number;
  readonly axes: number;
  /** Portes trouvées, tous filtres passés, avant la sélection par secteurs. */
  readonly gatesFound: number;
  readonly gatesRetained: number;
  readonly directions: number;
}
