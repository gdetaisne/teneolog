/**
 * ce que la phase 2 a fait de son temps, et dans quel ordre.
 *
 * Décision produit : « on n'est pas à 1 seconde près… surtout ne baissons
 * pas en qualité, c'est clairement la qualité qui prime. Analyser les
 * itinéraires en partant de l'endroit le plus risqué (destination) et
 * prioriser les itinéraires qui paraissent les plus certains ; ça doit
 * impacter l'organisation des lots de 4 ou 8 qui partent en concurrence. »
 *
 * Tout ce qui suit est **additif** : aucun verdict, aucun point, aucune ancre
 * n'en dépend tant que `phase2.stopBetweenBatches` et
 * `phase2.commonRefusalStops` sont à false. C'est un compte rendu — l'ordre
 * dans lequel les jambes sont parties, ce que le tronc commun portait, et ce
 * qu'un arrêt aurait coupé — et le test d'or de `packages/pipeline` le juge :
 * `FullAnalysis` doit être identique à ce champ près.
 */
import type { GeoPoint } from './geo.js';
import type { CriticalPoint } from './point.js';
import type { Verdict } from './verdict.js';

/**
 * Le tronc commun : la portion que TOUTES les jambes partagent, mesurée
 * depuis le point de livraison vers l'extérieur.
 *
 * Définition, volontairement simple (§2 de la tâche) : on oriente chaque
 * jambe vers l'extérieur (une entrante est retournée), on prend la plus courte
 * comme référence, et le tronc est le plus long préfixe sur lequel toutes les
 * autres restent à moins de `toleranceM` de la référence. Il vaut souvent
 * quelques dizaines de mètres — la rue de livraison — et zéro dès que deux
 * jambes abordent l'adresse par des côtés opposés. Ce n'est pas un défaut :
 * c'est la mesure honnête de ce qui est vraiment commun.
 *
 * Ce qu'il achète : les points qui y tombent sont sur le chemin de tout le
 * monde. Un NON sur le tronc commun est un NON pour l'adresse, sans charger
 * un seul corridor de plus (`phase2.commonRefusalStops`).
 */
export interface CommonTrunk {
  /** Longueur du tronc, en mètres, depuis le point de livraison. */
  readonly lengthM: number;
  /** La ligne du tronc, orientée du point de livraison vers l'extérieur. */
  readonly polyline: readonly GeoPoint[];
  /** Les points de passage qui y tombent — ceux que toute jambe traverse. */
  readonly points: readonly CriticalPoint[];
  /** Le pire verdict de ces points pour CE camion. Null quand il n'y en a aucun. */
  readonly worstVerdict: Verdict | null;
  /** Combien de jambes le tronc a été mesuré sur. */
  readonly legsCompared: number;
}

/**
 * Une jambe, ses trois indices de certitude a priori, et son rang.
 *
 * Les trois indices sont **gratuits** : ils se lisent sur le tracé qu'OSRM
 * vient de rendre et sur le réseau structurant que R0 a déjà chargé. Aucun
 * appel réseau, aucun corridor — c'est tout l'intérêt : ils servent à décider
 * dans quel ordre payer les corridors.
 */
export interface LegPriority {
  readonly id: string;
  readonly direction: 'in' | 'out';
  /** Virages serrés du tracé : angle > `minTurnDeg` entre tronçons consécutifs de ≥ `minSegmentM`. */
  readonly sharpTurns: number;
  /** Classe de la voie d'origine, 0 = autoroute … 5 = unclassified, 9 = inconnue. */
  readonly highwayRank: number;
  /** Longueur hors réseau structurant, en mètres — après le dernier sommet structurant connu. */
  readonly offStructuringM: number;
  readonly lengthM: number;
  /** Rang dans l'ordre de départ, 1 = premier corridor chargé. */
  readonly rank: number;
  /** Lot de concurrence, 1 = le premier lot de `candidates.maxConcurrentFetches`. */
  readonly batch: number;
}

/**
 * Une jambe dont le corridor n'a pas été chargé, et pourquoi.
 *
 * **Rien n'est sauté en silence.** L'onglet Itinéraires les montre avec la
 * mention « pas nécessaire — explorer davantage » : l'opérateur qui, lui, a
 * une raison de douter doit pouvoir le demander.
 */
export interface SkippedLeg {
  readonly id: string;
  readonly direction: 'in' | 'out';
  /**
   * `not_needed` : un plan déjà contrôlé est OK avec la marge de confort et
   * sans question — charger la suite ne pouvait plus rien changer.
   * `common_refusal` : un point du tronc commun refuse ce camion, donc toutes
   * les jambes refusent.
   */
  readonly reason: 'not_needed' | 'common_refusal';
  /** Le rang qu'elle avait dans l'ordre de départ — ce qu'on a renoncé à payer. */
  readonly priority: number;
}

/** Ce que le cache de voies par tuile a coûté et évité. */
export interface WayTileCost {
  /** Tuiles de graphe chargées — une fois chacune, pour toute l'adresse. */
  readonly tilesLoaded: number;
  /** Corridors assemblés depuis ces tuiles — ce qu'il aurait fallu de requêtes sans le cache. */
  readonly corridorsBuilt: number;
  /** Voies distinctes tenues en mémoire, toutes tuiles confondues. */
  readonly waysHeld: number;
  /** Tuiles servies depuis le cache sans requête — le recouvrement, en clair. */
  readonly tileHits: number;
  readonly ms: number;
  /**
   * tuiles relues après un premier échec (`phase2.wayTiles.retryMissingTiles`).
   *
   * Optionnel : un instantané écrit avant la tâche ne le porte pas, et une
   * absence n'est pas « zéro » (principe 14).
   */
  readonly tilesRetried?: number;
  /** tuiles restées muettes après la relecture : le corridor le dira. */
  readonly tilesFailed?: number;
}

/**
 * Le compte rendu de la phase 2 — additif, jamais lu par un verdict tant que
 * les deux drapeaux sont baissés.
 */
export interface Phase2Plan {
  readonly commonTrunk: CommonTrunk | null;
  /** Les jambes dans l'ordre où leurs corridors sont partis. */
  readonly legOrder: readonly LegPriority[];
  /** Les jambes dont le corridor n'a pas été chargé. Vide drapeaux baissés. */
  readonly skippedLegs: readonly SkippedLeg[];
  /** L'état des deux drapeaux au moment du run, pour que la vue ne devine pas. */
  readonly stopBetweenBatches: boolean;
  readonly commonRefusalStops: boolean;
  /**
   * Le lot après lequel l'arrêt a coupé, 1-based. Null quand rien n'a coupé —
   * ce qui est le cas de tout run drapeaux baissés.
   */
  readonly stoppedAfterBatch: number | null;
  readonly tiles: WayTileCost | null;
  /** Mur de la phase 2, en millisecondes, tel que l'orchestration l'a vécu. */
  readonly durationMs: number;
}
