/**
 * S4 — QUELLE RUE ÉTROITE UNE AUTRE RÉPONSE COUVRE (principe 41).
 *
 * Décision produit, sur la Sèvremoine en prod : « si user valide un
 * virage, ça doit valider la largeur des rues entrantes et sortantes du virage.
 * […] on me demande successivement si le camion passe le virage, puis s'il peut
 * circuler dans la rue qui conduit au virage. Non-sens. » Puis le 2026-09-28 :
 * la réponse « Oui, ça passe » à la première question de l'adresse vaut aussi
 * pour les rues étroites de la RUE DE LIVRAISON.
 *
 * Ce module ne dit que la RELATION — quelle rue étroite est sur quel bras de
 * quel virage, laquelle est sur la rue de livraison — lue sur la jambe, avec les
 * plages et le découpage que S4 utilise déjà pour mesurer (`route-points.ts`) et
 * le dédoublonnage de la collecte (`sharedPointRef`). Il ne juge rien : ce qu'une
 * réponse en fait vit côté serveur (l'API (hors instantané)).
 *
 * Ce que la relation NE couvre PAS, et c'est voulu : une rue étroite plus loin
 * sur la jambe, hors des deux bras du virage ; une rue étroite dont un seul
 * segment sort des voies du bras, ou de la rue de livraison (la question porte
 * alors aussi sur une autre rue, et la réponse n'a rien dit de celle-là). La
 * collecte fusionne les segments étroits qui se suivent quelle que soit leur
 * voie : sans cette règle « tout entière », 30 m de rue d'entrée prêtaient la
 * réponse du virage à 600 m de ruelle posée avant elle (relecture du
 * 2026-09-28).
 */
import type { CriticalPoint, GeoPoint, PointRef, RouteCandidate } from '@teneolog/domain';

import { sharedPointRef } from './collect.js';
import { makePointRef } from './point-ref.js';
import {
  armSpanIndex,
  narrowRunsOf,
  nearestSegmentIndex,
  segmentSpans,
  type NarrowRun,
} from './route-points.js';

/** Les trois réglages de S4 que la relation relit — ceux de la collecte, pas d'autres. */
export interface NarrowCoverParams {
  readonly bearingOffsetM: number;
  readonly narrowMaxFreeM: number;
  readonly dedupeWithinM: number;
}

/** Un virage de la jambe tel qu'elle l'a mesuré : son apex et la longueur de sa manœuvre. */
export interface LegTurn {
  readonly ref: PointRef;
  readonly at: GeoPoint;
  readonly arcLengthM: number;
}

/**
 * Les segments de la jambe que le virage NOMME : la chaussée où il se fait (la
 * largeur d'entrée qu'il publie, `widthAtPoint`), la rue de sortie (sa largeur
 * de sortie, `exitArmWidth`) et la rue d'entrée, lue à la même distance en
 * amont — là où le détecteur lit le cap d'entrée.
 */
function turnArmSegments(
  candidate: RouteCandidate,
  spans: ReturnType<typeof segmentSpans>,
  turn: LegTurn,
  bearingOffsetM: number,
): ReadonlySet<number> {
  const arms = [
    nearestSegmentIndex(candidate, turn.at),
    armSpanIndex(candidate.polyline, spans, turn, bearingOffsetM, -1),
    armSpanIndex(candidate.polyline, spans, turn, bearingOffsetM, 1),
  ];
  return new Set(arms.filter((index): index is number => index !== null));
}

/**
 * Les VOIES que le virage nomme : celles de ses segments. Une voie de la rue de
 * livraison y amène toute la rue de livraison, parce que S0 a établi que ses
 * voies sont UNE chaussée coupée (`merged_into_retained`) — la Sèvremoine, où
 * BD TOPO coupe l'Allée en deux tronçons au carrefour latéral, 90 m après le
 * virage (TRONROUT0000000356360087 puis TRONROUT0000000011773098). Ailleurs,
 * rien ne dit que la voie suivante est la même rue : elle ne l'est pas.
 */
function turnArmWays(
  candidate: RouteCandidate,
  arms: ReadonlySet<number>,
  streetWays: ReadonlySet<string>,
): ReadonlySet<string> {
  const ways = new Set<string>();
  for (const index of arms) {
    const way = candidate.segments[index]?.segmentId;
    if (way !== undefined) ways.add(way);
  }
  if ([...ways].some((way) => streetWays.has(way))) for (const way of streetWays) ways.add(way);
  return ways;
}

/** Une rue étroite TOUT ENTIÈRE sur ces voies : pas un seul de ses segments ailleurs. */
function runOnWays(candidate: RouteCandidate, run: NarrowRun, wayIds: ReadonlySet<string>): boolean {
  return run.segmentIndices.every((index) => wayIds.has(candidate.segments[index]?.segmentId ?? ''));
}

/** Le ref que la collecte a donné à la rue étroite de CETTE jambe. */
function collectedNarrowRef(
  run: NarrowRun,
  collected: readonly CriticalPoint[],
  dedupeWithinM: number,
): PointRef {
  const own = { ref: makePointRef('NARROW', run.at), type: 'NARROW' as const, at: run.at };
  return sharedPointRef(collected, own, dedupeWithinM);
}

/**
 * Sur UNE jambe : pour chaque virage, les rues étroites que ses bras portent —
 * une rue étroite qui passe par l'un des segments que le virage nomme, ET dont
 * tous les segments sont sur les voies de ces segments (`turnArmWays`). Les
 * refs sont ceux du relevé (`collected`), ceux que le fil publie.
 * `streetWays` : les voies de la rue de livraison, telles que S0 les a fondues.
 */
export function narrowRefsOnTurnArms(
  candidate: RouteCandidate,
  turns: readonly LegTurn[],
  collected: readonly CriticalPoint[],
  params: NarrowCoverParams,
  streetWays: ReadonlySet<string> = new Set(),
): ReadonlyMap<PointRef, readonly PointRef[]> {
  const out = new Map<PointRef, PointRef[]>();
  if (turns.length === 0) return out;
  const runs = narrowRunsOf(candidate, params.narrowMaxFreeM);
  if (runs.length === 0) return out;
  const spans = segmentSpans(candidate);
  for (const turn of turns) {
    const arms = turnArmSegments(candidate, spans, turn, params.bearingOffsetM);
    const ways = turnArmWays(candidate, arms, streetWays);
    const covered = runs
      .filter((run) => run.segmentIndices.some((index) => arms.has(index)) && runOnWays(candidate, run, ways))
      .map((run) => collectedNarrowRef(run, collected, params.dedupeWithinM));
    if (covered.length > 0) out.set(turn.ref, [...new Set(covered)]);
  }
  return out;
}

/**
 * Sur UNE jambe : les rues étroites dont TOUS les segments sont sur les voies
 * données — la rue de livraison telle que S0 l'a retenue (la voie retenue et
 * les continuations qu'il y a fondues). Un seul segment ailleurs, et la
 * question parle d'une autre rue : elle reste posée.
 */
export function narrowRefsOnWays(
  candidate: RouteCandidate,
  wayIds: ReadonlySet<string>,
  collected: readonly CriticalPoint[],
  params: NarrowCoverParams,
): readonly PointRef[] {
  if (wayIds.size === 0) return [];
  const onWays = narrowRunsOf(candidate, params.narrowMaxFreeM).filter((run) => runOnWays(candidate, run, wayIds));
  return [...new Set(onWays.map((run) => collectedNarrowRef(run, collected, params.dedupeWithinM)))];
}
