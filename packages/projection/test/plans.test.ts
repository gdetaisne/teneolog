/**
 * Les plans : entrer par une ancre, sortir par une autre.
 *
 * Ce qui est sous test, c'est le COUPLAGE À L'ARRÊT, parce que c'est la seule
 * chose qu'un plan ajoute à deux jambes déjà mesurées. Les règles sont celles
 * que le responsable produit a tranchées (la note de conception interne) et chaque cas en isole
 * une : rue traversante et tout droit, demi-tour mesuré faisable, mesuré
 * infaisable, non mesuré, sens unique, impasse.
 *
 * Les plans se lisent à travers `projectTruck`, comme le classement : la chaîne
 * réelle doit les produire, et une manœuvre déduite à la main dans un test
 * n'aurait jamais rien prouvé de ce que le moteur fait.
 */
import { describe, expect, it } from 'vitest';
import type { RankedPlan } from '@teneolog/domain';

import { judgeTurnaround } from '../src/evaluators.js';
import { turnaroundFeasibility } from '../src/plans.js';
import { isUnknownDoubt } from '../src/ranking.js';
import { PLANS_DEFAULTS } from '../src/policy.js';
import { estimatedTurn, measured, PL19, POLICY, segment, turn, unknown } from './helpers/pairs-fixture.js';
import {
  DEAD_END_UNMEASURED,
  deadEnd,
  deadEndDeclared,
  deadEndUnproven,
  planRun,
  THROUGH,
  turnaroundPoint,
  unknownTurnaroundPoint,
} from './helpers/plans-fixture.js';

/** `entrée → sortie`, la lecture courte d'un plan. */
function pairsOf(plans: readonly RankedPlan[]): readonly string[] {
  return plans.map((plan) => `${plan.inboundId} → ${plan.outboundId}`);
}

function find(
  plans: readonly RankedPlan[],
  inboundGate: string,
  outboundGate: string,
): RankedPlan {
  const plan = plans.find(
    (one) => one.inboundId === `${inboundGate}:in` && one.outboundId === `${outboundGate}:out`,
  );
  if (plan === undefined) throw new Error(`plan ${inboundGate} → ${outboundGate} absent`);
  return plan;
}

// ---------------------------------------------------------------------------
// Ce qu'un plan est : toutes les combinaisons, pas les paires
// ---------------------------------------------------------------------------

describe('les plans forment TOUTES les combinaisons', () => {
  it('deux entrantes et deux sortantes font quatre plans, pas deux paires', () => {
    const conclusion = planRun({
      inbound: [
        { gate: 'nord@0', headingDeg: 180 },
        { gate: 'est@90', headingDeg: 270 },
      ],
      outbound: [
        { gate: 'nord@0', headingDeg: 0 },
        { gate: 'est@90', headingDeg: 90 },
      ],
    });

    expect(conclusion.planCount).toBe(4);
    expect(conclusion.plans).toHaveLength(4);
    expect(new Set(pairsOf(conclusion.plans)).size).toBe(4);
    // Le moteur, lui, n'en voit toujours que deux : c'est l'écart que la tâche
    // existe pour montrer.
    expect(conclusion.ranking).toHaveLength(2);

    const sameGate = conclusion.plans.filter((plan) => plan.sameGate);
    expect(sameGate.map((plan) => plan.inboundId).sort()).toEqual(['est@90:in', 'nord@0:in']);
  });

  it('les rangs sont denses et contigus, et le meilleur plan est le rang 1', () => {
    const conclusion = planRun({
      inbound: [
        { gate: 'a@0', headingDeg: 90, points: [measured('NARROW@a', 7.0)] },
        { gate: 'b@90', headingDeg: 90, points: [unknown('NARROW@b')] },
      ],
      outbound: [
        { gate: 'a@0', headingDeg: 90, points: [measured('NARROW@a', 7.0)] },
        { gate: 'b@90', headingDeg: 90, points: [unknown('NARROW@b')] },
      ],
    });

    expect(conclusion.plans.map((plan) => plan.rank)).toEqual([1, 2, 3, 4]);
    // Le seul plan dont AUCUNE jambe ne porte de point humain passe devant.
    expect(conclusion.plans[0]?.verdict).toBe('OK');
    expect(pairsOf(conclusion.plans)[0]).toBe('a@0:in → a@0:out');
    expect(conclusion.plans[0]?.reasons[0]).toBe('verdict_ok');
  });

  it('sans entrante, ou sans sortante, il n’y a pas de plan — et pas un plan vide', () => {
    const noOut = planRun({ inbound: [{ gate: 'a@0', headingDeg: 90 }], outbound: [] });
    expect(noOut.plans).toEqual([]);
    expect(noOut.planCount).toBe(0);
    expect(noOut.bestPlanIsSameGatePair).toBe(false);
    expect(noOut.plansDisagreeWithVia).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Rue traversante : tout droit par défaut
// ---------------------------------------------------------------------------

describe('rue traversante — la sortie doit continuer le cap d’arrivée', () => {
  it('même cap : tout droit, faisable, aucune manœuvre à mesurer', () => {
    const conclusion = planRun({
      inbound: [{ gate: 'ouest@270', headingDeg: 90 }],
      outbound: [{ gate: 'est@90', headingDeg: 90 }],
      stop: THROUGH,
    });

    const plan = find(conclusion.plans, 'ouest@270', 'est@90');
    expect(plan.manoeuvre).toBe('straight');
    expect(plan.manoeuvreFeasible).toBe('yes');
    // Deux décimales : sur 200 m de géodésique, un cap « identique » dérive de
    // deux millièmes de degré. C'est la sphère, pas la règle.
    expect(plan.headingGapDeg).toBeCloseTo(0, 2);
    expect(plan.sameGate).toBe(false);
    // Rien n'est mesuré à l'arrêt, et pourtant le plan passe : continuer tout
    // droit ne demande aucune mesure — la route continue, le routeur l'a tracée.
    expect(plan.verdict).toBe('OK');
  });

  it('le demi-tour d’une rue traversante n’est pas interdit : il est INCONNU', () => {
    const conclusion = planRun({
      inbound: [{ gate: 'ouest@270', headingDeg: 90 }],
      outbound: [{ gate: 'ouest@270', headingDeg: 270 }],
      stop: THROUGH,
    });

    const plan = find(conclusion.plans, 'ouest@270', 'ouest@270');
    expect(plan.manoeuvre).toBe('u_turn');
    expect(plan.manoeuvreFeasible).toBe('unknown');
    expect(plan.headingGapDeg).toBeCloseTo(180, 2);
    expect(plan.verdict).toBe('HUMAN');
  });

  it('la tolérance vient de la policy, elle n’est pas codée en dur', () => {
    const legs = (headingDeg: number) => ({
      inbound: [{ gate: 'a@0', headingDeg: 0 }],
      outbound: [{ gate: 'b@90', headingDeg }],
    });

    // Par défaut, 60° : 55 continue le cap d'arrivée, 65 ne le continue plus.
    expect(PLANS_DEFAULTS.straightToleranceDeg).toBe(60);
    expect(find(planRun(legs(55)).plans, 'a@0', 'b@90').manoeuvre).toBe('straight');
    expect(find(planRun(legs(65)).plans, 'a@0', 'b@90').manoeuvre).toBe('u_turn');

    // Resserrée à 30°, le même 55° devient une manœuvre.
    const strict = planRun({
      ...legs(55),
      policy: { ...POLICY, plans: { ...PLANS_DEFAULTS, straightToleranceDeg: 30 } },
    });
    expect(find(strict.plans, 'a@0', 'b@90').manoeuvre).toBe('u_turn');
  });

  it('un cap qu’on ne sait pas mesurer ne vaut pas « tout droit »', () => {
    // Une jambe réduite à un point : aucune direction ne s'y lit.
    const conclusion = planRun({
      inbound: [{ gate: 'a@0', headingDeg: 90, lengthM: 0 }],
      outbound: [{ gate: 'b@90', headingDeg: 90 }],
      stop: THROUGH,
    });

    const plan = find(conclusion.plans, 'a@0', 'b@90');
    expect(plan.headingGapDeg).toBeNull();
    expect(plan.manoeuvre).toBe('u_turn');
    expect(plan.manoeuvreFeasible).toBe('unknown');
    expect(plan.verdict).toBe('HUMAN');
  });
});

// ---------------------------------------------------------------------------
// Le demi-tour, mesuré
// ---------------------------------------------------------------------------

describe('le demi-tour vaut ce que la mesure en dit', () => {
  // PL 19 t : 2 × 11 m de rayon + 2 m de garde = 24 m requis.
  it('mesuré assez large : faisable, et le plan garde le verdict de ses jambes', () => {
    const conclusion = planRun({
      inbound: [{ gate: 'a@0', headingDeg: 90 }],
      outbound: [{ gate: 'a@0', headingDeg: 270 }],
      stop: deadEnd(30),
    });

    const plan = find(conclusion.plans, 'a@0', 'a@0');
    expect(plan.manoeuvre).toBe('u_turn');
    expect(plan.manoeuvreFeasible).toBe('yes');
    expect(plan.verdict).toBe('OK');
  });

  it('mesuré trop étroit : NON — une manœuvre impossible est un refus', () => {
    const conclusion = planRun({
      inbound: [{ gate: 'a@0', headingDeg: 90 }],
      outbound: [{ gate: 'a@0', headingDeg: 270 }],
      stop: deadEnd(10),
    });

    const plan = find(conclusion.plans, 'a@0', 'a@0');
    expect(plan.manoeuvreFeasible).toBe('no');
    expect(plan.verdict).toBe('NO');
    // Le plan reste dans la liste : « aucun plan » et « aucun plan qui passe »
    // ne sont pas la même phrase.
    expect(conclusion.planCount).toBe(1);
  });

  it('non mesuré : INCONNU, donc humain — ni interdit, ni permis', () => {
    const conclusion = planRun({
      inbound: [{ gate: 'a@0', headingDeg: 90 }],
      outbound: [{ gate: 'a@0', headingDeg: 270 }],
      stop: DEAD_END_UNMEASURED,
    });

    const plan = find(conclusion.plans, 'a@0', 'a@0');
    expect(plan.manoeuvreFeasible).toBe('unknown');
    expect(plan.verdict).toBe('HUMAN');
  });

  // ── on ne refuse jamais sur du non-mesuré ──────────────────────
  // Les huit régressions HUMAIN → NON de l'A/B ( §3.1) tenaient toutes
  // dans ces deux cas : le plan lisait la comparaison nue, le point lisait la
  // comparaison PLUS les deux garde-fous, et les deux lectures se
  // contredisaient sur la même mesure.

  it('topologie non prouvée : la question, pas le refus — même trop étroit', () => {
    const conclusion = planRun({
      inbound: [{ gate: 'a@0', headingDeg: 90 }],
      outbound: [{ gate: 'a@0', headingDeg: 270 }],
      // 10 m pour 24 m requis : la comparaison nue disait « non ».
      stop: deadEndUnproven(10),
    });

    const plan = find(conclusion.plans, 'a@0', 'a@0');
    expect(plan.manoeuvreFeasible).toBe('unknown');
    expect(plan.verdict).toBe('HUMAN');
    // Et il le dit avec les mots de l'évaluateur, pas les siens.
    expect(plan.manoeuvreReasonCodes).toEqual(['turnaround_diameter', 'topology_unproven']);
  });

  it('diamètre seulement déclaré : la question, pas le refus', () => {
    const conclusion = planRun({
      inbound: [{ gate: 'a@0', headingDeg: 90 }],
      outbound: [{ gate: 'a@0', headingDeg: 270 }],
      stop: deadEndDeclared(10),
    });

    const plan = find(conclusion.plans, 'a@0', 'a@0');
    expect(plan.manoeuvreFeasible).toBe('unknown');
    expect(plan.verdict).toBe('HUMAN');
    expect(plan.manoeuvreReasonCodes).toEqual([
      'turnaround_diameter',
      'declared_width_cannot_refuse',
    ]);
  });

  it('mesuré ET prouvé trop étroit : là, et là seulement, c’est un refus', () => {
    const plan = find(
      planRun({
        inbound: [{ gate: 'a@0', headingDeg: 90 }],
        outbound: [{ gate: 'a@0', headingDeg: 270 }],
        stop: deadEnd(10),
      }).plans,
      'a@0',
      'a@0',
    );
    expect(plan.manoeuvreFeasible).toBe('no');
    expect(plan.manoeuvreReasonCodes).toEqual(['turnaround_diameter', 'margin_negative']);
  });

  it('le plan et le point TURNAROUND disent désormais la même chose', () => {
    // Une seule source de vérité : sur la même mesure, le verdict du plan et
    // celui du point ne peuvent plus diverger. C'est l'invariant que 
    // installe, et c'est lui qui vaut d'être testé — pas ses trois exemples.
    for (const stop of [deadEnd(30), deadEnd(10), deadEndUnproven(10), deadEndDeclared(10)]) {
      const judged = turnaroundFeasibility(stop, PL19, POLICY);
      const evaluated = judgeTurnaround(
        {
          turnaround: stop.turnaround,
          provenTopology: stop.provenTopology,
          path: 'stop.turnaround',
        },
        PL19,
        POLICY,
      );
      expect(judged.feasible).toBe(
        evaluated.verdict === 'OK' ? 'yes' : evaluated.verdict === 'NO' ? 'no' : 'unknown',
      );
      expect(judged.reasonCodes).toEqual(evaluated.reasonCodes);
    }
  });

  it('sur une rue traversante, tout droit ne se justifie pas : aucun code', () => {
    const plan = find(
      planRun({
        inbound: [{ gate: 'a@0', headingDeg: 90 }],
        outbound: [{ gate: 'b@90', headingDeg: 90 }],
        stop: THROUGH,
      }).plans,
      'a@0',
      'b@90',
    );
    expect(plan.manoeuvre).toBe('straight');
    expect(plan.manoeuvreReasonCodes).toEqual([]);
  });

  it('la faisabilité suit le camion : le même retournement, deux gabarits', () => {
    const semi = {
      id: 'semi-44t',
      label: 'Semi-remorque 44 t',
      family: 'semi',
      envelope: {
        lengthM: 16.5,
        widthM: 2.55,
        heightM: 4.0,
        gvwT: 44,
        turnRadiusM: 15,
        wheelbaseM: 3.9,
        frontOverhangM: 1.4,
        rearOverhangM: 3.0,
      },
      equipment: { tailLift: false, crane: false, refrigerated: false },
    } as const;

    const legs = {
      inbound: [{ gate: 'a@0', headingDeg: 90 }],
      outbound: [{ gate: 'a@0', headingDeg: 270 }],
      // 30 m : au-dessus des 24 m du porteur, sous les 32 m du semi.
      stop: deadEnd(30),
    };
    expect(find(planRun(legs).plans, 'a@0', 'a@0').manoeuvreFeasible).toBe('yes');
    expect(find(planRun({ ...legs, truck: semi }).plans, 'a@0', 'a@0').manoeuvreFeasible).toBe('no');
  });
});

// ---------------------------------------------------------------------------
// L'impasse : le demi-tour est la forme de la rue
// ---------------------------------------------------------------------------

describe('impasse — le demi-tour est requis, quoi que disent les caps', () => {
  it('même dans le prolongement du cap d’arrivée, la sortie passe par la manœuvre', () => {
    // Des caps identiques : sur une rue traversante, ce serait tout droit.
    const conclusion = planRun({
      inbound: [{ gate: 'a@0', headingDeg: 90 }],
      outbound: [{ gate: 'b@90', headingDeg: 90 }],
      stop: deadEnd(30),
    });

    const plan = find(conclusion.plans, 'a@0', 'b@90');
    expect(plan.headingGapDeg).toBeCloseTo(0, 2);
    expect(plan.manoeuvre).toBe('u_turn');
    expect(plan.manoeuvreFeasible).toBe('yes');
  });

  it('la sortie peut repartir par une AUTRE ancre que celle de l’arrivée', () => {
    const conclusion = planRun({
      inbound: [{ gate: 'a@0', headingDeg: 90 }],
      outbound: [
        { gate: 'a@0', headingDeg: 270 },
        { gate: 'b@90', headingDeg: 270, distanceM: 400 },
      ],
      stop: deadEnd(30),
    });

    // Les deux plans existent et sont tous deux des demi-tours faisables ; le
    // plus court passe devant, et il n'est pas celui de l'ancre d'arrivée.
    expect(conclusion.planCount).toBe(2);
    for (const plan of conclusion.plans) expect(plan.manoeuvreFeasible).toBe('yes');
    expect(conclusion.plans[0]?.outboundId).toBe('b@90:out');
    expect(conclusion.plans[0]?.sameGate).toBe(false);
    expect(conclusion.bestPlanIsSameGatePair).toBe(false);
  });

  it('une boucle terminale se lit comme une impasse : la manœuvre est la même', () => {
    const conclusion = planRun({
      inbound: [{ gate: 'a@0', headingDeg: 90 }],
      outbound: [{ gate: 'a@0', headingDeg: 90 }],
      stop: { kind: 'TERMINAL_LOOP', turnaround: deadEnd(30).turnaround, provenTopology: true },
    });
    expect(find(conclusion.plans, 'a@0', 'a@0').manoeuvre).toBe('u_turn');
  });
});

// ---------------------------------------------------------------------------
// Le sens unique
// ---------------------------------------------------------------------------

describe('sens unique — une approche n’est jamais son propre retour', () => {
  it('la sortie qui rebrousse le cap d’arrivée est un demi-tour, jamais un tout droit', () => {
    // OSRM respecte les sens : sur une rue à sens unique, la jambe qui repart
    // ne peut pas reprendre la rue d'arrivée à l'envers. Si une sortante le
    // faisait quand même, son cap serait l'opposé de l'arrivée — et c'est
    // exactement ce que le test de l'angle refuse d'appeler « tout droit ».
    const conclusion = planRun({
      inbound: [{ gate: 'rue@0', headingDeg: 90 }],
      outbound: [
        { gate: 'rue@0', headingDeg: 270 }, // le retour par la rue d'arrivée
        { gate: 'suite@90', headingDeg: 90 }, // la continuation, par une autre ancre
      ],
      stop: THROUGH,
    });

    const back = find(conclusion.plans, 'rue@0', 'rue@0');
    expect(back.manoeuvre).toBe('u_turn');
    expect(back.manoeuvreFeasible).toBe('unknown');
    expect(back.verdict).toBe('HUMAN');

    const onward = find(conclusion.plans, 'rue@0', 'suite@90');
    expect(onward.manoeuvre).toBe('straight');
    expect(onward.verdict).toBe('OK');

    // Le plan qui marche est celui qui entre par une ancre et sort par une
    // autre ; celui de la paire du moteur demande un humain.
    expect(conclusion.plans[0]).toMatchObject({
      inboundId: 'rue@0:in',
      outboundId: 'suite@90:out',
      sameGate: false,
    });
    expect(conclusion.bestPlanIsSameGatePair).toBe(false);
    expect(conclusion.plansDisagreeWithVia).toBe(true);

    // Et la conclusion n'a pas bougé d'un bit : elle conclut sur SA paire, et
    // elle répond OK parce que la manœuvre à l'arrêt n'entre pas dans sa
    // lecture — c'est exactement l'écart que l'A/B aura à arbitrer,
    // et le taire en corrigeant le verdict ici le ferait disparaître.
    expect(conclusion.viaCandidateId).toBe('rue@0:out');
    expect(conclusion.overall).toBe('OK');
  });
});

// ---------------------------------------------------------------------------
// Le désaccord, dit et non résolu
// ---------------------------------------------------------------------------

describe('ce que les plans disent de la conclusion, sans la toucher', () => {
  it('le meilleur plan EST la paire retenue : aucun désaccord', () => {
    const conclusion = planRun({
      inbound: [{ gate: 'a@0', headingDeg: 90 }],
      outbound: [{ gate: 'a@0', headingDeg: 90 }],
      stop: THROUGH,
    });

    expect(conclusion.viaCandidateId).toBe('a@0:out');
    expect(conclusion.bestPlanIsSameGatePair).toBe(true);
    expect(conclusion.plansDisagreeWithVia).toBe(false);
  });

  it('même sortante, autre entrante : c’est déjà un désaccord', () => {
    const conclusion = planRun({
      inbound: [
        // L'entrante de la paire retenue porte un point douteux ; l'autre non.
        { gate: 'a@0', headingDeg: 90, points: [unknown('NARROW@doute')] },
        { gate: 'b@90', headingDeg: 90 },
      ],
      outbound: [{ gate: 'a@0', headingDeg: 90 }],
      stop: THROUGH,
    });

    expect(conclusion.viaCandidateId).toBe('a@0:out');
    const best = conclusion.plans[0];
    expect(best?.outboundId).toBe('a@0:out');
    expect(best?.inboundId).toBe('b@90:in');
    expect(conclusion.plansDisagreeWithVia).toBe(true);
  });
});

// ── un demi-tour MESURÉ n'est pas une inconnue ─────────────────────
//
// « Prioriser les itinéraires avec AUCUNE inconnue » (principe 28) parle des
// doutes nés d'une donnée ABSENTE. Un retournement de 24,2 m pour 24 m requis
// est mesuré : il tombe dans la bande de confort, comme un virage à +0,20 m, et
// c'est le troisième critère qui doit le départager — pas le deuxième. Les
// compter ensemble faisait perdre un rang à un plan sur une question à
// laquelle un nombre avait déjà répondu.

describe('rankPlans — la manœuvre à l’arrêt et les inconnues', () => {
  const legs = {
    inbound: [{ gate: 'a@0', headingDeg: 90 }],
    outbound: [{ gate: 'a@0', headingDeg: 270 }],
  };

  it('un demi-tour dans la bande de confort est un doute mesuré, pas une inconnue', () => {
    // 24,2 m pour 24 m requis (2 × 11 m de rayon + 2 m de garde) : +0,20 m,
    // sous la marge de confort de 0,40 m.
    const plan = find(planRun({ ...legs, stop: deadEnd(24.2) }).plans, 'a@0', 'a@0');

    expect(plan.manoeuvreFeasible).toBe('unknown');
    expect(plan.verdict).toBe('HUMAN');
    expect(plan.manoeuvreReasonCodes).toEqual([
      'turnaround_diameter',
      'margin_within_comfort_band',
    ]);
    // La marge EST publiée — c'est elle qui dit que le doute a été mesuré.
    expect(plan.manoeuvreMarginM).toBeCloseTo(0.2, 6);
    expect(plan.unknownCount).toBe(0);
  });

  it('un demi-tour que personne n’a mesuré, lui, en est une', () => {
    const plan = find(planRun({ ...legs, stop: DEAD_END_UNMEASURED }).plans, 'a@0', 'a@0');

    expect(plan.manoeuvreFeasible).toBe('unknown');
    expect(plan.manoeuvreMarginM).toBeNull();
    expect(plan.unknownCount).toBe(1);
  });

  it('une topologie non prouvée aussi : la mesure existe, la forme non', () => {
    const plan = find(planRun({ ...legs, stop: deadEndUnproven(10) }).plans, 'a@0', 'a@0');

    expect(plan.manoeuvreReasonCodes).toContain('topology_unproven');
    // `human(…)` ne publie pas de marge : le calcul a bien produit un nombre,
    // mais sur une forme qui n'est pas établie — donc il ne compte pas.
    expect(plan.manoeuvreMarginM).toBeNull();
    expect(plan.unknownCount).toBe(1);
  });


  it('le point TURNAROUND mesuré ne compte pas non plus, et pas deux fois', () => {
    // La vraie forme d'une impasse : le point TURNAROUND que S4 accroche aux
    // deux jambes, et la manœuvre du plan, sur LA MÊME mesure (24,2 m pour
    // 24 m requis). Un doute mesuré, donc zéro inconnue — et surtout pas deux.
    const stop = deadEnd(24.2);
    const point = turnaroundPoint('TURNAROUND@46.0,-1.0', 24.2);
    const plan = find(
      planRun({
        inbound: [{ gate: 'a@0', headingDeg: 90, points: [point] }],
        outbound: [{ gate: 'a@0', headingDeg: 270, points: [point] }],
        stop,
      }).plans,
      'a@0',
      'a@0',
    );

    expect(plan.verdict).toBe('HUMAN');
    expect(plan.manoeuvreFeasible).toBe('unknown');
    expect(plan.unknownCount).toBe(0);
    // Et la marge du point pèse, elle : c'est le troisième critère.
    expect(plan.worstTurnMarginM).toBeCloseTo(0.2, 6);
  });

  it('non mesuré, le point et la manœuvre ne font QU’UNE inconnue', () => {
    // Le partage : le point porte la question, la manœuvre ne la rajoute pas.
    // Une impasse sans retournement mesuré donne donc 1, jamais 2.
    const plan = find(
      planRun({
        inbound: [{ gate: 'a@0', headingDeg: 90, points: [unknownTurnaroundPoint('TURNAROUND@46.0,-1.0')] }],
        outbound: [{ gate: 'a@0', headingDeg: 270, points: [unknownTurnaroundPoint('TURNAROUND@46.0,-1.0')] }],
        stop: DEAD_END_UNMEASURED,
      }).plans,
      'a@0',
      'a@0',
    );

    expect(plan.unknownCount).toBe(1);
  });
  it('rouler tout droit n’ajoute rien : ni marge, ni inconnue', () => {
    const plan = find(
      planRun({
        inbound: [{ gate: 'a@0', headingDeg: 90 }],
        outbound: [{ gate: 'b@90', headingDeg: 90 }],
        stop: THROUGH,
      }).plans,
      'a@0',
      'b@90',
    );

    expect(plan.manoeuvre).toBe('straight');
    expect(plan.manoeuvreMarginM).toBeNull();
    expect(plan.unknownCount).toBe(0);
  });

  it('la manœuvre se juge comme un point : verdict, marge, codes, une fois', () => {
    // L'invariant, et non ses exemples : ce que le plan publie de la manœuvre
    // est mot pour mot ce que `judgeTurnaround` a dit, les trois champs.
    for (const stop of [deadEnd(30), deadEnd(24.2), deadEnd(10), deadEndUnproven(10), deadEndDeclared(10)]) {
      const plan = find(planRun({ ...legs, stop }).plans, 'a@0', 'a@0');
      const evaluated = judgeTurnaround(
        { turnaround: stop.turnaround, provenTopology: stop.provenTopology, path: 'stop.turnaround' },
        PL19,
        POLICY,
      );
      expect(plan.manoeuvreMarginM).toBe(evaluated.marginM);
      expect(plan.manoeuvreReasonCodes).toEqual(evaluated.reasonCodes);
      // Et la règle des inconnues est celle de tous les autres doutes.
      expect(plan.unknownCount).toBe(isUnknownDoubt(evaluated) ? 1 : 0);
    }
  });
});

// ── l'ordre des critères, et le fait qu'il n'y en ait qu'un ───────
//
// L'arbitrage « aucune inconnue » contre « le meilleur pire virage » a été
// tranché par Décision produit : « On priorise le minimum d'inconnues »
// (principe 28). Ce qui reste sous test est ce que la règle promet aux deux
// bouts : le verdict décide d'abord, la distance en dernier.

describe('rankPlans — le verdict décide, la distance conclut', () => {
  /**
   * Deux sorties que tout oppose sur les deux critères du milieu, et rien
   * d'autre : même verdict (HUMAIN), même distance, même entrée.
   *
   *  · `sure@180`  — aucune inconnue, mais son pire virage est à +0,25 m
   *    (5,60 m pour 5,346 m requis à 90°), donc dans la bande de confort.
   *  · `ample@270` — une inconnue : une largeur ESTIMÉE de 4,50 m sous les
   *    5,346 m requis, qui ne peut pas refuser (principe 5) et ne publie donc
   *    AUCUNE marge — mais son virage MESURÉ est à +1,65 m.
   */
  const spec = {
    inbound: [{ gate: 'entree@0', headingDeg: 90 }],
    outbound: [
      { gate: 'sure@180', headingDeg: 90, points: [turn('TURN@sure', 90, 5.6)] },
      {
        gate: 'ample@270',
        headingDeg: 90,
        points: [estimatedTurn('TURN@estimee', 90, 4.5), turn('TURN@ample', 90, 7.0)],
      },
    ],
  };

  it('l’itinéraire sans inconnue passe devant, même avec une marge plus courte', () => {
    const plans = planRun(spec).plans;

    expect(plans.map((p) => p.outboundId)).toEqual(['sure@180:out', 'ample@270:out']);
    expect(plans[0]?.unknownCount).toBe(0);
    expect(plans[1]?.unknownCount).toBe(1);
    // Et il le dit : c'est l'absence d'inconnue qui a décidé.
    expect(plans[0]?.reasons[0]).toBe('no_unknowns');
  });

  it('le verdict reste premier et la distance dernière', () => {
    // Une sortie REFUSÉE, sans aucune inconnue et avec la meilleure marge de
    // virage du lot : rien de tout cela ne doit la faire remonter.
    const withRefusal = {
      ...spec,
      outbound: [
        ...spec.outbound,
        {
          gate: 'refusee@90',
          headingDeg: 90,
          segments: [segment('bloquant', 'secondary', 500)],
          points: [measured('NARROW@bloc', 2.0), turn('TURN@large', 90, 9.0)],
        },
      ],
    };
    const plans = planRun(withRefusal).plans;

    expect(plans[plans.length - 1]?.outboundId).toBe('refusee@90:out');
    expect(plans[plans.length - 1]?.verdict).toBe('NO');
  });
});
