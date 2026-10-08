/**
 * Le test d'or : QUI décide, et ce que l'autre
 * lecture n'a pas le droit de changer.
 *
 * Il a eu deux vies. Jusqu', le classement et les plans lisaient une
 * deuxième et une troisième fois des faits que la conclusion avait déjà lus, et
 * ce fichier interdisait qu'ils déteignent : `viaCandidateId` ne devait pas
 * suivre le rang 1, `overall` ne devait pas glisser.
 *
 * (2026-09-11) a tranché l'autre sens. Le responsable produit : « activer la
 * découverte + les plans pour le classement : Excellent », et « surtout ne
 * baissons pas en qualité, c'est clairement la qualité qui prime ». Le meilleur
 * plan DEVIENT la conclusion. Donc le test d'or garde ses deux moitiés :
 *
 *  - `mode: 'pairs'` — le retour arrière. Chaque champ est celui de 61efed8,
 *    écrit à la main, et rien de ce qui a été ajouté depuis n'y touche.
 *  - `mode: 'plans'` — la livraison. Ce qui change y est écrit fixture par
 *    fixture, avec la raison du changement. Une valeur recopiée d'une
 *    exécution serait un bug approuvé ; une valeur qu'on ne sait pas expliquer
 *    aussi.
 *
 * Et une garantie, testée : en mode plans, `overall` n'est jamais PIRE qu'en
 * mode paires. Les paires d'hier sont des plans à même ancre, et le classement
 * met le verdict en premier.
 *
 * ## Relecture du 2026-09-12 — (taxonomie des virages)
 *
 * La règle du fichier veut qu'un changement s'écrive fixture par fixture, avec
 * sa raison. (déflexion nette, virage de carrefour ≠ courbe, plus de
 * giratoire promu) n'en change AUCUNE, et voici pourquoi, une ligne par
 * fixture — c'est la même vérification pour toutes, parce qu'elles partagent
 * une propriété :
 *
 *  - `PairSpec.points` porte des points DÉJÀ JUGÉS (un verdict, une marge),
 *    jamais une `TurnGeometry` ; aucune fixture de ce fichier n'en construit
 *    une (`grep "type: 'TURN'"` : zéro). Les seuls points typés qu'il utilise
 *    sont les TURNAROUND des trois impasses (§ « impasse »), dont la géométrie
 *    et l'évaluateur ne sont pas touchés ;
 *  - la détection S4 n'est pas jouée : `runProjection` reçoit ses points tout
 *    faits. Un virage rebaptisé courbe ne peut donc pas remonter jusqu'ici ;
 *  - les largeurs des `segments` sont lues par `legal.ts` et par le point
 *    NARROW, ni l'un ni l'autre modifiés.
 *
 * Autrement dit : ce test d'or garde exactement les mêmes valeurs qu'avant
 *, et c'est une information, pas une absence de vérification — il dit
 * que la taxonomie n'a pas déteint sur QUI décide. Ce que la taxonomie change
 * se mesure ailleurs : `packages/points/test/jury-thaire.test.ts` (les trois
 * jambes du jury) et l'A/B sur corpus.
 *
 * ## Relecture du 2026-09-12 — (une géométrie par jambe)
 *
 * Même exercice, même règle. S5 juge désormais chaque point UNE FOIS PAR JAMBE,
 * sur la géométrie de cette jambe (`CollectedPoints.geometryByCandidate`), et
 * `pointVerdicts` garde un verdict par LIEU — le pire des jambes. Aucune valeur
 * de ce fichier ne bouge, et là encore la raison est une propriété des
 * fixtures, pas une chance :
 *
 *  - dans `PairSpec`, les points appartiennent à UNE paire et sont portés
 *    identiquement par ses deux jambes ; aucune fixture ici ne fait passer deux
 *    paires par le même `ref`. Une jambe ne peut donc pas voir le point
 *    autrement qu'une autre, et « le pire des jambes » vaut « le seul » ;
 *  - `runProjection` remplit `geometryByCandidate` avec la géométrie écrite
 *    dans la fixture, jambe par jambe : la nouvelle lecture rend exactement ce
 *    que l'ancienne rendait.
 *
 * Ce que 416 change se voit donc là où deux jambes divergent VRAIMENT, et la
 * section « un lieu partagé » plus bas construit ce cas exprès : elle est la
 * moitié du test d'or qui bougerait si la géométrie redevenait partagée.
 */
import { describe, expect, it } from 'vitest';
import type { RunConclusion } from '@teneolog/domain';

import { measured, run, runPlans, turn, unknown, type PairSpec } from './helpers/pairs-fixture.js';

const SEVERITY: Readonly<Record<string, number>> = { OK: 0, HUMAN: 1, NO: 2, NOT_DELIVERABLE: 3 };

/** La conclusion telle qu'elle était et. */
function withoutRanking(conclusion: RunConclusion): Record<string, unknown> {
  const {
    ranking,
    rankingDisagreesWithVia,
    plans,
    planCount,
    bestPlanIsSameGatePair,
    plansDisagreeWithVia,
    retainedPlan,
    r0Pair,
    legVerdicts,
    ...rest
  } = conclusion;
  void ranking;
  void rankingDisagreesWithVia;
  void plans;
  void planCount;
  void bestPlanIsSameGatePair;
  void plansDisagreeWithVia;
  void retainedPlan;
  void r0Pair;
  // `legVerdicts` est le RELEVÉ, pas la réponse : ce que chaque jambe
  // a mesuré à chaque lieu, publié pour que le rejeu du fil n'ait pas à le
  // recalculer. Écarté ici comme le classement et les plans le sont, parce que
  // cette moitié du test dit « la conclusion d'hier, au bit près » — et vérifié
  // pour lui-même plus bas (§ « un lieu partagé »).
  void legVerdicts;
  return rest;
}

// ---------------------------------------------------------------------------
// Les quatre fixtures, nommées une fois : les deux moitiés lisent LES MÊMES.
// ---------------------------------------------------------------------------

/** Trois paires dont une seule passe. */
const TROIS_PAIRES: readonly PairSpec[] = [
  { gate: 'a@0', points: [unknown('NARROW@doute')] },
  { gate: 'b@90', points: [measured('NARROW@large', 7.0)] },
  { gate: 'c@180', points: [measured('NARROW@etroit', 2.0)] },
];

/**
 * Deux paires refusées, celle de meilleure marge en second dans l'ordre
 * d'azimut.
 *
 * des VIRAGES, et non plus des sections droites : depuis le principe
 * 27, une droite étroite ne départage plus rien, et une fixture qui séparerait
 * deux paires sur une largeur de droite ne testerait plus le classement mais
 * son absence. Le 19 t demande 5,35 m dans un virage à 90° : 4,0 m laissent
 * −1,35 m, 4,4 m laissent −0,95 m. Deux NON, le second moins mauvais.
 */
const TOUT_REFUSE: readonly PairSpec[] = [
  { gate: 'a@0', points: [turn('TURN@x', 90, 4.0)] },
  { gate: 'b@90', points: [turn('TURN@y', 90, 4.4)] },
];

/** Deux paires OK que seule la marge du virage sépare, la meilleure en second. */
const DEUX_OK: readonly PairSpec[] = [
  { gate: 'premiere@0', points: [turn('TURN@juste', 90, 6.0)] },
  { gate: 'seconde@90', points: [turn('TURN@ample', 90, 9.0)] },
];

/** Une seule paire, large. */
const UNE_PAIRE: readonly PairSpec[] = [{ gate: 'a@0', points: [measured('NARROW@x', 7.0)] }];

const TOUTES: readonly (readonly [string, readonly PairSpec[]])[] = [
  ['trois paires', TROIS_PAIRES],
  ['tout refusé', TOUT_REFUSE],
  ['deux OK', DEUX_OK],
  ['une paire', UNE_PAIRE],
  ['aucun itinéraire', []],
];

// ---------------------------------------------------------------------------
// mode 'pairs' — le retour arrière, au bit près
// ---------------------------------------------------------------------------

describe('mode pairs — la conclusion est celle d’avant', () => {
  it('trois paires dont une seule passe : chaque champ, écrit à la main', () => {
    const conclusion = run(TROIS_PAIRES);

    expect(withoutRanking(conclusion)).toEqual({
      profileId: 'pl-19t',
      // Une paire passe : la revendication d'existence est satisfaite.
      overall: 'OK',
      pointVerdicts: conclusion.pointVerdicts,
      candidateVerdicts: conclusion.candidateVerdicts,
      // Comportement d', gardé tel quel et volontairement figé
      // ici : sur une paire OK de bout en bout, `decidedBy` nomme quand même
      // le premier point de la paire (`foldLeg` garde un `worstPoint` dès que
      // sa sévérité égale celle de la jambe, ce qui est vrai de OK contre OK).
      // « Le point qui a déterminé la réponse » nomme donc un point qui n'a
      // rien déterminé. Le test d'or n'est pas l'endroit où on le corrige — il
      // est l'endroit où on l'empêche de changer par accident.
      decidedBy: 'NARROW@large',
      // `b@90`, la première paire OK dans l'ordre d'azimut — et non `a@0`,
      // qui vient avant mais n'est que HUMAINE.
      viaCandidateId: 'b@90:out',
      // Les points de la paire retenue, et eux seuls.
      retainedPointRefs: ['NARROW@large'],
      reasonCodes: [],
      // une paire s'est formée : le garde-fou de portée n'a rien à dire.
      noLegReachesRing: null,
      policyVersion: 'test-1',
      validUntil: '2026-09-24T00:00:00Z',
    });

    // Et le classement, lui, est bien là, d'accord avec elle.
    expect(conclusion.ranking).toHaveLength(3);
    expect(conclusion.ranking[0]?.outboundId).toBe('b@90:out');
    expect(conclusion.rankingDisagreesWithVia).toBe(false);

    // Les plans aussi : trois entrantes × trois sortantes, et pas un verdict
    // de la conclusion qui bouge.
    expect(conclusion.planCount).toBe(9);
    expect(conclusion.plans).toHaveLength(9);

    // en mode paires, aucun plan n'est retenu, et la trace de R0 dit
    // exactement ce que la conclusion dit.
    expect(conclusion.retainedPlan).toBeNull();
    expect(conclusion.r0Pair).toEqual({ viaCandidateId: 'b@90:out', overall: 'OK' });
  });

  it('toutes les paires refusées : le classement ne sauve rien', () => {
    const conclusion = run(TOUT_REFUSE);

    expect(conclusion.overall).toBe('NO');
    expect(conclusion.viaCandidateId).toBe('a@0:out');
    // `b@90` a la marge de virage la moins mauvaise, donc le rang 1 — et la
    // conclusion reste NON par `a@0`. Le désaccord se signale, il ne se résout pas.
    expect(conclusion.ranking[0]?.outboundId).toBe('b@90:out');
    expect(conclusion.rankingDisagreesWithVia).toBe(true);
  });

  it('le rang 1 ne devient JAMAIS la paire retenue', () => {
    // Deux paires OK que seule la marge du virage sépare, la meilleure en
    // second dans l'ordre d'azimut : `concludePairs` garde la première
    // rencontrée.
    const conclusion = run(DEUX_OK);

    expect(conclusion.ranking[0]?.outboundId).toBe('seconde@90:out');
    expect(conclusion.viaCandidateId).toBe('premiere@0:out');
    expect(conclusion.rankingDisagreesWithVia).toBe(true);
    // Ce que le désaccord ne touche pas : la réponse, et ce sur quoi elle repose.
    expect(conclusion.overall).toBe('OK');
    expect(conclusion.retainedPointRefs).toEqual(['TURN@juste']);
  });

  it('aucun itinéraire : le silence de la conclusion est intact', () => {
    const conclusion = run([]);
    expect(withoutRanking(conclusion)).toEqual({
      profileId: 'pl-19t',
      overall: 'HUMAN',
      pointVerdicts: [],
      candidateVerdicts: [],
      decidedBy: null,
      viaCandidateId: null,
      retainedPointRefs: [],
      reasonCodes: ['no_viable_pair'],
      // `run([])` ne passe pas de motif : `no_viable_pair` reste
      // `no_viable_pair`, mot pour mot, exactement comme.
      noLegReachesRing: null,
      policyVersion: 'test-1',
      validUntil: '2026-09-24T00:00:00Z',
    });
  });

  it('la conclusion porte ces champs-là, et le prochain qu’on ajoutera se verra ici', () => {
    const conclusion = run(UNE_PAIRE);
    expect(Object.keys(conclusion).sort()).toEqual([
      'bestPlanIsSameGatePair',
      'candidateVerdicts',
      'decidedBy',
      // ce que chaque jambe a mesuré à chaque lieu qu'elle conduit.
      'legVerdicts',
      // le garde-fou de portée : non nul seulement avec no_leg_reaches_ring.
      'noLegReachesRing',
      'overall',
      'planCount',
      'plans',
      'plansDisagreeWithVia',
      'pointVerdicts',
      'policyVersion',
      'profileId',
      // ce que la règle d'hier aurait retenu, gardé dans les deux modes.
      'r0Pair',
      'ranking',
      'rankingDisagreesWithVia',
      'reasonCodes',
      // les deux jambes du plan retenu; null en mode paires.
      'retainedPlan',
      'retainedPointRefs',
      'validUntil',
      'viaCandidateId',
    ]);
  });
});

// ---------------------------------------------------------------------------
// mode 'plans' — ce qui change, fixture par fixture, et pourquoi
// ---------------------------------------------------------------------------

describe('mode plans — le meilleur plan décide', () => {
  it('trois paires : RIEN NE CHANGE — le plan retenu EST la paire retenue', () => {
    // La paire `b@90` était retenue ; le meilleur plan est `b@90:in → b@90:out`,
    // la même paire, et il est tout droit (le camion continue, la sortante
    // repart dans le cap d'arrivée). Les plans qui croisent deux ancres
    // écartent les caps de 90°, donc demi-tour non établi, donc HUMAIN : le
    // verdict les classe derrière. Une conclusion qui ne bouge pas est le cas
    // le plus fréquent du corpus (22 des 24 cas de l'A/B).
    const plans = runPlans(TROIS_PAIRES);
    const pairs = run(TROIS_PAIRES);

    expect(plans.overall).toBe('OK');
    expect(plans.viaCandidateId).toBe('b@90:out');
    expect(plans.retainedPointRefs).toEqual(['NARROW@large']);
    expect(plans.decidedBy).toBe(pairs.decidedBy);
    expect(plans.retainedPlan).toEqual({
      inboundId: 'b@90:in',
      outboundId: 'b@90:out',
      sameGate: true,
      manoeuvre: 'straight',
      rank: 1,
    });
    // Et la trace de R0, identique — il n'y a pas de désaccord à signaler.
    expect(plans.r0Pair).toEqual({ viaCandidateId: 'b@90:out', overall: 'OK' });
    expect(plans.plansDisagreeWithVia).toBe(false);
  });

  it('tout refusé : CHANGE — `a@0:out` retenue hier, `b@90` aujourd’hui (virage à −0,95 m contre −1,35 m)', () => {
    // Le verdict ne bouge pas (NON des deux côtés) : ce qui change est
    // l'itinéraire NOMMÉ dans le refus, et il change pour le mieux. Hier
    // `concludePairs` gardait la PREMIÈRE paire du meilleur verdict, c'est-à-dire
    // la première dans l'ordre d'azimut — `a@0`, dont le virage à 90° n'a que
    // 4,0 m pour 5,35 m requis. Le classement des plans applique
    // `wider_worst_turn_margin` et nomme `b@90` (4,4 m). Le désaccord que
    // signalait sans le résoudre (`rankingDisagreesWithVia: true`) est
    // désormais résolu, dans le sens que le classement indiquait.
    const plans = runPlans(TOUT_REFUSE);

    expect(plans.overall).toBe('NO');
    expect(plans.viaCandidateId).toBe('b@90:out');
    expect(plans.decidedBy).toBe('TURN@y');
    expect(plans.retainedPointRefs).toEqual(['TURN@y']);
    expect(plans.retainedPlan?.inboundId).toBe('b@90:in');
    expect(plans.retainedPlan?.sameGate).toBe(true);
    // Ce que R0 aurait retenu reste lisible à côté.
    expect(plans.r0Pair).toEqual({ viaCandidateId: 'a@0:out', overall: 'NO' });
    expect(plans.plansDisagreeWithVia).toBe(true);
  });

  it('deux OK : CHANGE — `premiere@0` retenue hier, `seconde@90` aujourd’hui (virage à 9,00 m contre 6,00 m)', () => {
    // Le cas que le test « le rang 1 ne devient JAMAIS la paire retenue »
    // interdisait : le rang 1 DEVIENT la conclusion. C'est le point de la
    // tâche. Le verdict reste OK — deux plans tout droit et OK, que seule la
    // marge du virage sépare — et le point à faire valider change avec
    // l'itinéraire : `TURN@ample` au lieu de `TURN@juste`. L'opérateur se voit
    // donc poser la question du meilleur itinéraire, pas celle du premier
    // azimut.
    const plans = runPlans(DEUX_OK);

    expect(plans.overall).toBe('OK');
    expect(plans.viaCandidateId).toBe('seconde@90:out');
    expect(plans.retainedPointRefs).toEqual(['TURN@ample']);
    expect(plans.retainedPlan).toEqual({
      inboundId: 'seconde@90:in',
      outboundId: 'seconde@90:out',
      sameGate: true,
      manoeuvre: 'straight',
      rank: 1,
    });
    expect(plans.r0Pair).toEqual({ viaCandidateId: 'premiere@0:out', overall: 'OK' });
  });

  it('une paire : RIEN NE CHANGE — un seul plan, qui est la paire', () => {
    // Une ancre, une entrante, une sortante : le seul plan possible est la
    // paire. `retainedPlan` le dit (`sameGate: true`), et c'est la forme sous
    // laquelle un run d'hier se relit intégralement.
    const plans = runPlans(UNE_PAIRE);

    expect(plans.overall).toBe('OK');
    expect(plans.viaCandidateId).toBe('a@0:out');
    expect(plans.retainedPointRefs).toEqual(['NARROW@x']);
    expect(plans.retainedPlan?.sameGate).toBe(true);
    expect(plans.planCount).toBe(1);
  });

  it('aucun itinéraire : RIEN NE CHANGE — aucun plan n’est une réponse, donc les paires répondent', () => {
    // Pas d'entrante, pas de sortante, pas de plan. La conclusion n'invente
    // rien : c'est celle des paires, mot pour mot, avec son motif.
    const plans = runPlans([]);

    expect(withoutRanking(plans)).toEqual(withoutRanking(run([])));
    expect(plans.retainedPlan).toBeNull();
    expect(plans.reasonCodes).toEqual(['no_viable_pair']);
  });
});

// ---------------------------------------------------------------------------
// L'invariant
// ---------------------------------------------------------------------------

describe('l’invariant : un verdict ne peut que rester ou s’améliorer', () => {
  for (const [name, specs] of TOUTES) {
    it(`${name} — plans ≤ paires en sévérité`, () => {
      const before = run(specs).overall;
      const after = runPlans(specs).overall;
      expect(SEVERITY[after]).toBeLessThanOrEqual(SEVERITY[before] as number);
    });
  }

  it('et les points retenus sont toujours ceux des deux jambes du plan', () => {
    // Ce que l'opérateur se voit demander suit l'itinéraire retenu, sans
    // traîner un point d'un itinéraire écarté (transposé au plan).
    const conclusion = runPlans(TROIS_PAIRES);
    const plan = conclusion.retainedPlan;
    expect(plan).not.toBeNull();
    const onPlan = new Set(
      conclusion.pointVerdicts
        .filter((pv) => ['NARROW@large'].includes(pv.pointRef))
        .map((pv) => pv.pointRef),
    );
    for (const ref of conclusion.retainedPointRefs) expect(onPlan.has(ref)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// La limite, nommée plutôt que cachée
// ---------------------------------------------------------------------------

describe('la seule forme où un plan est PLUS sévère que la paire', () => {
  it('impasse sans retournement mesuré : le plan pose la question que la paire taisait', () => {
    // Une impasse impose un demi-tour à TOUT plan (règle de couplage de
    // Le responsable produit, §7.2). Sans retournement mesuré, `judgeTurnaround` rend
    // HUMAIN — le même verdict, et les mêmes codes, que le point TURNAROUND
    //. Le plan est donc HUMAIN là où la paire disait OK, parce que la
    // paire supposait sans le dire que le camion pouvait ressortir.
    //
    // POURQUOI CE N'EST PAS UNE RÉGRESSION MESURÉE : dans un vrai run, une
    // impasse porte un point TURNAROUND accroché à CHAQUE candidat
    // (`collectCriticalPoints`), donc les deux jambes portent déjà ce HUMAIN et
    // la paire le portait aussi. La fixture, elle, n'a pas ce point — c'est ce
    // qui isole le terme de manœuvre et le rend visible. Sur le corpus des huit
    // adresses × trois camions, zéro verdict se dégrade (A/B §7.3).
    const impasse = runPlans(UNE_PAIRE, {
      kind: 'DEAD_END',
      turnaround: { known: false, why: 'no_data' },
      provenTopology: true,
    });

    expect(run(UNE_PAIRE).overall).toBe('OK');
    expect(impasse.overall).toBe('HUMAN');
    expect(impasse.retainedPlan?.manoeuvre).toBe('u_turn');
    // Aucun LIEU n'a décidé : c'est la manœuvre, et le motif le nomme.
    expect(impasse.decidedBy).toBeNull();
    expect(impasse.reasonCodes).toEqual(['retained_plan_uturn_unproven']);
  });
});

// ---------------------------------------------------------------------------
// un lieu partagé, deux jambes qui le mesurent autrement
// ---------------------------------------------------------------------------

describe('un lieu partagé : chaque jambe répond de SA géométrie', () => {
  /**
   * Le cas de Thairé, réduit à ses os. Deux paires passent par le MÊME coin,
   * `TURN@partage`, mais pas par les mêmes rues : `ample@0` l'aborde par une
   * chaussée de 9 m, `serree@90` par 4 m. Avant 416 la première jambe de la
   * liste imposait sa mesure à l'autre, et le verdict des deux paires tenait à
   * l'ordre du tableau.
   */
  const PARTAGE: readonly PairSpec[] = [
    { gate: 'ample@0', points: [turn('TURN@partage', 90, 9.0)] },
    { gate: 'serree@90', points: [turn('TURN@partage', 90, 4.0)] },
  ];
  const INVERSE: readonly PairSpec[] = [PARTAGE[1] as PairSpec, PARTAGE[0] as PairSpec];

  function verdictOf(conclusion: RunConclusion, candidateId: string): string | undefined {
    return conclusion.candidateVerdicts.find((cv) => cv.candidateId === candidateId)?.verdict;
  }

  it('la jambe large passe, la jambe étroite refuse — au même point', () => {
    const conclusion = run(PARTAGE);

    expect(verdictOf(conclusion, 'ample@0:in')).toBe('OK');
    expect(verdictOf(conclusion, 'ample@0:out')).toBe('OK');
    expect(verdictOf(conclusion, 'serree@90:in')).toBe('NO');
    expect(verdictOf(conclusion, 'serree@90:out')).toBe('NO');

    // Et la réponse est celle de la paire qui passe.
    expect(conclusion.overall).toBe('OK');
    expect(conclusion.viaCandidateId).toBe('ample@0:out');
  });

  it('l’ordre des paires ne change rien — c’était exactement le bug', () => {
    const conclusion = run(INVERSE);

    expect(verdictOf(conclusion, 'ample@0:in')).toBe('OK');
    expect(verdictOf(conclusion, 'serree@90:in')).toBe('NO');
    expect(conclusion.overall).toBe('OK');
    expect(conclusion.viaCandidateId).toBe('ample@0:out');
  });

  it('UN verdict par lieu, et c’est le pire — le deck pose la question une fois', () => {
    // `pointVerdicts` est la liste que lisent le deck de revue, `/explain` et
    // le classement : une entrée par référence, jamais une par jambe, sans quoi
    // toutes leurs jointures par `pointRef` prendraient la dernière venue.
    // Le pire, parce que la question EXISTE dès qu'une jambe la pose — et parce
    // que c'est la seule agrégation qui ne dépende pas de l'ordre de la liste.
    for (const specs of [PARTAGE, INVERSE]) {
      const conclusion = run(specs);
      const shared = conclusion.pointVerdicts.filter((pv) => pv.pointRef === 'TURN@partage');
      expect(shared).toHaveLength(1);
      expect(shared[0]?.verdict).toBe('NO');
      // Une entrée de lieu ne nomme aucune jambe : elle parle de l'endroit.
      expect(shared[0]?.candidateId).toBeNull();
    }
  });

  it('et À CÔTÉ, un verdict par (jambe, lieu) — publié, plus à recalculer', () => {
    //, seconde passe. Le pire du lieu est ce qu'il faut pour DEMANDER;
    // ce qu'il faut pour RÉPONDRE est la mesure de la jambe, et jusqu'ici elle
    // vivait dans une variable locale de `projectTruck`. Tout ce qui rejoue le
    // run — `rederiveConclusion` sur le fil — reposait donc le pire du lieu sur
    // chaque jambe et rendait NON une jambe qui passe.
    for (const specs of [PARTAGE, INVERSE]) {
      const conclusion = run(specs);
      const at = (candidateId: string): string | undefined =>
        conclusion.legVerdicts.find(
          (lv) => lv.candidateId === candidateId && lv.pointRef === 'TURN@partage',
        )?.verdict;

      expect(at('ample@0:in')).toBe('OK');
      expect(at('ample@0:out')).toBe('OK');
      expect(at('serree@90:in')).toBe('NO');
      expect(at('serree@90:out')).toBe('NO');
    }
  });

  it('le relevé par jambe est complet et nommé : une entrée par (jambe, point)', () => {
    const conclusion = run(PARTAGE);
    // Quatre jambes × le seul point du relevé. Complet par construction : c'est
    // ce qui permet au repli (« pas d'entrée → lire le lieu ») de ne servir
    // qu'aux snapshots d'avant 416, jamais à un trou d'aujourd'hui.
    expect(conclusion.legVerdicts).toHaveLength(4);
    for (const lv of conclusion.legVerdicts) {
      expect(lv.candidateId, 'un verdict de jambe nomme sa jambe').not.toBeNull();
    }
    // Les jambes dans l'ordre des candidats, celui de S3 : l'azimut des ancres.
    expect(conclusion.legVerdicts.map((lv) => lv.candidateId)).toEqual(
      conclusion.candidateVerdicts.map((cv) => cv.candidateId),
    );
  });
});
