/**
 * The legs of a run, as the MEASUREMENT leaves them.
 *
 * `pairs.ts` states the rule over legs and stays deliberately ignorant of what
 * a candidate is — the beta wire hands it legs built from human judgements
 * instead. This module is the other half for S5 alone: how a `RouteCandidate`
 * plus its measured verdicts become one leg.
 *
 * It exists because two callers inside S5 need those legs — the conclusion
 * (`project.ts`) and the ranking (`ranking.ts`) — and they must be the SAME
 * legs. Built twice, they would be two candidate sets that happen to agree
 * today: the ranking would sooner or later rank pairs the conclusion never
 * concluded over.
 */
import type { CandidateVerdict, PointRef, PointVerdict, RouteCandidate } from '@teneolog/domain';
import type { CollectedPoints } from '@teneolog/points';

import { SEVERITY, type PairLegInput } from './pairs.js';

/**
 * Ce que `verdictsPerLeg` (`project.ts`) mesure : un verdict par (jambe, lieu).
 *
 * Nommé ici plutôt qu'écrit quatre fois : la conclusion, le classement des
 * paires et celui des plans reçoivent tous le même objet, et c'est ce qui
 * garantit qu'ils lisent le même verdict au même endroit (principe 23).
 */
export type LegPointVerdicts = ReadonlyMap<string, ReadonlyMap<PointRef, PointVerdict>>;

/**
 * LE VERDICT D'UN LIEU SUR UNE JAMBE — la seule lecture, pour les trois
 * consommateurs de S5 (second volet).
 *
 * La conclusion lisait déjà la jambe (`perLeg`), le classement lisait encore le
 * pire de la place : au coin Exemple / Voisine 23 (Thairé), la grise tourne
 * de 57° dans 3,0 m déclarés — une INCONNUE — et la bleue de 98° dans 5,2 m
 * avec +1,04 m de marge. Le pire de la place prêtait l'inconnue de la grise à
 * la bleue, donc les deux premiers critères du principe 28 (verdict, puis
 * inconnues) ne voyaient plus de différence entre le plan qui passe et celui
 * qui ne passe pas — et `plans[0]`, le plan RETENU, se décidait sur la marge et
 * la distance.
 *
 * Le repli reste la lecture par lieu : une jambe qui porte une référence sans
 * géométrie propre (un instantané plus ancien, une fixture faite à la main)
 * garde le verdict du lieu plutôt que de perdre le point — une mesure absente
 * n'est pas une difficulté absente.
 */
export function legPointVerdictReader(
  pointVerdicts: readonly PointVerdict[],
  perLeg?: LegPointVerdicts,
): (candidateId: string, ref: PointRef) => PointVerdict | undefined {
  const byRef = new Map(pointVerdicts.map((pv) => [pv.pointRef, pv]));
  return (candidateId, ref) => perLeg?.get(candidateId)?.get(ref) ?? byRef.get(ref);
}

/**
 * `RunConclusion.legVerdicts` — la liste à plat que le run publie — réindexée
 * en (jambe → lieu).
 *
 * Écrite ici parce qu'un lecteur de run (le rejeu du fil,
 * l'API (hors instantané)) doit pouvoir poser au moteur la MÊME question
 * que le moteur se pose, sans réinventer l'index. Un `candidateId` nul — le
 * résumé par lieu, jamais une jambe — est ignoré.
 */
export function legPointVerdictsOf(legVerdicts: readonly PointVerdict[]): LegPointVerdicts {
  const out = new Map<string, Map<PointRef, PointVerdict>>();
  for (const verdict of legVerdicts) {
    if (verdict.candidateId === null) continue;
    const own = out.get(verdict.candidateId) ?? new Map<PointRef, PointVerdict>();
    own.set(verdict.pointRef, verdict);
    out.set(verdict.candidateId, own);
  }
  return out;
}

/**
 * LES LIEUX D'UN GROUPE DE JAMBES, CHACUN À SA LECTURE LA PLUS DURE — une
 * seule écriture pour les trois lecteurs.
 *
 * Un lieu partagé par deux jambes est UNE question : l'opérateur y répond une
 * fois, et c'est la plus dure des deux lectures qui la pose. Ce qu'on ne fait
 * PAS : demander à une jambe un lieu qu'elle ne traverse pas — la lecture
 * retomberait sur le pire de la place, c'est-à-dire sur le défaut que 
 * corrige.
 *
 * `refsOfLeg` et `readVerdict` sont injectés parce que les appelants n'ont pas
 * la même matière en main : le moteur a `CollectedPoints` et sa carte par
 * jambe, le rejeu a les points de ses jambes et `legVerdicts`.
 */
export function hardestPerPlace(
  legIds: readonly string[],
  refsOfLeg: (candidateId: string) => readonly PointRef[],
  readVerdict: (candidateId: string, ref: PointRef) => PointVerdict | undefined,
): readonly PointVerdict[] {
  const hardest = new Map<PointRef, PointVerdict>();
  for (const id of legIds) {
    for (const ref of refsOfLeg(id)) {
      const pv = readVerdict(id, ref);
      if (pv === undefined) continue;
      const held = hardest.get(ref);
      if (held === undefined || harderReading(pv, held)) hardest.set(ref, pv);
    }
  }
  return [...hardest.values()];
}

/**
 * Laquelle de deux lectures d'un même lieu est la plus dure — le verdict
 * d'abord, puis l'INCONNUE, puis la marge la plus serrée.
 *
 * L'inconnue avant la marge serrée, et délibérément (principe 28 : « il faut
 * prioriser les itinéraires avec aucune inconnue »). Une jambe qui n'a pas su
 * mesurer la largeur et une jambe qui a mesuré 0,20 m de jeu disent toutes deux
 * HUMAIN ; la première est le pire état, et `isUnknownDoubt` lit exactement
 * cette marge absente que le classement compte ensuite. Préférer la mesurée
 * ferait taire l'inconnue là où une jambe l'a vraiment.
 *
 * Exportée parce que deux lectures s'en servent : le pire de la place
 * (`worstPerPlace`, pour la revue et l'écran) et le pire des DEUX jambes d'un
 * plan (`measureLegPair`). Deux copies seraient deux définitions de « plus
 * dur ».
 */
export function harderReading(a: PointVerdict, b: PointVerdict): boolean {
  if (SEVERITY[a.verdict] !== SEVERITY[b.verdict]) return SEVERITY[a.verdict] > SEVERITY[b.verdict];
  if ((a.marginM === null) !== (b.marginM === null)) return a.marginM === null;
  return (a.marginM ?? 0) < (b.marginM ?? 0);
}

/**
 * One leg per candidate that carries a verdict, in the candidates' own order —
 * which is S3's order, and so the azimuth order of the anchors.
 *
 * A candidate with no verdict is dropped rather than defaulted: S5 measured
 * every candidate it was given, so a missing verdict is a caller error, not a
 * doubt to be folded into the answer.
 *
 * `perLeg` is how the leg's OWN reading of a shared place reaches the
 * conclusion: the corner of Exemple and Voisine 23 is 57° for the grey leg and
 * 98° for the blue, and a leg may only answer for the manoeuvre it performs.
 * Without it the place's worst reading stands in for every leg — conservative,
 * never wrong in the refusing direction, but it moved two Thairé verdicts from
 * OK to HUMAN on nothing but the order of a list.
 */
export function legsFromMeasured(
  candidates: readonly RouteCandidate[],
  collected: CollectedPoints,
  candidateVerdicts: readonly CandidateVerdict[],
  pointVerdicts: readonly PointVerdict[],
  perLeg?: LegPointVerdicts,
): readonly PairLegInput[] {
  const verdictOf = new Map(candidateVerdicts.map((cv) => [cv.candidateId, cv]));
  const readVerdict = legPointVerdictReader(pointVerdicts, perLeg);

  const legs: PairLegInput[] = [];
  for (const candidate of candidates) {
    const cv = verdictOf.get(candidate.id);
    if (cv === undefined) continue;
    legs.push({
      id: candidate.id,
      inboundId: candidate.egressOf?.inboundId ?? null,
      verdict: cv.verdict,
      blockedAtSegmentId: cv.blockedAtSegmentId,
      points: (collected.byCandidate.get(candidate.id) ?? []).flatMap((ref) => {
        const pv = readVerdict(candidate.id, ref);
        return pv === undefined ? [] : [{ ref, verdict: pv.verdict }];
      }),
    });
  }
  return legs;
}
