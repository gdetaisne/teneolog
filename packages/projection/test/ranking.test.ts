/**
 * Le classement des paires.
 *
 * Ce qui est sous test : l'ORDRE, et rien que lui. Chaque cas isole un
 * critère — les paires ne diffèrent que par lui — puis un cas les fait
 * s'affronter pour vérifier que la lexicographie tient : un critère tranche
 * seul, ou il passe la main.
 *
 * Depuis les critères sont quatre : verdict, INCONNUES, pire marge de
 * VIRAGE, distance (principe 28). Trois anciens critères restent mesurés et
 * servis mais ne classent plus — le nombre de points en doute, la pire marge
 * tous types confondus, la classe de route et le réseau local — et il y a un
 * cas pour chacun, parce que « ça ne classe plus » est une affirmation qui doit
 * tomber si quelqu'un les remet.
 *
 * Le classement est lu à travers `projectTruck` plutôt qu'en appelant
 * `rankPairs` sur des verdicts fabriqués : c'est la chaîne réelle qui doit
 * ordonner, et un verdict écrit à la main dans un test n'a jamais rien prouvé
 * de ce que la mesure produit.
 */
import { describe, expect, it } from 'vitest';
import type { RankedPair } from '@teneolog/domain';

import { gateKeyOf } from '../src/ranking.js';
import {
  CLEARANCE,
  estimatedTurn,
  measured,
  run,
  segment,
  turn,
  unknown,
} from './helpers/pairs-fixture.js';

/** Les ancres, dans l'ordre du classement. */
function order(ranking: readonly RankedPair[]): readonly string[] {
  return ranking.map((entry) => entry.gateKey);
}

/**
 * Ce qu'un 19 t demande dans un virage à 90°, policy de la fixture :
 * `requiredWidthForTurnM(90, pl-19t, 1,0 m)`. Écrit ici pour que les marges
 * attendues plus bas soient des soustractions lisibles plutôt que des
 * constantes tombées du ciel.
 */
const REQUIRED_90 = 5.346;

// ---------------------------------------------------------------------------
// Un critère à la fois
// ---------------------------------------------------------------------------

describe('rankPairs — un critère à la fois', () => {
  it('le verdict d’abord : OK devance HUMAIN, qui devance NON', () => {
    const blocking = segment('bloquant', 'secondary', 500);
    const conclusion = run([
      { gate: 'humaine@0', points: [unknown('NARROW@a')] },
      {
        gate: 'refusee@90',
        segments: [blocking],
        points: [measured('NARROW@b', 2.0)], // 2,0 − 3,3 = −1,3 → NO
      },
      { gate: 'passante@180', points: [measured('NARROW@c', 7.0)] },
    ]);

    expect(order(conclusion.ranking)).toEqual(['passante@180', 'humaine@0', 'refusee@90']);
    expect(conclusion.ranking.map((entry) => entry.verdict)).toEqual(['OK', 'HUMAN', 'NO']);
    expect(conclusion.ranking[0]?.reasons[0]).toBe('verdict_ok');
  });

  it('à verdict égal, l’itinéraire SANS INCONNUE passe devant', () => {
    // Les deux sont HUMAIN, et pour deux raisons qui n'ont rien à voir :
    //  · `estimee@0` : 90° pour 5,0 m disponibles — le calcul dit NON, mais la
    //    largeur est estimée, donc on n'a pas le droit de refuser
    //    (`unmeasured_width_cannot_refuse`). Aucune marge publiée : une INCONNUE.
    //  · `mesuree@90` : 90° pour 5,5 m MESURÉS — marge de 0,15 m, dans la bande
    //    de confort. Un doute, mais un doute qu'on a mesuré.
    const conclusion = run([
      { gate: 'estimee@0', points: [estimatedTurn('TURN@a', 90, 5.0)] },
      { gate: 'mesuree@90', points: [turn('TURN@b', 90, 5.5)] },
    ]);

    expect(conclusion.ranking.map((entry) => entry.verdict)).toEqual(['HUMAN', 'HUMAN']);
    expect(order(conclusion.ranking)).toEqual(['mesuree@90', 'estimee@0']);
    expect(conclusion.ranking[0]?.unknownCount).toBe(0);
    expect(conclusion.ranking[1]?.unknownCount).toBe(1);
    // L'inconnue ne publie AUCUNE marge : c'est ce qui la rend inconnue.
    expect(conclusion.ranking[1]?.worstTurnMarginM).toBeNull();
    expect(conclusion.ranking[0]?.worstTurnMarginM).toBeCloseTo(5.5 - REQUIRED_90, 3);
    // Les deux raisons sont vraies et la DÉCISIVE est en tête : une inconnue ne
    // publiant pas de marge, celle-ci l'emporte aussi sur le silence d'après.
    expect(conclusion.ranking[0]?.reasons).toEqual(['no_unknowns', 'wider_worst_turn_margin']);
  });

  it('un point commun aux deux jambes est UNE question, pas deux', () => {
    // Les deux jambes de la paire portent le même point : l'opérateur y répond
    // une fois. Le compter deux fois rendrait la paire deux fois plus chère.
    const conclusion = run([{ gate: 'seule@0', points: [unknown('NARROW@a')] }]);
    expect(conclusion.ranking[0]?.humanPointCount).toBe(1);
    expect(conclusion.ranking[0]?.unknownCount).toBe(1);
  });

  it('à inconnues égales, la meilleure PIRE MARGE DE VIRAGE passe devant', () => {
    const conclusion = run([
      { gate: 'serre@0', points: [turn('TURN@a', 90, 6.0)] },
      { gate: 'ample@90', points: [turn('TURN@b', 90, 7.0)] },
    ]);

    expect(order(conclusion.ranking)).toEqual(['ample@90', 'serre@0']);
    expect(conclusion.ranking[0]?.worstTurnMarginM).toBeCloseTo(7.0 - REQUIRED_90, 3);
    expect(conclusion.ranking[1]?.worstTurnMarginM).toBeCloseTo(6.0 - REQUIRED_90, 3);
    expect(conclusion.ranking[0]?.reasons).toEqual(['wider_worst_turn_margin']);
  });

  it('la pire marge du classement est la PIRE des virages, signe compris', () => {
    const conclusion = run([
      { gate: 'seule@0', points: [turn('TURN@a', 90, 7.0), turn('TURN@b', 90, 6.0)] },
    ]);
    expect(conclusion.ranking[0]?.worstTurnMarginM).toBeCloseTo(6.0 - REQUIRED_90, 3);
  });

  it('une marge de virage absente n’est pas une marge nulle : elle passe en dernier', () => {
    // `muette@0` n'a aucun virage : elle est OK comme l'autre, mais elle n'a
    // produit aucun argument pour passer devant. Une absence n'achète pas un
    // rang — ce serait faire d'un silence une permission.
    const conclusion = run([
      { gate: 'muette@0', points: [] },
      { gate: 'mesuree@90', points: [turn('TURN@b', 90, 7.0)] },
    ]);

    expect(conclusion.ranking.map((entry) => entry.verdict)).toEqual(['OK', 'OK']);
    expect(order(conclusion.ranking)).toEqual(['mesuree@90', 'muette@0']);
    expect(conclusion.ranking[1]?.worstTurnMarginM).toBeNull();
    expect(conclusion.ranking[0]?.reasons).toEqual(['wider_worst_turn_margin']);
  });

  it('la distance ne parle qu’en dernier, et elle parle', () => {
    const shared = turn('TURN@commun', 90, 7.0);
    const conclusion = run([
      { gate: 'loin@0', legDistanceM: 4_000, points: [shared] },
      { gate: 'pres@90', legDistanceM: 1_000, points: [shared] },
    ]);

    expect(order(conclusion.ranking)).toEqual(['pres@90', 'loin@0']);
    expect(conclusion.ranking[0]?.totalDistanceM).toBe(2_000);
    expect(conclusion.ranking[1]?.totalDistanceM).toBe(8_000);
    expect(conclusion.ranking[0]?.reasons).toEqual(['shorter']);
  });
});

// ---------------------------------------------------------------------------
// Ce qui ne classe plus — mesuré, servi, sans effet sur l'ordre
// ---------------------------------------------------------------------------

describe('rankPairs — ce qui ne classe plus', () => {
  it('le NOMBRE de points en doute ne classe plus : c’est la pire marge qui décide', () => {
    // `trois@0` porte trois virages confortables, `un@90` un seul virage plus
    // serré. L'ancien critère n° 2 aurait mis `un@90` devant « parce qu'il y a
    // moins à contrôler » — c'est ce qui faisait gagner à Thairé la jambe
    // tronquée à 604 m, celle qu'on avait le moins regardée.
    const conclusion = run([
      {
        gate: 'trois@0',
        points: [turn('TURN@a', 90, 7.0), turn('TURN@b', 90, 7.0), turn('TURN@c', 90, 7.0)],
      },
      { gate: 'un@90', points: [turn('TURN@d', 90, 6.0)] },
    ]);

    expect(order(conclusion.ranking)).toEqual(['trois@0', 'un@90']);
    expect(conclusion.ranking[0]?.humanPointCount).toBe(0);
    expect(conclusion.ranking[0]?.reasons).toEqual(['wider_worst_turn_margin']);
  });

  it('principe 27 — une SECTION DROITE étroite ne pèse pas dans l’ordre', () => {
    // Deux paires identiques au virage près : aucune. Elles ne diffèrent que
    // par la largeur d'une droite, 4,0 m contre 7,0 m. Le responsable produit : « je n'ai
    // jamais vu un 3 m en sens unique où un 19 t ne pouvait vraiment pas
    // passer. Ce sont les virages les vrais problèmes. » Rien ne les départage
    // donc, et c'est l'ordre d'azimut qui tranche.
    const conclusion = run([
      { gate: 'etroite@0', points: [measured('NARROW@a', 4.0)] },
      { gate: 'large@90', points: [measured('NARROW@b', 7.0)] },
    ]);

    expect(order(conclusion.ranking)).toEqual(['etroite@0', 'large@90']);
    expect(conclusion.ranking.map((entry) => entry.reasons)).toEqual([[], []]);
    // La mesure, elle, est bien là — et elle diffère. Elle est servie, pas lue.
    expect(conclusion.ranking[0]?.worstMarginM).toBeCloseTo(4.0 - CLEARANCE, 6);
    expect(conclusion.ranking[1]?.worstMarginM).toBeCloseTo(7.0 - CLEARANCE, 6);
    expect(conclusion.ranking[0]?.worstTurnMarginM).toBeNull();
    expect(conclusion.ranking[1]?.worstTurnMarginM).toBeNull();
  });

  it('la CLASSE de route ne classe plus, et reste mesurée', () => {
    // Principe 15 : la classe n'est pas une preuve. À Thairé, 83 tertiaires et
    // zéro primaire — la classe n'y sépare rien de ce qui compte.
    const shared = turn('TURN@commun', 90, 7.0);
    const conclusion = run([
      { gate: 'tertiaire@0', segments: [segment('t', 'tertiary', 500)], points: [shared] },
      { gate: 'primaire@90', segments: [segment('p', 'primary', 500)], points: [shared] },
    ]);

    expect(order(conclusion.ranking)).toEqual(['tertiaire@0', 'primaire@90']);
    expect(conclusion.ranking.map((entry) => entry.reasons)).toEqual([[], []]);
    expect(conclusion.ranking[0]?.worstHighwayRank).toBe(5);
    expect(conclusion.ranking[1]?.worstHighwayRank).toBe(3);
  });

  it('le RÉSEAU LOCAL ne classe plus, et reste mesuré', () => {
    const shared = turn('TURN@commun', 90, 7.0);
    const conclusion = run([
      {
        gate: 'longue@0',
        segments: [segment('s', 'secondary', 500), segment('r', 'residential', 900)],
        points: [shared],
      },
      {
        gate: 'courte@90',
        segments: [segment('s', 'secondary', 500), segment('r', 'residential', 200)],
        points: [shared],
      },
    ]);

    expect(order(conclusion.ranking)).toEqual(['longue@0', 'courte@90']);
    expect(conclusion.ranking.map((entry) => entry.reasons)).toEqual([[], []]);
    // Les deux jambes de la paire comptent : 900 m à l'aller, 900 m au retour.
    expect(conclusion.ranking[0]?.localNetworkLengthM).toBeCloseTo(1_800, 6);
    expect(conclusion.ranking[1]?.localNetworkLengthM).toBeCloseTo(400, 6);
  });

  it('`unclassified` est structurante, `service` ne l’est pas — le vocabulaire des ancres', () => {
    const shared = turn('TURN@commun', 90, 7.0);
    const conclusion = run([
      {
        gate: 'seule@0',
        segments: [segment('u', 'unclassified', 700), segment('v', 'service', 30)],
        points: [shared],
      },
    ]);
    expect(conclusion.ranking[0]?.localNetworkLengthM).toBeCloseTo(60, 6);
  });
});

// ---------------------------------------------------------------------------
// La lexicographie
// ---------------------------------------------------------------------------

describe('rankPairs — la lexicographie tient', () => {
  it('un critère tranche seul : 30 km de détour n’achètent pas un verdict', () => {
    const conclusion = run([
      { gate: 'proche-douteuse@0', legDistanceM: 500, points: [unknown('NARROW@a')] },
      { gate: 'lointaine-sure@90', legDistanceM: 30_000, points: [measured('NARROW@b', 7.0)] },
    ]);
    expect(order(conclusion.ranking)).toEqual(['lointaine-sure@90', 'proche-douteuse@0']);
  });

  it('trois mètres de marge de virage n’achètent pas une inconnue de moins', () => {
    const conclusion = run([
      { gate: 'large-inconnue@0', points: [turn('TURN@a', 90, 9.0), unknown('NARROW@b')] },
      { gate: 'juste-connue@90', points: [turn('TURN@c', 90, 6.0)] },
    ]);
    expect(order(conclusion.ranking)).toEqual(['juste-connue@90', 'large-inconnue@0']);
    expect(conclusion.ranking[0]?.reasons).toEqual(['verdict_ok', 'no_unknowns']);
  });

  it('les raisons listent tout ce sur quoi la paire devance la suivante, la décisive en tête', () => {
    const conclusion = run([
      { gate: 'derriere@0', legDistanceM: 4_000, points: [turn('TURN@a', 90, 6.0)] },
      { gate: 'devant@90', legDistanceM: 1_000, points: [turn('TURN@b', 90, 7.0)] },
    ]);

    expect(conclusion.ranking[0]?.reasons).toEqual(['wider_worst_turn_margin', 'shorter']);
    // La dernière paire n'a personne à devancer : elle ne plaide rien.
    expect(conclusion.ranking[1]?.reasons).toEqual([]);
  });

  it('égalité totale : l’ordre d’azimut tranche, comme concludePairs', () => {
    const shared = turn('TURN@commun', 90, 7.0);
    const conclusion = run([
      { gate: 'premiere@0', points: [shared] },
      { gate: 'seconde@90', points: [shared] },
      { gate: 'troisieme@180', points: [shared] },
    ]);

    expect(order(conclusion.ranking)).toEqual(['premiere@0', 'seconde@90', 'troisieme@180']);
    // Rien ne les sépare : aucune ne plaide quoi que ce soit.
    expect(conclusion.ranking.map((entry) => entry.reasons)).toEqual([[], [], []]);
    // Et le classement est d'accord avec la conclusion, qui garde la première.
    expect(conclusion.rankingDisagreesWithVia).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// La forme du classement
// ---------------------------------------------------------------------------

describe('rankPairs — la forme', () => {
  it('les rangs sont denses et contigus, une paire par ancre', () => {
    const shared = turn('TURN@commun', 90, 7.0);
    const conclusion = run([
      { gate: 'a@0', points: [shared] },
      { gate: 'b@90', points: [shared] },
      { gate: 'c@180', points: [shared] },
    ]);

    expect(conclusion.ranking.map((entry) => entry.rank)).toEqual([1, 2, 3]);
    for (const entry of conclusion.ranking) {
      expect(entry.inboundId).toBe(`${entry.gateKey}:in`);
      expect(entry.outboundId).toBe(`${entry.gateKey}:out`);
    }
  });

  it('aucune paire → aucun classement, et aucun désaccord à signaler', () => {
    const conclusion = run([]);
    expect(conclusion.ranking).toEqual([]);
    expect(conclusion.rankingDisagreesWithVia).toBe(false);
  });

  it('gateKeyOf retrouve l’ancre, alternative comprise', () => {
    expect(gateKeyOf('708450424@211:out')).toBe('708450424@211');
    expect(gateKeyOf('708450424@211:in')).toBe('708450424@211');
    expect(gateKeyOf('708450424@211:out:alt1')).toBe('708450424@211');
  });
});
