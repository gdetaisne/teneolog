/**
 * LE TEST D'OR DU CLASSEMENT SUR UN LIEU PARTAGÉ —, second volet
 * (constat L6-3 de l'audit du 2026-09-18).
 *
 * LE DÉFAUT. La conclusion lisait le point tel que CHAQUE JAMBE le conduit
 * (`perLeg`); le classement — `rankPairs` et `rankPlans`, donc le
 * plan RETENU — lisait encore le pire du LIEU. Au coin Exemple / Voisine 23
 * (`TURN@46.0733,-0.9649`, une seule référence pour toutes les jambes), le pire
 * du lieu est l'inconnue de la grise : 57° dans 3,0 m DÉCLARÉS, donc HUMAIN
 * sans marge. Toutes les jambes qui passent par ce coin — y compris celles qui
 * y tournent dans 5,2 m mesurés avec 1,04 m de jeu — héritaient donc de cette
 * inconnue.
 *
 * CE QUE ÇA COÛTAIT, chiffré sur ce relevé (voir chaque cas) :
 *   1. les deux premiers critères du principe 28 (verdict, puis inconnues)
 *      devenaient aveugles à ce coin, et c'était la distance qui désignait le
 *      plan retenu — l'opérateur partait sur la jambe étroite ;
 *   2. le podium contredisait la conclusion : `plans[0].verdict` disait
 *      « à valider, 1 inconnue » pendant que `conclusion.overall` disait OK,
 *      les deux sur le même écran.
 *
 * CE QU'IL FIGE. Les nombres, au dixième, des deux côtés de la correction : ce
 * fichier échoue si le classement se remet à lire le lieu, et il échoue aussi
 * si quelqu'un change le classement sans le dire.
 */
import { describe, expect, it } from 'vitest';
import type { RankedPlan } from '@teneolog/domain';

import { projectTruck } from '../src/project.js';
import {
  AT,
  collectFor,
  GREY,
  POLICY,
  STOP_WIDTH_MEASURED,
  truck,
} from './helpers/thaire-corner.js';

/** L'aller et le retour par l'ancre 708450424@211 : tous leurs points sont OK. */
const AMPLE_IN = '708450424@211:in';
const AMPLE_OUT = '708450424@211:out';
/** L'entrée par le nord : elle lit le coin à +1,43 m, et porte UNE inconnue à elle. */
const NORTH_IN = '364439832@356:in';

const CORNER_REF = 'TURN@46.0733,-0.9649';

function plansOf(ids: readonly string[]): {
  readonly plans: readonly RankedPlan[];
  readonly overall: string;
  readonly retainedInboundId: string | null;
} {
  const { candidates, collected } = collectFor(ids, STOP_WIDTH_MEASURED);
  const projection = projectTruck({
    candidates,
    collected,
    truck: truck('vul-fourgon'),
    policy: POLICY,
    policyVersion: 'test',
    validUntil: AT,
    routerFailed: false,
    stopShape: {
      kind: 'THROUGH',
      turnaround: { known: false, why: 'not_applicable' },
      provenTopology: true,
    },
  });
  return {
    plans: projection.conclusion.plans,
    overall: projection.conclusion.overall,
    retainedInboundId: projection.conclusion.retainedPlan?.inboundId ?? null,
  };
}

describe('Thairé — le coin partagé est lu SUR LA JAMBE, par le classement aussi', () => {
  /**
   * LE LIEU EST BIEN PARTAGÉ, ET LES DEUX LECTURES BIEN DIFFÉRENTES — sans
   * quoi les deux cas ci-dessous ne prouveraient rien.
   */
  it('la grise y est une inconnue, les deux autres jambes une marge mesurée', () => {
    const { candidates, collected } = collectFor(
      [GREY, NORTH_IN, AMPLE_IN, AMPLE_OUT],
      STOP_WIDTH_MEASURED,
    );
    const projection = projectTruck({
      candidates,
      collected,
      truck: truck('vul-fourgon'),
      policy: POLICY,
      policyVersion: 'test',
      validUntil: AT,
      routerFailed: false,
    });
    const atCorner = new Map(
      projection.conclusion.legVerdicts
        .filter((verdict) => verdict.pointRef === CORNER_REF)
        .map((verdict) => [verdict.candidateId, verdict]),
    );
    expect(atCorner.get(GREY)?.verdict).toBe('HUMAN');
    expect(atCorner.get(GREY)?.marginM).toBeNull();
    expect(atCorner.get(AMPLE_IN)?.verdict).toBe('OK');
    expect(atCorner.get(AMPLE_IN)?.marginM ?? 0).toBeCloseTo(1.04, 2);
    expect(atCorner.get(NORTH_IN)?.verdict).toBe('OK');
    expect(atCorner.get(NORTH_IN)?.marginM ?? 0).toBeCloseTo(1.43, 2);
    // Le pire du LIEU reste l'inconnue de la grise : c'est lui que la revue et
    // l'écran lisent (`worstPerPlace`), et c'est bien lui qu'il ne faut PAS
    // faire classer.
    const place = projection.pointVerdicts.find((verdict) => verdict.pointRef === CORNER_REF);
    expect(place?.verdict).toBe('HUMAN');
    expect(place?.marginM).toBeNull();
  });

  /**
   * CAS 1 — LE PLAN RETENU CHANGE, et c'est la branche dangereuse.
   *
   * Deux entrantes, une seule sortante. Chacune porte UNE inconnue qui lui est
   * propre : la grise `TURN@46.0737,-0.9613`, la nord `TURN@46.0771,-0.9728`.
   * Au coin, la grise est une inconnue et la nord vaut +1,43 m.
   *
   * Avant : le coin comptait pour une inconnue des DEUX côtés (2 contre 2), le
   * critère des inconnues ne tranchait plus, et la pire marge de virage puis la
   * distance désignaient la grise (+0,84 m et 4 297 m contre +0,18 m et
   * 4 891 m). L'opérateur était envoyé dans les 3,0 m de la Rue Voisine 14.
   * Après : 1 inconnue contre 2, le deuxième critère du principe 28 tranche, et
   * c'est la nord qui est retenue — malgré 593 m de plus et une marge plus
   * serrée, parce que « on priorise le minimum d'inconnues ».
   */
  it('le plan sans l’inconnue du coin passe devant, même plus long', () => {
    const { plans, retainedInboundId } = plansOf([GREY, NORTH_IN, AMPLE_OUT]);
    expect(plans.map((plan) => plan.inboundId)).toEqual([NORTH_IN, GREY]);

    const [first, second] = plans;
    expect(first?.unknownCount).toBe(1);
    expect(first?.reasons).toEqual(['no_unknowns']);
    expect(first?.worstTurnMarginM ?? 0).toBeCloseTo(0.18, 2);
    expect(first?.totalDistanceM ?? 0).toBeCloseTo(4890.8, 1);

    expect(second?.unknownCount).toBe(2);
    expect(second?.worstTurnMarginM ?? 0).toBeCloseTo(0.84, 2);
    expect(second?.totalDistanceM ?? 0).toBeCloseTo(4297.5, 1);

    // Et c'est bien la conclusion qui suit le classement (`mode: 'plans'`).
    expect(retainedInboundId).toBe(NORTH_IN);
  });

  /**
   * CAS 2 — LE PODIUM CESSE DE CONTREDIRE LA CONCLUSION.
   *
   * L'aller et le retour par 708450424@211 : tous leurs points sont OK, coin
   * compris (+1,04 m), et l'arrêt est mesuré à 8,0 m. Le plan passe donc, sans
   * une question.
   *
   * Avant : `concludePlan` rejugeait par jambe et rendait `overall: 'OK'`
   * pendant que `plans[0]` — la ligne du podium, rendue par l'onglet
   * Itinéraires — portait `verdict: 'HUMAN'` et `unknownCount: 1`, l'inconnue
   * de la grise au coin. Deux panneaux du même écran, deux réponses.
   * Après : les deux disent OK, et le plan ne porte plus aucune inconnue.
   */
  it('un plan dont toutes les jambes passent est OK sur le podium comme dans la conclusion', () => {
    const { plans, overall } = plansOf([GREY, AMPLE_IN, AMPLE_OUT]);
    const best = plans[0];
    expect(best?.inboundId).toBe(AMPLE_IN);
    expect(best?.verdict).toBe('OK');
    expect(best?.unknownCount).toBe(0);
    expect(overall).toBe('OK');
    expect(best?.verdict).toBe(overall);

    // La grise, elle, garde son inconnue : la correction ne fait pas taire un
    // doute, elle cesse de le prêter (principe 4, aucun NON → OK inexpliqué).
    const grey = plans.find((plan) => plan.inboundId === GREY);
    expect(grey?.verdict).toBe('HUMAN');
    expect(grey?.unknownCount).toBe(2);
  });
});
