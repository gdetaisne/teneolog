/**
 * LE TEST D'ACCEPTATION : 12 Rue de l’Exemple, 17290 Thairé.
 *
 * Le jury du 2026-09-12 (compte rendu interne) a relu le run `382e9a97` avec le responsable produit et en a tiré deux
 * décisions, devenues les principes 27 et 28. Ce fichier les vérifie sur CE
 * run-là, avec les fixtures qu'il a produites — et non sur une géométrie
 * inventée pour l'occasion, qui prouverait seulement que le test sait compter.
 *
 * CE QUE LE TEST REJOUE VRAIMENT. Les règles sous test sont appelées, jamais
 * réécrites : `approachReachM` et `discoveredLegId` (`@teneolog/routes`) pour
 * la portée des approches et le nom de leurs jambes, `measureLegPair` et
 * `compareOnCriteria` (`@teneolog/projection`) pour les inconnues, la pire
 * marge de virage et l'ordre. Ce que le test fournit est ce que le run a
 * produit : les verdicts de points, les points par jambe, les segments, les
 * distances, les bouts de jambe.
 *
 * CE QU'IL NE REJOUE PAS : `rankPlans` lui-même, c'est-à-dire la formation des
 * plans et la lecture des caps à l'arrêt. Les verdicts de plan et les manœuvres
 * sont donc lus sur `conclusion.plans`. À Thairé les 100 plans sont `straight`
 * et `manoeuvreFeasible: 'yes'` — la rue de livraison est traversante — donc la
 * manœuvre n'ajoute aucune inconnue et cette moitié ne décide de rien ici. Le
 * test le vérifie plutôt que de le supposer.
 *
 * UN AVERTISSEMENT SUR LA DATE DES POINTS. Les points de ces fixtures sont ceux
 * du 2026-09-12, avec les défauts que le jury a nommés : un giratoire inventé
 * (H), un virage sans rayon (J), une droite à 3,0 m comptée comme un doute (I).
 * Ce test ne les corrige pas et ne les attend pas corrigés : il écrit ce que le
 * CLASSEMENT fait de ces points-là. Quand les détecteurs seront repris
 *, c'est ce fichier qui dira ce qui a bougé.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import type {
  CriticalPoint,
  GeoPoint,
  PointRef,
  PointVerdict,
  RankedPlan,
  RouteCandidate,
} from '@teneolog/domain';
import type { CollectedPoints } from '@teneolog/points';
import {
  compareOnCriteria,
  isUnknownDoubt,
  measureContext,
  measureLegPair,
  type RankableFacts,
} from '@teneolog/projection';
import { approachReachM, discoveredLegId } from '@teneolog/routes';

/** `gates.minReachM` de la policy de référence — une seule clé pour les deux producteurs de jambes. */
const MIN_REACH_M = 1_800;

function fixture<T>(name: string): T {
  const path = fileURLToPath(new URL(`./fixtures/thaire/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

interface ConclusionFixture {
  readonly data: {
    readonly conclusion: {
      readonly plans: readonly RankedPlan[];
      readonly pointVerdicts: readonly PointVerdict[];
      readonly retainedPlan: { readonly inboundId: string; readonly outboundId: string };
    };
  };
}

interface LegsFixture {
  readonly stop: GeoPoint;
  readonly candidates: readonly {
    readonly id: string;
    readonly direction: 'in' | 'out';
    readonly distanceM: number;
    readonly segments: readonly { readonly highway: string | null; readonly lengthM: number }[];
  }[];
  readonly approaches: readonly {
    readonly key: string;
    readonly direction: 'in' | 'out';
    readonly routedDistanceM: number;
    readonly farEnd: GeoPoint;
  }[];
}

interface PointsFixture {
  readonly data: {
    readonly points: readonly CriticalPoint[];
    readonly byCandidate: Readonly<Record<string, readonly PointRef[]>>;
  };
}

const conclusion = fixture<ConclusionFixture>('jury-thaire-conclusion.json').data.conclusion;
const legsFixture = fixture<LegsFixture>('jury-thaire-legs.json');
const pointsFixture = fixture<PointsFixture>('jury-thaire-points.json').data;

const plans = conclusion.plans;
const pointVerdicts = conclusion.pointVerdicts;
const stop = legsFixture.stop;

// ---------------------------------------------------------------------------
// 1. Les jambes qui n'atteignent pas le cercle (principe 7)
// ---------------------------------------------------------------------------

const reachOfApproach = legsFixture.approaches.map((approach) => ({
  key: approach.key,
  direction: approach.direction,
  // LA fonction du moteur, sur le bout de la jambe tel que le routeur l'a
  // accroché au réseau. Une polyligne d'un seul sommet suffit : `approachReachM`
  // ne lit que l'extrémité, et le reste ne dirait rien de plus.
  reachM: approachReachM(stop, [approach.farEnd], approach.direction),
  routedDistanceM: approach.routedDistanceM,
}));

const shortOfRing = reachOfApproach.filter((leg) => leg.reachM < MIN_REACH_M);
// `discoveredLegId` : la traduction du moteur, celle que le pipeline emploie
// pour nommer une jambe promue. L'écrire à la main ici donnait
// `disc:r3@220:alt1:in` au lieu de `disc:r3@220:in:alt1`, et six plans
// survivaient qui n'auraient pas dû.
const droppedLegIds = new Set(shortOfRing.map((leg) => discoveredLegId(leg)));

const survivingPlans = plans.filter(
  (plan) => !droppedLegIds.has(plan.inboundId) && !droppedLegIds.has(plan.outboundId),
);

describe('Thairé — les jambes qui n’atteignent pas le cercle (principe 7)', () => {
  it('sept jambes sortent, exactement celles du tableau du jury', () => {
    // Le tableau du « Pas 1 » du jury, colonne « bout, à vol d'oiseau ». Les
    // mètres diffèrent d'une ou deux unités du document : celui-ci arrondit, et
    // le rayon terrestre d'`haversineM` n'est pas celui du tableur.
    expect(shortOfRing.map((leg) => [leg.key, leg.direction, Math.round(leg.reachM)])).toEqual([
      ['r3@145', 'in', 1_241],
      ['r3@220:alt1', 'in', 1_133],
      ['r3@250', 'in', 606],
      ['r2@150:out:alt1', 'out', 1_488],
      ['r3@235:out', 'out', 688],
      ['r3@250:out:alt1', 'out', 606],
      ['r3@295:out:alt1', 'out', 666],
    ]);
    expect([...droppedLegIds].sort()).toEqual([
      'disc:r2@150:out:alt1',
      'disc:r3@145:in',
      'disc:r3@220:in:alt1',
      'disc:r3@235:out',
      'disc:r3@250:in',
      'disc:r3@250:out:alt1',
      'disc:r3@295:out:alt1',
    ]);
  });

  it('les jambes que le responsable produit retient, elles, atteignent le cercle', () => {
    const reach = (key: string): number =>
      Math.round(reachOfApproach.find((leg) => leg.key === key)?.reachM ?? 0);
    // `r2@285` in et out — l'entrée et la sortie par la Rue Voisine 10.
    expect(reach('r2@285')).toBe(1_950);
    expect(reach('r2@285:out')).toBe(1_950);
    // Et la route de l'est, celle dont le responsable produit dit qu'un 19 t y passe.
    expect(reach('r3@085:alt1')).toBe(1_914);
  });

  it('le seuil tombe dans un trou : rien entre 1 488 m et 1 914 m', () => {
    // C'est ce qui rend 1 800 m défendable plutôt qu'arbitraire — il ne coupe
    // au milieu d'aucune population. Si un corpus ramène des approches dans cet
    // intervalle, ce test tombe et le seuil se recalibre.
    const reaches = reachOfApproach.map((leg) => leg.reachM);
    expect(Math.round(Math.max(...reaches.filter((m) => m < MIN_REACH_M)))).toBe(1_488);
    expect(Math.round(Math.min(...reaches.filter((m) => m >= MIN_REACH_M)))).toBe(1_914);
  });

  it('la sortie retenue par le run — celle qui s’arrête avant le giratoire — disparaît', () => {
    // Défaut A du jury : `r3@250:alt1` gagnait parce qu'elle s'arrêtait à 606 m,
    // juste avant le seul vrai giratoire de la sortie (621 m).
    expect(conclusion.retainedPlan.outboundId).toBe('disc:r3@250:out:alt1');
    expect(droppedLegIds.has('disc:r3@250:out:alt1')).toBe(true);
  });

  it('les plans passent de 100 à 42 : aucun ne passe plus par une jambe tronquée', () => {
    // Sept jambes sortent — trois entrantes, quatre sortantes — donc 7 × 6 = 42
    // plans au lieu de 10 × 10.
    expect(plans).toHaveLength(100);
    expect(survivingPlans).toHaveLength(42);
    for (const gate of ['r3@250', 'r3@235', 'r3@295', 'r3@145', 'r3@220', 'r2@150']) {
      const still = survivingPlans.filter(
        (plan) => plan.inboundId.includes(gate) || plan.outboundId.includes(gate),
      );
      expect(still, `${gate} devrait avoir disparu`).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Le classement, avec les points d'aujourd'hui
// ---------------------------------------------------------------------------

/** Les candidats du run, réduits à ce que `measureLegPair` lit d'eux. */
const candidates = legsFixture.candidates.map(
  (candidate) =>
    ({
      id: candidate.id,
      direction: candidate.direction,
      distanceM: candidate.distanceM,
      segments: candidate.segments,
      // Jamais lus par `measureLegPair`, qui ne regarde que `segments` et
      // `distanceM`. Les laisser vides est plus honnête que de les inventer.
      polyline: [],
      coverage: { sampled: 0, matched: 0 },
      corridorReasonCodes: [],
      generatedBy: 'car-optimal',
      durationS: 0,
      egressOf: null,
    }) as unknown as RouteCandidate,
);

const collected: CollectedPoints = {
  points: pointsFixture.points,
  byCandidate: new Map(Object.entries(pointsFixture.byCandidate)),
  // La fixture est la section `points` servie par le run : elle ne porte que la
  // géométrie partagée, pas celle de chaque jambe. Vide ⇒ chaque
  // jambe lit `points[]`, c'est-à-dire exactement le relevé d'alors.
  geometryByCandidate: new Map(),
};

/**
 * Les faits d'un plan, mesurés par LE moteur.
 *
 * `hidden` retire des points du relevé — c'est ainsi que le contrefactuel du
 * jury se joue, en neutralisant les deux artefacts sans toucher au reste.
 */
function factsOf(plan: RankedPlan, hidden: ReadonlySet<string> = new Set()): RankableFacts {
  const visible = pointVerdicts.filter((verdict) => !hidden.has(verdict.pointRef));
  const measured = measureLegPair(
    [plan.inboundId, plan.outboundId],
    // `perLeg` absent : la fixture est le relevé PAR LIEU du run du 2026-09-12
    // (`geometryByCandidate` vide), donc chaque jambe y lit `points[]` — ce que
    // le moteur fait alors aussi (`legPointVerdictReader`, repli par lieu).
    measureContext(candidates, collected, { pointVerdicts: visible }),
  );
  return {
    verdict: plan.verdict,
    unknownCount: measured.unknownCount + (plan.manoeuvreFeasible === 'unknown' ? 1 : 0),
    worstTurnMarginM: measured.worstTurnMarginM,
    totalDistanceM: plan.totalDistanceM,
  };
}

function rankedPlans(hidden: ReadonlySet<string> = new Set()): readonly RankedPlan[] {
  return [...survivingPlans]
    .map((plan, order) => ({ plan, facts: factsOf(plan, hidden), order }))
    .sort((a, b) => compareOnCriteria(a.facts, b.facts) || a.order - b.order)
    .map((entry) => entry.plan);
}

/** Les points d'un plan que le moteur compte comme des inconnues, triés. */
function unknownsOf(plan: RankedPlan): readonly string[] {
  const refs = new Set([
    ...(collected.byCandidate.get(plan.inboundId) ?? []),
    ...(collected.byCandidate.get(plan.outboundId) ?? []),
  ]);
  return pointVerdicts
    .filter((verdict) => refs.has(verdict.pointRef) && isUnknownDoubt(verdict))
    .map((verdict) => verdict.pointRef)
    .sort();
}

/** Le plan que le responsable produit retient : entrer par le nord-est, sortir par l'ouest. */
const PLAN_JURY = { inboundId: '119513478@56:in', outboundId: 'disc:r2@285:out' };

function rankOf(order: readonly RankedPlan[]): number {
  return (
    order.findIndex(
      (one) =>
        one.inboundId === PLAN_JURY.inboundId && one.outboundId === PLAN_JURY.outboundId,
    ) + 1
  );
}

const juryPlan = survivingPlans.find(
  (plan) =>
    plan.inboundId === PLAN_JURY.inboundId && plan.outboundId === PLAN_JURY.outboundId,
) as RankedPlan;

/** Les deux artefacts de l'entrée nord-est, que corrige. */
const ARTEFACTS_I_ET_J = new Set(['NARROW@46.0772,-0.9587', 'TURN@46.0737,-0.9613']);

describe('Thairé — le classement avec les points d’aujourd’hui', () => {
  it('la rue est traversante : aucun plan n’ajoute d’inconnue de manœuvre', () => {
    expect(new Set(survivingPlans.map((plan) => plan.manoeuvre))).toEqual(new Set(['straight']));
    expect(new Set(survivingPlans.map((plan) => plan.manoeuvreFeasible))).toEqual(new Set(['yes']));
    expect(pointVerdicts.some((verdict) => verdict.pointRef.startsWith('TURNAROUND@'))).toBe(false);
  });

  it('rang 1 : entrer et sortir par l’ouest — deux inconnues, le « 128° » à 0,35 m', () => {
    const first = rankedPlans()[0] as RankedPlan;
    expect(first.inboundId).toBe('disc:r2@285:in');
    expect(first.outboundId).toBe('disc:r2@285:out');

    const facts = factsOf(first);
    expect(facts.unknownCount).toBe(2);
    expect(facts.worstTurnMarginM).toBeCloseTo(0.354, 3);
    // Ses deux inconnues : le giratoire INVENTÉ de la boucle de sens uniques
    // Voisine 23 / Voisine 29 (défaut H — aucune voie `junction=roundabout`
    // dans OSM, anneau jamais mesuré) et le VRAI giratoire de Voisine 10,
    // dont l'anneau n'est que déclaré.
    expect(unknownsOf(first)).toEqual([
      'ROUNDABOUT@46.0730,-0.9651',
      'ROUNDABOUT@46.0740,-0.9731',
    ]);
  });

  it('LE PLAN DU JURY EST 5ᵉ — trois inconnues contre deux, et rien d’autre', () => {
    expect(rankOf(rankedPlans())).toBe(5);

    const facts = factsOf(juryPlan);
    // Il porte la MÊME pire marge que le rang 1 — le « 128° » à 0,35 m est sur
    // la sortie qu'ils partagent — et il est même plus court (4 123 m contre
    // 4 177 m). Ce qui le retient est le deuxième critère, et lui seul.
    expect(facts.verdict).toBe('HUMAN');
    expect(facts.worstTurnMarginM).toBeCloseTo(0.354, 3);
    expect(Math.round(facts.totalDistanceM)).toBe(4_123);
    expect(facts.unknownCount).toBe(3);

    // LES TROIS INCONNUES, nommées. Deux d'entre elles sont les artefacts que
    // le jury appelle I et J, et elles viennent d'UNE SEULE donnée : les 3,0 m
    // de largeur BD TOPO de la Rue Voisine 14 et de la Rue
    // Voisine 12, déclarés estimés. Le responsable produit, sur cette largeur-là : « Oui, il
    // passe tranquille. »
    expect(unknownsOf(juryPlan)).toEqual([
      // Défaut I — 750 m de droite à 3,0 m. Principe 27 : ce n'est pas un doute.
      'NARROW@46.0772,-0.9587',
      // Le seul doute légitime, partagé avec le rang 1 : le giratoire de la Rue
      // Voisine 10, anneau 4,0 m déclaré pour 5,1 m requis.
      'ROUNDABOUT@46.0740,-0.9731',
      // Défaut J — un « virage 61° » qui est une courbe de 120 à 190 m de
      // rayon, jugée sur la même largeur estimée de 3,0 m.
      'TURN@46.0737,-0.9613',
    ]);
  });

  it('sans les deux artefacts de l’entrée nord-est, il remonte au 2ᵉ rang', () => {
    // Le contrefactuel de I et J corrigés, l'entrée grise ne porte
    // plus que le giratoire. Le jury écrivait « il serait premier » ; il est
    // deuxième, et le premier est instructif.
    const order = rankedPlans(ARTEFACTS_I_ET_J);
    expect(rankOf(order)).toBe(2);

    // `119513478@56:in → 708450424@211:out` n'a AUCUNE inconnue, et « aucune
    // inconnue » passe avant « meilleure marge » (principe 28, critère 2 avant
    // critère 3) — alors même que sa pire marge de virage est de 0,09 m contre
    // 0,35 m. C'est la règle telle que le responsable produit l'a énoncée; si 9 cm de
    // dégagement mesuré doivent un jour peser plus qu'un giratoire à confirmer,
    // c'est une décision à prendre, pas un effet de bord à corriger ici.
    const first = order[0] as RankedPlan;
    expect(first.inboundId).toBe('119513478@56:in');
    expect(first.outboundId).toBe('708450424@211:out');
    const firstFacts = factsOf(first, ARTEFACTS_I_ET_J);
    expect(firstFacts.unknownCount).toBe(0);
    expect(firstFacts.worstTurnMarginM).toBeCloseTo(0.09, 2);

    // Et les deux premiers entrent par le nord-est : l'itinéraire gris, celui
    // que le responsable produit désigne sur la carte. C'est le verdict du jury sur l'entrée.
    expect(order.slice(0, 2).map((plan) => plan.inboundId)).toEqual([
      '119513478@56:in',
      '119513478@56:in',
    ]);
    // Et sa sortie à lui reste celle du jury : Voisine 10.
    expect((order[1] as RankedPlan).outboundId).toBe('disc:r2@285:out');
  });

  it('la règle d’hier mettait ce plan au 4ᵉ rang, sur le nombre de points', () => {
    // Ce que le run a servi, tel quel : le classement d', dont le
    // rang 1 passait par la jambe tronquée.
    expect(juryPlan.rank).toBe(4);
    expect(plans[0]?.outboundId).toBe('disc:r3@250:out:alt1');
    expect(plans[0]?.reasons).toEqual(['shorter']);
  });
});
