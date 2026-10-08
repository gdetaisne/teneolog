/**
 * LE TEST D'OR DU COIN DE THAIRÉ.
 *
 * `TURN@46.0733,-0.9649`, le coin Rue de l’Exemple / Rue Voisine 23, vu des
 * deux jambes qui l'atteignent : la grise `119513478@56:in` arrive par la Rue
 * Voisine 14 (3,0 m déclarés BD TOPO) et tourne de 57° ; la bleue
 * `disc:r2@285:in` arrive par Exemple (5,2 m) et tourne de 98°. Même lieu, même
 * référence, deux manœuvres — c'est toute la tâche, et c'est le tableau du
 * §10.1 de la note de conception interne.
 *
 * CE QU'IL FIGE, et pourquoi ces nombres-là. Les six cases (deux jambes × trois
 * gabarits) sont écrites au dixième, jamais en fourchette : une fourchette
 * aurait laissé passer exactement le défaut que la tâche corrige — la grise
 * prêtant ses 57° et ses 3,0 m à la bleue tient dans « entre 50 et 105 degrés ».
 * Le 19 t à −0,15 m sur la bleue et le fourgon à +1,04 m au même endroit ne se
 * distinguent que par le nombre.
 *
 * (constat L6-4) a corrigé une de ces six cases : le semi 44 t était
 * jugé sur l'empattement de son tracteur (3,9 m), donc « OK, +1,13 m » sur la
 * bleue. Sellette → essieu (7,70 m, principe 31), il y doute — et le test le
 * dit maintenant, avec le nombre.
 *
 * D'OÙ VIENNENT LES FAITS. Le décor — fixtures, policy de référence, catalogue — est
 * monté dans `helpers/thaire-corner.ts`, partagé avec le test d'or du
 * CLASSEMENT sur le même coin (`thaire-corner-ranking-golden.test.ts`,
 * ) : deux montages seraient deux corpus qui divergent (principe 23).
 *
 * CE QU'IL NE DIT PAS. Que ces verdicts sont les bons : les 3,0 m de la Rue
 * Voisine 14 restent le « doute de largeur » que le jury a laissé ouvert (principe
 * 27, défaut I). Il dit que chaque jambe répond de SA mesure — et il refusera
 * le jour où l'une répondra pour l'autre.
 */
import { describe, expect, it } from 'vitest';
import type { CriticalPoint, Fact, PointGeometry, TruckProfile } from '@teneolog/domain';
import { haversineM } from '@teneolog/topology';

import { evaluatePoint } from '../src/evaluators.js';
import {
  BLUE,
  CORNER,
  collectFor,
  GREY,
  POLICY,
  STOP_WIDTH_UNKNOWN,
  TRUCKS,
  truck,
} from './helpers/thaire-corner.js';

const { collected: COLLECTED } = collectFor([GREY, BLUE], STOP_WIDTH_UNKNOWN);

const CORNER_POINT = ((): CriticalPoint => {
  const found = COLLECTED.points.find((p) => p.type === 'TURN' && haversineM(p.at, CORNER) <= 25);
  if (found === undefined) throw new Error('le coin Exemple / Voisine 23 n’est pas dans le relevé');
  return found;
})();

/** La géométrie que CETTE jambe a mesurée à ce coin. */
function geometryOf(candidateId: string): Fact<PointGeometry> {
  const found = COLLECTED.geometryByCandidate.get(candidateId)?.get(CORNER_POINT.ref);
  if (found === undefined) throw new Error(`pas de géométrie pour ${candidateId}`);
  return found;
}

/** L'angle et la largeur d'approche, tels que cette jambe les porte. */
function turnOf(candidateId: string): { deflectionDeg: number; freeM: number; kind: string } {
  const geometry = geometryOf(candidateId);
  if (!geometry.known || geometry.value.type !== 'TURN') throw new Error('pas un virage connu');
  const width = geometry.value.geometry.approachWidth;
  if (!width.known) throw new Error(`largeur inconnue pour ${candidateId}`);
  return {
    deflectionDeg: geometry.value.geometry.deflectionDeg,
    freeM: width.value.freeM,
    kind: geometry.value.geometry.kind,
  };
}

function judge(candidateId: string, profile: TruckProfile): ReturnType<typeof evaluatePoint> {
  return evaluatePoint({ ...CORNER_POINT, geometry: geometryOf(candidateId) }, profile, POLICY);
}

describe('Thairé, le coin Exemple / Voisine 23 — la géométrie, au dixième', () => {
  it('la grise tourne de 57,3° dans 3,0 m ; la bleue de 97,9° dans 5,2 m', () => {
    const grey = turnOf(GREY);
    expect(grey.kind).toBe('junction');
    expect(grey.deflectionDeg).toBeCloseTo(57.3, 1);
    // La Rue Voisine 14, d'où la grise débouche — 3,0 m BD TOPO.
    expect(grey.freeM).toBeCloseTo(3.0, 3);

    const blue = turnOf(BLUE);
    expect(blue.kind).toBe('junction');
    expect(blue.deflectionDeg).toBeCloseTo(97.9, 1);
    // Exemple / Voisine 23 — 5,2 m.
    expect(blue.freeM).toBeCloseTo(5.2, 3);
  });

  it('une seule référence pour les deux : le lieu est partagé, la géométrie non', () => {
    expect(COLLECTED.points.filter((p) => p.type === 'TURN' && haversineM(p.at, CORNER) <= 25))
      .toHaveLength(1);
    expect(COLLECTED.byCandidate.get(GREY)).toContain(CORNER_POINT.ref);
    expect(COLLECTED.byCandidate.get(BLUE)).toContain(CORNER_POINT.ref);
  });
});

describe('Thairé, le même coin — un verdict par gabarit et par jambe', () => {
  /**
   * LA GRISE : 57,3° dans 3,0 m. Sous le balayage requis des trois gabarits
   * (3,77 m, 4,68 m, 4,90 m — le dernier était 3,88 m, quand le
   * semi était jugé sur son tracteur) — mais la largeur est DÉCLARÉE, jamais mesurée,
   * donc aucun refus n'est permis (principe 5) et aucune marge n'est publiée :
   * c'est une inconnue au sens du principe 28, pas un mur.
   */
  it('la grise : les trois camions posent la même question, sans marge', () => {
    for (const t of TRUCKS) {
      const verdict = judge(GREY, t);
      expect(verdict.verdict, t.id).toBe('HUMAN');
      expect(verdict.marginM, t.id).toBeNull();
      expect(verdict.reasonCodes, t.id).toEqual([
        'turn_swept_width',
        'unmeasured_width_cannot_refuse',
      ]);
    }
  });

  /**
   * LA BLEUE : 97,9° dans 5,2 m. Le virage est plus fermé et la rue plus large,
   * et ces deux effets ne vont pas dans le même sens selon le gabarit — c'est
   * pourquoi la réponse se sépare ici, et pourquoi hériter d'une jambe était un
   * défaut et non une prudence.
   */
  it('la bleue : le fourgon passe de 1,04 m', () => {
    const fourgon = judge(BLUE, truck('vul-fourgon'));
    expect(fourgon.verdict).toBe('OK');
    expect(fourgon.marginM ?? 0).toBeCloseTo(1.04, 2);
  });

  /**
   * LE SEMI, CORRIGÉ —, constat L6-4.
   *
   * Ce test figeait « le semi passe de 1,13 m », et c'était la valeur d'un
   * 44 t jugé sur l'empattement de son TRACTEUR (3,9 m) : 0,52 m de déport,
   * 4,07 m requis dans un angle droit, moins qu'un porteur 19 t. Le principe 31
   * dit l'inverse — sellette → essieu, 7,70 m comme l'engine — donc 2,13 m de
   * déport et 5,68 m requis ici : 5,2 m disponibles, −0,48 m. La largeur des
   * 5,2 m étant DÉCLARÉE, ce déficit reste une question et jamais un refus
   * (principe 5), exactement comme pour le 19 t juste en dessous.
   *
   * C'est le « faux Certain qui tombe » que le principe 31 annonce, et il est
   * nommé : sur ce coin, le 44 t passait « Certain » là où le 19 t doutait.
   */
  it('la bleue : le semi, lui, doute — 5,68 m requis contre 5,2 m', () => {
    const semi = judge(BLUE, truck('semi-44t'));
    expect(semi.verdict).toBe('HUMAN');
    expect(semi.marginM).toBeNull();
    expect(semi.reasonCodes).toEqual(['turn_swept_width', 'unmeasured_width_cannot_refuse']);
    expect(semi.explanation).toContain('5.2 m disponibles pour 5.7 m requis');
  });

  it('la bleue : le 19 t, lui, reste une question — 5,35 m requis contre 5,2 m', () => {
    // −0,15 m. La vraie difficulté du 19 t à ce coin, celle que les 57° de la
    // grise cachaient. Et elle ne publie PAS sa marge : la largeur est
    // déclarée, donc le déficit reste une question, jamais un refus.
    const dixNeuf = judge(BLUE, truck('pl-19t'));
    expect(dixNeuf.verdict).toBe('HUMAN');
    expect(dixNeuf.marginM).toBeNull();
    expect(dixNeuf.reasonCodes).toEqual(['turn_swept_width', 'unmeasured_width_cannot_refuse']);
    expect(dixNeuf.explanation).toContain('5.2 m disponibles pour 5.3 m requis');
  });

  it('et c’est là que les deux jambes se séparent', () => {
    // La bascule n'est pas un accident d'arrondi : pour le fourgon, la grise
    // dit « question » et la bleue dit « OK », au même lieu, dans le même run.
    // Tant que la géométrie était partagée, une seule des deux réponses
    // existait — celle de la première jambe de la liste.
    expect(judge(GREY, truck('vul-fourgon')).verdict).toBe('HUMAN');
    expect(judge(BLUE, truck('vul-fourgon')).verdict).toBe('OK');

    // Le semi,, doute des DEUX côtés — 5,68 m requis contre
    // 3,0 m et contre 5,2 m. Il ne sépare plus les deux jambes ici, et c'est
    // la physique : la séparation qu'il montrait était celle d'un déport de
    // tracteur. Les deux questions restent des questions, jamais des refus.
    expect(judge(GREY, truck('semi-44t')).verdict).toBe('HUMAN');
    expect(judge(BLUE, truck('semi-44t')).verdict).toBe('HUMAN');
  });
});
