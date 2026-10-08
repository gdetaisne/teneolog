/**
 * LE CRITÈRE D'ARRÊT : combien de DIRECTIONS DE PORTES un anneau
 * rend, et non combien de secteurs d'AXES il porte.
 *
 * CE QU'ON GARDE DE L'ENGINE (principe 29). `findFirstQualifyingRing`
 * (`semi-bdtopo-network-search/internal-helpers.ts`) parcourt les mêmes
 * anneaux, dans le même ordre, et s'arrête au premier qui rend **au moins un
 * candidat-ancre** — et un candidat-ancre, là-bas, est déjà une JONCTION du
 * réseau structurant (`selectSemiNetworkBdtopoAnchorCandidates` →
 * `selectStructuringLocalJunctionAnchors`, repli `buildPortalCandidatesForCorridor`),
 * pas un tronçon. La forme est donc celle de l'engine : on juge un anneau sur
 * ce qu'il donne d'ANCRES, pas sur ce qu'il touche de routes.
 *
 * CE QU'ON CHANGE, et c'est voulu et mesuré (rapport §9 et §12).
 *  1. **On compte les portes RETENUES**, celles qui ont passé les six filtres
 *     de `axes-gates.ts` ET la sélection par secteurs — pas les candidates.
 *     Une porte qui ne sera jamais servie ne prouve rien sur l'anneau.
 *  2. **On compte des DIRECTIONS distinctes**, pas des portes : cinq portes
 *     dans une seule direction ne testent le camion que par un côté. Et
 *     **deux secteurs VOISINS ne sont pas deux directions** (2026-09-14, soir,
 *     `distinctDirections` dans `axes-geometry.ts`) : il faut
 *     `gates.axes.minDirectionSeparationDeg` (60°, deux secteurs) entre elles.
 *  3. **Le seuil est 2, et non « au moins une »** (`gates.axes.minGateDirections`).
 *
 * POURQUOI PAS « ≥ n SECTEURS D'AXES », la règle de la première passe. Elle
 * comptait les secteurs des AXES trouvés. Mesuré le 2026-09-14 (rapport §8) :
 * à Aigrefeuille, UN seul secteur d'axe portait CINQ portes en QUATRE
 * directions entre 1 484 et 1 878 m — et exiger deux secteurs d'axe y
 * envoyait l'anneau à 5 km, pour des ancres à 2 258–4 389 m et 32 questions
 * au lieu de 22, alors qu'un réseau structurant passe à moins de 2 km. C'est
 * exactement l'inverse du principe 34. Une règle, une clé (principe 23) :
 * `minSectorsCovered` n'existe plus.
 *
 * CE QUE ÇA COÛTE, et c'est assumé : les filtres de porte tournent à CHAQUE
 * anneau, et non une seule fois à la fin. Le prix se lit plutôt qu'il ne se
 * devine (`AxisSearch.ringProbes`), et `gates.axes.stageTimeoutMs` reste le
 * plafond de tout l'étage.
 *
 * CE QUI N'EST PLUS ICI (2026-09-14, soir). Le garde-fou du principe 34 — « dès
 * qu'un anneau ≤ 2 km rend une porte retenue, on n'élargit plus » — était un
 * drapeau interne à cette boucle (`foundWithinCircle`). Il est devenu la
 * FENÊTRE D'ANNEAUX que l'étage passe ici (`fromRingM` / `toRingM`) : c'est
 * `axes-stage.ts` qui ordonne les trois temps (le cercle en 2–3, la classe 4
 * sur le cercle, puis l'escalade), et cette fonction ne fait plus que sonder la
 * fenêtre qu'on lui donne, de bas en haut, jusqu'au compte demandé. Une règle,
 * un endroit (principe 23) : le garde-fou et la passe classe 4 sont la même
 * décision — « le cercle d'abord » — et se lisent donc au même endroit.
 *
 * CE QUI N'A JAMAIS ÉTÉ ICI : la passe classe 4 elle-même. Elle ne parcourt
 * aucun anneau — elle regarde la BANDE `gates.minReachM` – `gates.searchRadiusM`
 * et rien d'autre (`axes-band.ts`), parce qu'une ancre de classe 4 se pose sur
 * le cercle et jamais plus près (principe 7). Elle rend le même
 * `AxisRingAttempt` pour que `betterRing` sache la comparer.
 */
import type { AxisCorridor, AxisGate, AxisRingProbe, GeoPoint } from '@teneolog/domain';
import type { RoadWay } from '@teneolog/topology';

import { distinctDirections } from './axes-geometry.js';
import { findAxisGates, type AxisGateResult } from './axes-gates.js';
import { findAxisCorridors, ringsUpTo, type AxisNetwork } from './axes-network.js';
import { inLocalRange, type AxisPass } from './axes-pass.js';
import { selectAxisGates, type AxisSelection } from './axes-select.js';

/** Un anneau sondé jusqu'au bout : ses axes, ses portes, et ses directions. */
export interface AxisRingAttempt {
  readonly ringM: number;
  readonly fetchRadiusM: number;
  /** La classe maximale d'axe de la passe qui a sondé cet anneau (2–3, ou 4 dans le cercle). */
  readonly importanceMax: number;
  readonly axes: readonly AxisCorridor[];
  readonly found: AxisGateResult;
  readonly selection: AxisSelection;
  /** Une entrée par DIRECTION des portes retenues — voir `distinctDirections`. */
  readonly directions: readonly number[];
}

export interface AxisRingSearchInput {
  readonly stop: GeoPoint;
  readonly network: AxisNetwork;
  /** Les tronçons d'axe du rayon courant, par identifiant. */
  readonly axisWays: ReadonlyMap<string, RoadWay>;
  readonly ringsM: readonly number[];
  /** Le rayon de requête sous lequel on sonde : il borne les anneaux. */
  readonly fetchRadiusM: number;
  /** La passe en cours : la classe des axes, et celle de leurs rues locales. */
  readonly pass: AxisPass;
  readonly sectorCount: number;
  readonly gateCount: number;
  readonly minReachM: number;
  readonly minGateDirections: number;
  /** L'écart d'azimut sous lequel deux portes sont la MÊME direction (60°). */
  readonly minDirectionSeparationDeg: number;
  /**
   * LA FENÊTRE D'ANNEAUX de cette passe — l'ordre des trois temps de l'étage
   * (`axes-stage.ts`) s'écrit ici. `fromRingM` est EXCLU (l'escalade reprend
   * au-delà du cercle sans resonder ce que le cercle a déjà sondé), `toRingM`
   * est INCLUS (le cercle de 2 000 m fait partie du cercle).
   */
  readonly fromRingM: number;
  readonly toRingM: number;
  /** Les rues locales disponibles pour cet anneau — le pool cumulatif de l'étage. */
  readonly localWaysFor: (
    axes: readonly AxisCorridor[],
    ringM: number,
  ) => Promise<readonly RoadWay[]>;
  /**
   * QUI CHOISIT, parmi les portes que les six filtres
   * ont laissées passer.
   *
   * Absent, c'est la règle de secteurs du 2026-09-14 (`selectAxisGates`). Le
   * mode `axes` passe la sienne (`axes-scale.ts`, une ancre par axe et par
   * côté) sans rien changer d'autre : le réseau, les jonctions et leurs six
   * filtres sont les mêmes des deux côtés, et c'est ce qui rend l'A/B lisible
   * — la seule variable est le CHOIX.
   */
  readonly select?: (gates: readonly AxisGate[]) => AxisSelection;
  /**
   * LE SAUVETAGE BUG-045 (`axes-rescue.ts`), mode `axes`
   * seulement. Reçoit les axes de l'anneau et les portes trouvées ; rend vrai
   * quand des rues locales NOUVELLES sont entrées dans le pool, et les
   * jonctions sont alors réévaluées une fois sur le pool enrichi. Absent — la
   * règle de secteurs —, rien ne change.
   */
  readonly rescue?: (axes: readonly AxisCorridor[], gates: readonly AxisGate[]) => Promise<boolean>;
}

export interface AxisRingSearchResult {
  /** Le meilleur anneau sondé dans cette fenêtre, ou `null` si aucun ne portait d'axe. */
  readonly best: AxisRingAttempt | null;
  /** Vrai quand `best` a atteint `minGateDirections` : la recherche peut s'arrêter. */
  readonly qualified: boolean;
  readonly probes: readonly AxisRingProbe[];
  /**
   * PRINCIPE 34 — vrai quand AU MOINS UN anneau de la fenêtre a rendu une
   * porte retenue. C'est ce que `axes-stage.ts` lit pour décider de ne plus
   * élargir au-delà du cercle : « si on trouve une départementale à moins de
   * 2 km je vois mal l'intérêt d'aller chercher plus loin » (le responsable produit).
   */
  readonly retainedAny: boolean;
}

/**
 * Les anneaux de la fenêtre, du plus court au plus long, jusqu'au premier qui
 * rend le compte de directions demandé.
 *
 * On ne s'arrête JAMAIS sur un anneau sans axe : il n'y a rien à y retenir, et
 * le principe 34 veut le premier point du réseau structurant, pas le premier
 * cercle vide.
 */
export async function searchRingsForDirections(
  input: AxisRingSearchInput,
): Promise<AxisRingSearchResult> {
  let best: AxisRingAttempt | null = null;
  let retainedAny = false;
  const probes: AxisRingProbe[] = [];

  for (const ringM of ringsUpTo(input.ringsM, input.fetchRadiusM)) {
    if (ringM <= input.fromRingM || ringM > input.toRingM) continue;
    const attempt = await probeRing(input, ringM);
    probes.push(probeOf(attempt));
    if (attempt.axes.length === 0) continue;
    best = betterRing(attempt, best);
    if (attempt.selection.retained.length > 0) retainedAny = true;
    if (attempt.directions.length >= input.minGateDirections) {
      return { best: attempt, qualified: true, probes, retainedAny: true };
    }
  }
  return { best, qualified: false, probes, retainedAny };
}

/**
 * Le meilleur des deux anneaux : le plus de directions d'abord, puis le plus de
 * portes retenues, puis LE PLUS COURT.
 *
 * Le dernier départage est le principe 34 : à égalité de ce que l'anneau
 * prouve, l'ancre la plus proche du point de livraison gagne. La classe de la
 * passe n'entre PAS dans la comparaison : la bande de classe 4 sur le cercle
 * vaut mieux qu'un anneau de classe 3 à 15 km, et c'est tout le principe 34.
 */
export function betterRing(
  attempt: AxisRingAttempt,
  held: AxisRingAttempt | null,
): AxisRingAttempt {
  if (held === null) return attempt;
  if (attempt.directions.length !== held.directions.length) {
    return attempt.directions.length > held.directions.length ? attempt : held;
  }
  const retained = attempt.selection.retained.length - held.selection.retained.length;
  if (retained !== 0) return retained > 0 ? attempt : held;
  return attempt.ringM < held.ringM ? attempt : held;
}

/**
 * Un anneau de bout en bout : ses axes, ses rues locales, ses portes, sa
 * sélection.
 *
 * Exportée depuis le mode `axes` a son propre critère d'arrêt
 * (`axes-scale.ts`) mais sonde un anneau EXACTEMENT de la même façon — le
 * réseau, les jonctions, les six filtres. Une seule source pour « ce qu'un
 * anneau porte » (principe 23) ; ce qui diffère est `select`, et rien d'autre.
 */
export async function probeRing(
  input: AxisRingSearchInput,
  ringM: number,
): Promise<AxisRingAttempt> {
  const axes = findAxisCorridors(input.network, ringM, input.ringsM);
  if (axes.length === 0) return emptyAttempt(ringM, input);

  let found = await gatesOfRing(input, axes, ringM);
  // une seule réévaluation : le sauvetage ne demande que
  // les bouts d'axe qu'aucune porte ne couvre, et l'engine ne le rejoue pas.
  if (input.rescue !== undefined && (await input.rescue(axes, found.gates))) {
    found = await gatesOfRing(input, axes, ringM);
  }
  const selection =
    input.select === undefined
      ? selectAxisGates(found.gates, input.gateCount, input.sectorCount, input.minReachM)
      : input.select(found.gates);
  return {
    ringM,
    fetchRadiusM: input.fetchRadiusM,
    importanceMax: input.pass.importanceMax,
    axes,
    found,
    selection,
    directions: directionsOf(selection, input),
  };
}

/** Les portes d'un anneau, sur tout ce que le pool de rues locales tient à cet instant. */
async function gatesOfRing(
  input: AxisRingSearchInput,
  axes: readonly AxisCorridor[],
  ringM: number,
): Promise<AxisGateResult> {
  // Le pool demande à la source les classes de l'étage (4–5) et ne les
  // redemande jamais ; c'est ICI que la passe ne garde que les siennes — la
  // classe 4 devenue AXE ne peut pas être en même temps la rue locale qui le
  // quitte. Une requête de moins, et la même règle (`axes-pass.ts`).
  const localWays = (await input.localWaysFor(axes, ringM)).filter((way) =>
    inLocalRange(input.pass, way.importance),
  );
  return findAxisGates({
    stop: input.stop,
    axes,
    axisWays: input.axisWays,
    localWays,
    radiusM: ringM,
    sectorCount: input.sectorCount,
  });
}

/**
 * Les DIRECTIONS des portes RETENUES — le nombre que le critère compare.
 *
 * Ce n'est plus « les secteurs distincts » depuis le 2026-09-14 au soir : deux
 * secteurs voisins sont la même approche (`distinctDirections`).
 */
export function directionsOf(
  selection: AxisSelection,
  rule: { readonly sectorCount: number; readonly minDirectionSeparationDeg: number },
): readonly number[] {
  return distinctDirections(
    selection.retained.map((gate) => gate.sector),
    rule.sectorCount,
    rule.minDirectionSeparationDeg,
  );
}

function emptyAttempt(ringM: number, input: AxisRingSearchInput): AxisRingAttempt {
  return {
    ringM,
    fetchRadiusM: input.fetchRadiusM,
    importanceMax: input.pass.importanceMax,
    axes: [],
    found: { gates: [], rejected: [] },
    selection: { gates: [], retained: [] },
    directions: [],
  };
}

/** La ligne publiée d'un anneau sondé. Exportée : la passe de bande en pousse une aussi. */
export function probeOf(attempt: AxisRingAttempt): AxisRingProbe {
  return {
    ringM: attempt.ringM,
    fetchRadiusM: attempt.fetchRadiusM,
    importanceMax: attempt.importanceMax,
    axes: attempt.axes.length,
    gatesFound: attempt.found.gates.length,
    gatesRetained: attempt.selection.retained.length,
    directions: attempt.directions.length,
  };
}
