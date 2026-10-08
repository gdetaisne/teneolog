/**
 * L'ANCRAGE À L'ÉCHELLE DU LIEU : ce que fait un humain.
 *
 * Décision produit, sur la fiabilité de l'ancrage :
 *
 * > « oublie départementale, il y a de tout là-dedans. Par contre imp 2-3 c'est
 * >   fiable. »
 * > « l'outil devant être hyper fiable je pense qu'il faut trouver importance
 * >   2-3 les plus proches de tous les côtés, dans la limite de 15 km. Avec une
 * >   règle du type "ok j'ai déjà 2 ancres bien distinctes à 5 km, pas besoin
 * >   d'aller chercher à 15 km". Par contre si user écarte les deux ancres par
 * >   la suite, il faut être prêt à élargir. »
 * > « comment pouvons-nous faire ça de manière vraiment intelligente. En fait
 * >   il faut reproduire ce que fait un humain… Bordeaux on va chercher à 500 m
 * >   instinctivement. »
 *
 * CINQ RÈGLES, et rien d'autre. Elles ne remplacent QUE le choix ; le réseau
 * (`axes-network.ts`), les jonctions et leurs six filtres (`axes-gates.ts`) et
 * le compte des directions (`distinctDirections`, `axes-geometry.ts`) sont ceux
 * du 2026-09-14, au bit près — c'est ce qui rend l'A/B lisible.
 *
 *  1. **L'échelle du lieu.** Les anneaux ne changent pas (`ringsM` : 50, 250,
 *     500, 2 000, 5 000, 10 000, 15 000 m). Le PREMIER anneau où le réseau
 *     fiable (importance 2–3) rend une porte fixe l'échelle : Bordeaux 500 m,
 *     Thairé 5 km. Personne ne décide de l'échelle à l'avance.
 *  2. **Une ancre par AXE fiable, par côté** — jamais une par secteur de 30°.
 *     Pour chaque axe, la porte retenue est la jonction axe × rue locale LA
 *     PLUS PRÈS de l'adresse. Un même axe ne donne une seconde porte que si
 *     leurs azimuts sont séparés d'au moins `minDirectionSeparationDeg` (60°) :
 *     une rocade qui passe au nord et à l'ouest, c'est deux approches. Deux
 *     axes DIFFÉRENTS du même côté (< 60°) sont deux approches quand même —
 *     deux routes, deux façons d'arriver — donc deux ancres, mais UNE seule
 *     direction pour le critère d'arrêt.
 *  3. **L'arrêt.** On s'arrête au premier anneau qui donne au moins deux ancres
 *     dans deux directions distinctes (`minGateDirections`,
 *     `distinctDirections`). Puis, si toutes les ancres tiennent dans une
 *     moitié de cercle, on sonde UN anneau de plus POUR LA MOITIÉ VIDE
 *     SEULEMENT, et on s'arrête là quoi qu'il rende. Un anneau qui ne rend
 *     qu'une direction donne droit au même anneau de plus ; s'il n'apporte pas
 *     de seconde direction, on s'arrête avec ce qu'on a (`best_ring_kept`, et
 *     l'écran dit « une seule approche fiable sous X km »). **Jamais 15 km
 *     d'emblée** : l'élargissement à la demande — « si user écarte les deux
 * ancres par la suite, il faut être prêt à élargir » — est.
 *  4. **Pas de bande de classe 4.** « oublie départementale, il y a de tout
 *     là-dedans » : en mode `axes`, `circleFallbackImportanceMax` est sans
 *     effet, il n'y a ni bande ni motif `ring_class4`. `gateCount` reste le
 *     nombre maximal d'ancres servies, les plus proches d'abord ; ce qui est
 *     trouvé au-delà est PUBLIÉ, non retenu (`slots_full`), pour que
 * l'élargissement ait de quoi servir.
 *  5. **Ce qui manque est dit** (principe 1, en échange du principe 34) : les
 *     arcs sans ancre fiable et jusqu'où on a regardé (`uncoveredArcsOf`,
 *     publié dans `AxisSearch.uncoveredArcs`).
 *
 * EN SILENCE (principes 17 et 22) : `gates.axes.selection` vaut `sectors` par
 * défaut, et ce module ne tourne que quand la policy dit `axes`. Date de
 * décision dans la note de conception interne
 */
import type {
  AxisCorridor,
  AxisGate,
  AxisSelectionMode,
  GeoPoint,
  UncoveredArc,
} from '@teneolog/domain';
import { bearingDeltaDeg, haversineM, type RoadWay } from '@teneolog/topology';

import type { AxisWave } from './axes-fetch.js';
import { GATE_SITE_DEDUPE_M } from './axes-gates.js';
import { normaliseDeg } from './axes-geometry.js';
import type { AxisPass } from './axes-pass.js';
import { RESCUE_RADIUS_M, rescuePointsOf } from './axes-rescue.js';
import { probeRing, type AxisRingAttempt } from './axes-rings.js';
import { decideSelection, type AxisSelection } from './axes-select.js';

/** La valeur livrée de `gates.axes.selection` : la règle du 2026-09-14. */
export const DEFAULT_AXIS_SELECTION: AxisSelectionMode = 'sectors';

// ------------------------------------------------------- une ancre par axe --

export interface ScaleSelectionRule {
  readonly gateCount: number;
  /** L'écart sous lequel deux portes DU MÊME AXE sont la même sortie (60°). */
  readonly minDirectionSeparationDeg: number;
  readonly minReachM: number;
  /**
   * L'anneau de plus ne complète que la moitié vide : tout ce qu'il rapporte
   * ailleurs est publié avec le motif `outside_empty_half`, jamais retenu.
   * Absent, toutes les portes concourent.
   */
  readonly eligible?: (gate: AxisGate) => boolean;
}

/**
 * UNE ANCRE PAR AXE FIABLE, PAR CÔTÉ — la plus près de l'adresse d'abord.
 *
 * L'ordre est celui de la distance croissante, comme la sélection par secteurs
 * (`selectAxisGates`) : le principe 34 veut le premier point du réseau
 * structurant rencontré en remontant du point de livraison. Ce qui change est
 * QUI bloque qui — plus un quota de secteur, mais l'axe lui-même :
 *
 *  - une porte dont l'axe porte déjà une porte retenue à moins de
 *    `minDirectionSeparationDeg` est LA MÊME SORTIE (`axis_direction_taken`) ;
 *  - une porte d'un AUTRE axe est une autre approche — deux routes, deux
 *    façons d'arriver —, SAUF au même carrefour : à moins de
 *    `GATE_SITE_DEDUPE_M` (35 m) d'une porte déjà retenue, quel que soit son
 * axe, c'est le même point d'entrée (`same_site`). Décision produit,
 *    sur Clamart, où deux axes qui se croisent donnaient deux ancres au même
 *    point : « deux ancres à moins de 35 m l'une de l'autre n'en font qu'une »
 *    (« 1 oui »). Le nombre est celui de l'engine, qui ne l'applique qu'au sein
 *    d'un même axe (`dedupe`, `axes-gates.ts`) ; l'étendre aux axes croisés
 *    est l'écart au principe 29 validé ce jour-là ;
 *  - au-delà de `gateCount`, tout est publié non retenu (`slots_full`) : c'est
 * la matière de l'élargissement à la demande.
 *
 * L'ÉCART D'AZIMUT SE MESURE EN AZIMUTS, pas en bacs de 30° — exactement comme
 * `spreadByAzimuth` le fait déjà pour les portes de bande (`axes-select.ts`,
 * 2026-09-14) : une frontière de bac sépare deux portes à 2° d'écart, et deux
 * portes à 11° d'écart tombent dans le même bac. `distinctDirections` reste le
 * SEUL juge de ce qui COMPTE pour une direction (principe 23) ; ici on ne
 * décide pas d'une direction, on décide si deux portes sont la même sortie du
 * même axe.
 */
export function selectScaleGates(
  gates: readonly AxisGate[],
  rule: ScaleSelectionRule,
): AxisSelection {
  const ordered = [...gates].sort((a, b) => a.distanceM - b.distanceM || a.id.localeCompare(b.id));
  const chosen = new Map<string, number>();
  const blocked = new Map<string, string>();
  const keptByAxis = new Map<string, number[]>();
  const keptSites: GeoPoint[] = [];

  for (const gate of ordered) {
    if (rule.eligible !== undefined && !rule.eligible(gate)) {
      blocked.set(gate.id, 'outside_empty_half');
      continue;
    }
    const held = keptByAxis.get(gate.axisId) ?? [];
    if (keptSites.some((site) => haversineM(site, gate.at) <= GATE_SITE_DEDUPE_M)) {
      blocked.set(gate.id, 'same_site');
      // L'axe fusionné EST servi dans cette direction, par l'ancre du même
      // carrefour : sans cette ligne, la jonction suivante du même axe, 64 m
      // plus loin et du même côté, redevenait son ancre — le doublon de
      // Clamart revenu par la porte d'à côté (relecture du 2026-09-30).
      keptByAxis.set(gate.axisId, [...held, gate.azimuthDeg]);
      continue;
    }
    const sameExit = held.some(
      (azimuthDeg) => bearingDeltaDeg(azimuthDeg, gate.azimuthDeg) < rule.minDirectionSeparationDeg,
    );
    if (sameExit) {
      blocked.set(gate.id, 'axis_direction_taken');
      continue;
    }
    if (chosen.size >= rule.gateCount) {
      blocked.set(gate.id, 'slots_full');
      continue;
    }
    chosen.set(gate.id, chosen.size + 1);
    keptByAxis.set(gate.axisId, [...held, gate.azimuthDeg]);
    keptSites.push(gate.at);
  }

  return decideSelection(ordered, chosen, blocked, rule.minReachM);
}

// ------------------------------------------------------ la moitié de cercle --

/** Un arc d'azimuts, parcouru dans le sens des azimuts croissants. */
export interface AzimuthArc {
  readonly fromDeg: number;
  readonly toDeg: number;
  readonly widthDeg: number;
}

/**
 * LA MOITIÉ DE CERCLE QUE PERSONNE N'OCCUPE, ou `null` quand il n'y en a pas.
 *
 * « si toutes les ancres trouvées tiennent dans une moitié de cercle (un arc de
 * 180°), on sonde UN anneau de plus pour la moitié vide seulement. » Les ancres
 * tiennent dans une moitié EXACTEMENT quand le plus grand vide d'azimut entre
 * deux d'entre elles dépasse 180° ; la moitié vide est alors celle qui est
 * centrée sur ce vide. **Strictement plus de 180°** : deux ancres exactement
 * opposées (nord et sud) ne laissent AUCUNE moitié vide — les deux moitiés
 * possibles ont une ancre à chaque bout.
 *
 * Aucun nombre nouveau : 180° est « une moitié de cercle », les mots de
 * Le responsable produit, et 90° de part et d'autre du centre du vide en est la moitié.
 */
export function emptyHalfOf(azimuths: readonly number[]): AzimuthArc | null {
  const gap = widestGapOf(azimuths);
  if (gap === null || gap.widthDeg <= 180) return null;
  const centre = normaliseDeg(gap.fromDeg + gap.widthDeg / 2);
  return { fromDeg: normaliseDeg(centre - 90), toDeg: normaliseDeg(centre + 90), widthDeg: 180 };
}

/** Vrai quand l'azimut tombe dans l'arc, bornes comprises. */
export function inArc(azimuthDeg: number, arc: AzimuthArc): boolean {
  return forwardDeg(arc.fromDeg, azimuthDeg) <= arc.widthDeg;
}

/**
 * LES ARCS SANS ANCRE FIABLE — ce que l'écran doit pouvoir écrire.
 *
 * Un arc est un vide entre deux ancres retenues CONSÉCUTIVES en azimut, plus
 * large que `minSeparationDeg` : en deçà, les deux ancres qui le bordent sont
 * déjà la même approche, et il n'y a rien à dire. Aucune ancre : le cercle
 * entier. Une seule : le cercle entier aussi, borné des deux côtés par elle —
 * `widthDeg` à 360 le dit sans ambiguïté.
 */
export function uncoveredArcsOf(
  azimuths: readonly number[],
  searchedToM: number,
  minSeparationDeg: number,
): readonly UncoveredArc[] {
  const sorted = [...new Set(azimuths.map(normaliseDeg))].sort((a, b) => a - b);
  const whole = sorted[0];
  if (whole === undefined) return [arcOf(0, 0, 360, searchedToM)];
  if (sorted.length === 1) return [arcOf(whole, whole, 360, searchedToM)];

  const out: UncoveredArc[] = [];
  for (let i = 0; i < sorted.length; i += 1) {
    const from = sorted[i] as number;
    const to = sorted[(i + 1) % sorted.length] as number;
    const widthDeg = forwardDeg(from, to);
    if (widthDeg > minSeparationDeg) out.push(arcOf(from, to, widthDeg, searchedToM));
  }
  return out;
}

function arcOf(fromDeg: number, toDeg: number, widthDeg: number, searchedToM: number): UncoveredArc {
  return {
    fromDeg: round1(fromDeg),
    toDeg: round1(toDeg),
    widthDeg: round1(widthDeg),
    searchedToM,
  };
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Le plus grand vide d'azimut entre deux ancres consécutives, en tournant. */
function widestGapOf(azimuths: readonly number[]): AzimuthArc | null {
  const sorted = [...new Set(azimuths.map(normaliseDeg))].sort((a, b) => a - b);
  const only = sorted[0];
  if (only === undefined) return null;
  if (sorted.length === 1) return { fromDeg: only, toDeg: only, widthDeg: 360 };

  let widest: AzimuthArc | null = null;
  for (let i = 0; i < sorted.length; i += 1) {
    const from = sorted[i] as number;
    const to = sorted[(i + 1) % sorted.length] as number;
    const widthDeg = forwardDeg(from, to);
    if (widest === null || widthDeg > widest.widthDeg) widest = { fromDeg: from, toDeg: to, widthDeg };
  }
  return widest;
}

/** Degrés à parcourir de `from` vers `to` dans le sens des azimuts croissants. */
function forwardDeg(from: number, to: number): number {
  return normaliseDeg(to - from);
}

// ------------------------------------------------------------- la recherche --

/** Un anneau, et le rayon de requête qui le couvre. */
export interface ScaleStep {
  readonly ringM: number;
  readonly fetchRadiusM: number;
}

export interface ScaleSweepInput {
  readonly stop: GeoPoint;
  readonly ringsM: readonly number[];
  readonly fetchRadiiM: readonly number[];
  readonly pass: AxisPass;
  readonly sectorCount: number;
  readonly gateCount: number;
  readonly minReachM: number;
  readonly minGateDirections: number;
  readonly minDirectionSeparationDeg: number;
  /** La vague d'axes d'un rayon de requête — mémoïsée par l'étage. */
  readonly waveAt: (radiusM: number) => Promise<AxisWave>;
  /** Le pool cumulatif de rues locales de l'étage. */
  readonly localWaysFor: (
    axes: readonly AxisCorridor[],
    ringM: number,
    fetchRadiusM: number,
  ) => Promise<readonly RoadWay[]>;
  /** Ce que l'étage fait d'un anneau sondé : le publier, et garder le meilleur. */
  readonly record: (attempt: AxisRingAttempt) => void;
  /**
   * LES DISQUES DE SAUVETAGE BUG-045, demandés au pool de
   * l'étage (`LocalWayPool.rescueAt`) ; rend le nombre de rues locales
   * nouvelles. Absent, aucun sauvetage : les cas de laboratoire qui ne le
   * jugent pas n'en dépendent pas.
   */
  readonly rescueWays?: (points: readonly GeoPoint[], radiusM: number) => Promise<number>;
}

export interface ScaleSweepOutcome {
  /** Vrai quand un anneau a rendu le compte de directions demandé. */
  readonly qualified: boolean;
  /** Le plus grand anneau réellement sondé — « rien de fiable là sous X mètres ». */
  readonly searchedToM: number;
  /**
   * Vrai quand la recherche s'est arrêtée PAR CHOIX avant les 15 km : l'échelle
   * du lieu a répondu. Faux quand les anneaux ont été épuisés sans rien rendre.
   */
  readonly stoppedEarly: boolean;
}

/**
 * LES ANNEAUX, DU PLUS COURT AU PLUS LONG, jusqu'à ce que l'échelle du lieu
 * réponde.
 *
 * Une seule boucle, et pas les trois temps de la règle de secteurs : il n'y a
 * plus ni bande de classe 4 ni fenêtre d'anneaux à découper, seulement des
 * anneaux et une règle d'arrêt. Chaque anneau est sondé EXACTEMENT comme dans
 * l'autre mode (`probeRing`) : ce qui change est `select`.
 */
export async function sweepByScale(input: ScaleSweepInput): Promise<ScaleSweepOutcome> {
  const steps = scaleSteps(input.ringsM, input.fetchRadiiM);
  let searchedToM = 0;

  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i] as ScaleStep;
    searchedToM = step.ringM;
    const attempt = await probeStep(input, step, null);
    input.record(attempt);

    const retained = attempt.selection.retained;
    if (retained.length === 0) continue;

    const next = steps[i + 1];
    const enough = attempt.directions.length >= input.minGateDirections;
    if (next === undefined) return { qualified: enough, searchedToM, stoppedEarly: false };

    if (enough) {
      // Deux directions : c'est fini — sauf si tout tient dans une moitié de
      // cercle, auquel cas UN anneau de plus, pour la moitié vide seulement.
      const half = emptyHalfOf(retained.map((gate) => gate.azimuthDeg));
      if (half === null) return { qualified: true, searchedToM, stoppedEarly: true };
      const kept = new Set(retained.map((gate) => gate.id));
      const completed = await probeStep(input, next, {
        eligible: (gate) => kept.has(gate.id) || inArc(gate.azimuthDeg, half),
      });
      input.record(completed);
      return { qualified: true, searchedToM: next.ringM, stoppedEarly: true };
    }

    // Une seule direction : UN anneau de plus, et on s'arrête là quoi qu'il
    // rende — jamais 15 km d'emblée (l'élargissement à la demande est ).
    const more = await probeStep(input, next, null);
    input.record(more);
    return {
      qualified: more.directions.length >= input.minGateDirections,
      searchedToM: next.ringM,
      stoppedEarly: true,
    };
  }

  return { qualified: false, searchedToM, stoppedEarly: false };
}

/** Un anneau sondé sous la règle de l'échelle du lieu. */
async function probeStep(
  input: ScaleSweepInput,
  step: ScaleStep,
  restriction: { readonly eligible: (gate: AxisGate) => boolean } | null,
): Promise<AxisRingAttempt> {
  const wave = await input.waveAt(step.fetchRadiusM);
  const { rescueWays } = input;
  const rescue =
    rescueWays === undefined
      ? {}
      : {
          rescue: async (axes: readonly AxisCorridor[], gates: readonly AxisGate[]): Promise<boolean> =>
            (await rescueWays(rescuePointsOf(axes, wave.axisWays, gates, input.stop), RESCUE_RADIUS_M)) > 0,
        };
  return probeRing(
    {
      stop: input.stop,
      network: wave.network,
      axisWays: wave.axisWays,
      ringsM: input.ringsM,
      fetchRadiusM: step.fetchRadiusM,
      pass: input.pass,
      sectorCount: input.sectorCount,
      gateCount: input.gateCount,
      minReachM: input.minReachM,
      minGateDirections: input.minGateDirections,
      minDirectionSeparationDeg: input.minDirectionSeparationDeg,
      fromRingM: 0,
      toRingM: step.ringM,
      localWaysFor: async (axes, ringM) => input.localWaysFor(axes, ringM, step.fetchRadiusM),
      ...rescue,
      select: (gates) =>
        selectScaleGates(gates, {
          gateCount: input.gateCount,
          minDirectionSeparationDeg: input.minDirectionSeparationDeg,
          minReachM: input.minReachM,
          ...(restriction === null ? {} : { eligible: restriction.eligible }),
        }),
    },
    step.ringM,
  );
}

/**
 * Chaque anneau avec le rayon de requête qui le couvre : le plus petit de
 * `fetchRadiiM` qui l'atteint, le plus grand faute de mieux.
 *
 * C'est la même comptabilité que les trois vagues de la règle de secteurs (un
 * anneau n'a de données que si une vague au moins aussi large a été demandée),
 * écrite une fois pour toutes au lieu d'être portée par une boucle de fenêtres.
 * Les vagues sont mémoïsées par l'étage : deux anneaux du même rayon ne
 * coûtent qu'une requête.
 */
export function scaleSteps(
  ringsM: readonly number[],
  fetchRadiiM: readonly number[],
): readonly ScaleStep[] {
  const radii = [...fetchRadiiM].sort((a, b) => a - b);
  const largest = radii[radii.length - 1];
  if (largest === undefined) return [];
  return [...new Set(ringsM)]
    .sort((a, b) => a - b)
    .map((ringM) => ({ ringM, fetchRadiusM: radii.find((r) => r >= ringM) ?? largest }));
}
