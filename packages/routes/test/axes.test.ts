/**
 * l'étage axes sur des mondes synthétiques, en mètres lisibles.
 *
 * Ce qui est jugé ici, et rien d'autre : la règle d'arrêt par anneaux, la
 * répartition par secteurs, les filtres d'une porte, et le repli quand il n'y
 * a aucun axe à 15 km. Chaque monde est décrit en mètres depuis l'arrêt pour
 * qu'un lecteur puisse vérifier un seuil de tête — 25 m de jonction, 20° de
 * branche, 30° de secteur.
 */
import { describe, expect, it } from 'vitest';
import type { RoadWay } from '@teneolog/topology';

import { distinctDirections, sectorOf } from '../src/axes-geometry.js';
import { findAxisGates } from '../src/axes-gates.js';
import { findAxisCorridors, prepareAxisNetwork } from '../src/axes-network.js';
import { selectAxisGates, selectBandGates, uncontrolledApproaches } from '../src/axes-select.js';
import { runAxisStage, type AxisSourcePort, type AxisStageParams } from '../src/axes-stage.js';
import { at, O, PARAMS, RINGS, sourceOf, way } from './axes-world.js';

describe('deux portes ne font deux directions qu’à 60° d’écart', () => {
  const directions = (sectors: readonly number[]): readonly number[] =>
    distinctDirections(sectors, 12, 60);

  it('9 et 10 — les deux secteurs de Thairé — sont UNE direction', () => {
    expect(directions([9, 10])).toEqual([9]);
  });

  it('9 et 11 sont DEUX directions : un secteur vide les sépare', () => {
    expect(directions([9, 11])).toEqual([9, 11]);
  });

  it('0 et 11 sont UNE direction : ils se touchent par le bord du cercle', () => {
    expect(directions([0, 11])).toEqual([11]);
  });

  /**
   * L'ÉCART SE MESURE ENTRE DEUX PORTES, PAS DE PROCHE EN PROCHE. La première
   * écriture chaînait les secteurs adjacents et rendait `[9]` ici — un
   * éventail continu comptait pour une seule direction, si large soit-il.
   * Mesuré sur le corpus (§12.2 du rapport), ce chaînage lisait les 150°
   * d'éventail de Clamart comme une approche unique et lui faisait perdre ses
   * ancres. 9 et 11 sont bien à 60°, donc deux directions, que 10 soit occupé
   * ou non.
   */
  it('9, 10 et 11 font DEUX directions : 9 et 11 sont à 60°, 10 ne les recolle pas', () => {
    expect(directions([9, 10, 11])).toEqual([9, 11]);
  });

  it('l’éventail 0–4 de Clamart (150°) fait TROIS directions, pas une', () => {
    expect(directions([0, 1, 2, 3, 4])).toEqual([0, 2, 4]);
  });

  it('les quatre secteurs contigus d’Aigrefeuille font DEUX directions', () => {
    expect(directions([4, 5, 6, 7])).toEqual([4, 6]);
  });

  it('les quatre azimuts mesurés à Thairé (290, 294, 305, 307°) font UNE direction', () => {
    const sectors = [290, 294, 305, 307].map((azimuth) => sectorOf(azimuth, 12));
    expect(sectors).toEqual([9, 9, 10, 10]);
    expect(directions(sectors)).toHaveLength(1);
  });

  it('un seul secteur, aucun secteur, et les douze : 1, 0 et 6 directions', () => {
    expect(directions([4])).toEqual([4]);
    expect(directions([])).toEqual([]);
    // Des portes tout autour : une tous les 60°, soit six approches — et non
    // une seule, ce que le chaînage rendait.
    expect(directions([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])).toEqual([0, 2, 4, 6, 8, 10]);
  });

  /**
   * LE DÉPART EST CANONIQUE : le compte ne doit pas dépendre de l'origine des
   * azimuts. On commence au secteur qui suit le plus grand vide, donc au début
   * de l'éventail réel — tourner tout le monde d'un secteur ne change rien.
   */
  it('tourner l’éventail d’un secteur ne change pas le compte', () => {
    const base = [0, 1, 2, 3, 4];
    for (let turn = 0; turn < 12; turn += 1) {
      const turned = base.map((sector) => (sector + turn) % 12);
      expect(directions(turned)).toHaveLength(3);
    }
  });

  it('la règle d’hier se relit en posant l’écart à un seul secteur', () => {
    expect(distinctDirections([9, 10], 12, 30)).toEqual([9, 10]);
  });
});

// ------------------------------------------------------- anneaux et secteurs --

/**
 * LE CRITÈRE D'ARRÊT COMPTE LES DIRECTIONS DES PORTES
 * RETENUES, pas les secteurs des axes.
 *
 * Les mondes sont écrits pour que la différence entre les deux règles soit
 * visible à l'œil : un axe occupe UN secteur et porte DEUX portes dans deux
 * directions. L'ancienne règle (« ≥ n secteurs d'axes ») n'aurait pas su le
 * lire, et c'est ce qui envoyait Aigrefeuille chercher à 5 km ce qui passait à
 * moins de 2 km (rapport §8).
 */
describe('le rayon est adaptatif : le premier anneau qui rend assez de DIRECTIONS gagne', () => {
  /** Un axe est-ouest à `northM`, assez long pour traverser tous les anneaux courts. */
  function eastWestAxis(id: string, northM: number): RoadWay {
    return way(id, [at(northM, -900), at(northM, 900)], 3, { name: `D${northM}` });
  }

  it('un seul secteur d’axe, mais deux portes en deux directions : l’anneau de 500 m suffit', async () => {
    const world = [
      eastWestAxis('AX', 400),
      // Deux rues locales qui quittent le MÊME axe, de part et d'autre : leurs
      // jonctions sont à 500 m de l'arrêt, à ±37° du nord — deux secteurs.
      way('L1', [at(400, 300), at(120, 90)], 4),
      way('L2', [at(400, -300), at(120, -90)], 4),
    ];
    const search = await runAxisStage({ stop: O, source: sourceOf(world), params: PARAMS });

    expect(search.reason).toBe('ring_reached');
    expect(search.reachedRingM).toBe(500);
    // UN secteur d'axe, DEUX directions de portes : c'est toute la correction.
    expect(search.sectorsCovered).toHaveLength(1);
    expect(search.gateDirections).toEqual([1, 10]);
    expect(search.retained).toHaveLength(2);
  });

  it('une porte à 33 m dans une seule direction ne suffit plus : on continue', async () => {
    const world = [
      eastWestAxis('PROCHE', 33),
      way('L1', [at(33, 0), at(5, 0)], 4),
      way('LOIN', [at(-900, 400), at(900, 400)], 3),
      way('L2', [at(0, 400), at(0, 40)], 4),
    ];

    // La règle de l'engine (une direction suffit) : Auxerre se fige à 50 m.
    const one = await runAxisStage({
      stop: O,
      source: sourceOf(world),
      params: { ...PARAMS, minGateDirections: 1 },
    });
    expect(one.reachedRingM).toBe(50);
    expect(one.gateDirections).toEqual([0]);

    // La règle livrée : on va chercher la seconde direction, et on la trouve.
    const two = await runAxisStage({ stop: O, source: sourceOf(world), params: PARAMS });
    expect(two.reason).toBe('ring_reached');
    expect(two.reachedRingM).toBe(500);
    // Plein est : l'azimut initial du grand cercle est 89,9°, donc le secteur 2.
    expect(two.gateDirections).toEqual([0, 2]);
  });

  it('un axe à 3 km ne se voit ni à 500 m ni à 2 km : l’anneau retenu est 5 km', async () => {
    const world = [
      // Un axe assez LARGE pour porter deux portes à 60° l'une de l'autre :
      // depuis le 2026-09-14 au soir, deux portes à ±300 m sur un axe à 3 km
      // sont dans deux secteurs VOISINS (0 et 11), donc une seule direction.
      way('AX', [at(3_000, -4_000), at(3_000, 4_000)], 3, { name: 'D3000' }),
      way('L1', [at(3_000, 3_000), at(2_600, 2_600)], 4),
      way('L2', [at(3_000, -3_000), at(2_600, -2_600)], 4),
    ];
    const search = await runAxisStage({ stop: O, source: sourceOf(world), params: PARAMS });
    expect(search.reason).toBe('ring_reached');
    expect(search.reachedRingM).toBe(5_000);
    expect(search.gateDirections).toHaveLength(2);
  });

  /**
   * UNE DIRECTION VAUT MIEUX QUE RIEN (principe 5). Aucun anneau, jusqu'à
   * 15 km, ne rend deux directions : on garde le meilleur anneau atteint —
   * le plus de directions, puis le plus de portes, puis LE PLUS COURT
   * (principe 34) — et le motif le DIT.
   *
   * LE GARDE-FOU DU PRINCIPE 34. Une porte est déjà
   * retenue à 33 m (un anneau ≤ `escalationBoundM`) : l'étage continue
   * seulement À L'INTÉRIEUR du cercle de 2 km pour chercher la seconde
   * direction (250 → 500 → 2 000), et s'arrête NET une fois le cercle
   * épuisé — jamais l'anneau de 5 000 m, jamais celui de 15 000 m. Avant ce
   * garde-fou, les trois vagues d'axes (500, 5 000, 15 000) étaient toutes
   * demandées quand même (rapport §9.4).
   */
  it('aucun anneau à deux directions sous 2 km : le meilleur y est gardé, borné au cercle', async () => {
    const world = [eastWestAxis('PROCHE', 33), way('L1', [at(33, 0), at(5, 0)], 4)];
    const calls: string[] = [];
    const search = await runAxisStage({ stop: O, source: sourceOf(world, calls), params: PARAMS });

    expect(search.reason).toBe('best_ring_kept');
    expect(search.reachedRingM).toBe(50);
    expect(search.gateDirections).toEqual([0]);
    expect(search.retained).toHaveLength(1);
    expect(search.fallback).toBe('axes');
    expect(search.boundedByPrinciple34).toBe(true);
    // Anneaux 250, 500 et 2 000 sondés (à l'intérieur du cercle) — jamais
    // 5 000 : le garde-fou coupe avant.
    const ringsProbed = new Set(search.ringProbes.map((probe) => probe.ringM));
    expect(ringsProbed.has(250)).toBe(true);
    expect(ringsProbed.has(500)).toBe(true);
    expect(ringsProbed.has(2_000)).toBe(true);
    expect(ringsProbed.has(5_000)).toBe(false);
    expect(ringsProbed.has(15_000)).toBe(false);
    // Deux vagues d'axes seulement (500 m, puis 5 000 m pour atteindre
    // l'anneau de 2 000 m) — jamais la troisième (15 000 m).
    expect(calls.filter((c) => c.endsWith(':2-3'))).toEqual(['500:2-3', '5000:2-3']);
  });

  /**
   * L'AUTRE MOITIÉ DE LA RÈGLE : rien sous 2 km ne justifie de
   * s'arrêter, l'escalade doit aller jusqu'au bout (5, puis 10, puis 15 km).
   */
  it('aucune porte sous 2 km : l’escalade va jusqu’à 5, 10 puis 15 km', async () => {
    // Un seul axe, à 6 km — hors de portée du cercle de 2 km ET de la vague
    // de 5 000 m : seule la vague de 15 000 m le rapporte, et il ne registre
    // qu'à l'anneau de 10 000 m (6 000 > 5 000).
    const world = [eastWestAxis('LOIN', 6_000), way('L1', [at(6_000, 0), at(5_700, 0)], 4)];
    const calls: string[] = [];
    const search = await runAxisStage({ stop: O, source: sourceOf(world, calls), params: PARAMS });

    expect(search.reason).toBe('best_ring_kept');
    expect(search.reachedRingM).toBe(10_000);
    expect(search.gateDirections).toEqual([0]);
    expect(search.boundedByPrinciple34).toBe(false);
    // Les trois vagues ont bien été demandées : rien sous 2 km ne coupe l'escalade.
    expect(calls.filter((c) => c.endsWith(':2-3'))).toEqual(['500:2-3', '5000:2-3', '15000:2-3']);
  });

  /**
   * LE GARDE-FOU NE SE
   * DÉCLENCHE QUE SUR UNE PORTE RETENUE, PAS SUR UN AXE TROUVÉ. Le code
   * (`axes-rings.ts` l.146) ne lève `foundWithinCircle` que quand
   * `attempt.selection.retained.length > 0` ; un axe sous 2 km SANS aucune
   * rue locale ne pose aucune porte et ne doit donc rien couper.
   */
  it('un axe sous 2 km sans aucune porte retenue : l’escalade continue au-delà', async () => {
    const world = [
      // Un axe nord-sud à l'est (E = 400), à ~412 m — dans le cercle de 2 km,
      // mais AUCUNE rue locale : zéro porte peut s'y poser. Décalé de l'axe
      // nord-sud (E = 0) où vit la rue locale de LOIN plus bas, pour que sa
      // corde jonction → adresse ne le croise jamais (`chord_crosses_retained_axis`
      // le rejetterait sinon, et ce n'est pas ce que ce cas veut montrer).
      way('PROCHE', [at(700, 400), at(100, 400)], 3, { name: 'D-proche' }),
      // Le seul axe qui porte une direction est à 6 km, hors du cercle.
      eastWestAxis('LOIN', 6_000),
      way('L1', [at(6_000, 0), at(5_700, 0)], 4),
    ];
    const calls: string[] = [];
    const search = await runAxisStage({ stop: O, source: sourceOf(world, calls), params: PARAMS });

    expect(search.reason).toBe('best_ring_kept');
    expect(search.reachedRingM).toBe(10_000);
    // L'axe à 412 m a bien été VU, sous le cercle — et n'a rien retenu.
    const under2km = search.ringProbes.find((probe) => probe.ringM === 2_000);
    expect(under2km?.axes).toBeGreaterThan(0);
    expect(under2km?.gatesRetained).toBe(0);
    expect(search.boundedByPrinciple34).toBe(false);
    // Les trois vagues ont bien été demandées : un axe SANS porte retenue,
    // même sous 2 km, ne coupe pas l'escalade.
    expect(calls.filter((c) => c.endsWith(':2-3'))).toEqual(['500:2-3', '5000:2-3', '15000:2-3']);
  });

  /** deux directions dès le premier anneau qui les offre : arrêt net, rien de plus. */
  it('deux directions dès 250 m : arrêt à 250, jamais 500 ni au-delà', async () => {
    const world = [
      eastWestAxis('AX', 200),
      way('L1', [at(200, 150), at(60, 45)], 4),
      way('L2', [at(200, -150), at(60, -45)], 4),
    ];
    const calls: string[] = [];
    const search = await runAxisStage({ stop: O, source: sourceOf(world, calls), params: PARAMS });

    expect(search.reason).toBe('ring_reached');
    expect(search.reachedRingM).toBe(250);
    expect(search.gateDirections).toHaveLength(2);
    expect(search.boundedByPrinciple34).toBe(false);
    const ringsProbed = search.ringProbes.map((probe) => probe.ringM);
    expect(ringsProbed).toEqual([50, 250]);
    expect(calls.filter((c) => c.endsWith(':2-3'))).toEqual(['500:2-3']);
  });

  /**
   * LE CONSTAT DE THAIRÉ, EN LABORATOIRE : deux
   * portes dans deux secteurs VOISINS ne sont pas deux directions, et l'anneau
   * qui ne porte qu'elles ne suffit plus.
   *
   * Le monde est celui du run chaud : un axe à l'ouest (azimuts 270 et 307°,
   * secteurs 9 et 10 — les quatre portes de Thairé étaient à 290, 294, 305 et
   * 307°) et, plus loin, un second axe à l'est. La règle d'hier s'arrêtait au
   * premier ; celle d'aujourd'hui va chercher le second, et le trouve DANS le
   * cercle.
   */
  it('deux secteurs voisins ne suffisent plus : l’étage va chercher la vraie seconde direction', async () => {
    const world = [
      // À l'ouest, à 400 m : un axe nord-sud qui porte DEUX portes, l'une plein
      // ouest (secteur 9), l'autre à 307° (secteur 10) — voisines.
      way('OUEST', [at(-900, -400), at(900, -400)], 3, { name: 'D-ouest' }),
      way('L-270', [at(0, -400), at(0, -100)], 4),
      way('L-307', [at(300, -400), at(100, -150)], 4),
      // À l'est, à 1 500 m : la vraie seconde direction (secteur 3).
      way('EST', [at(-900, 1_500), at(900, 1_500)], 3, { name: 'D-est' }),
      way('L-090', [at(0, 1_500), at(0, 1_200)], 4),
    ];

    const search = await runAxisStage({ stop: O, source: sourceOf(world), params: PARAMS });
    expect(search.reason).toBe('ring_reached');
    expect(search.reachedRingM).toBe(2_000);
    // Les trois portes sont bien retenues, dans les secteurs 9, 10 et 2 (l'azimut du grand cercle vers l'est est 89,9°)…
    expect(new Set(search.retained.map((gate) => gate.sector))).toEqual(new Set([2, 9, 10]));
    // …et elles ne font que DEUX directions : 9 et 10 n'en font qu'une.
    expect(search.gateDirections).toEqual([2, 9]);

    // LA RÈGLE D'HIER, sur le même monde : elle s'arrêtait à 500 m, sur une
    // seule approche vue en deux fois. C'est exactement ce que le responsable produit a
    // relevé sur le run chaud de Thairé.
    const yesterday = await runAxisStage({
      stop: O,
      source: sourceOf(world),
      params: { ...PARAMS, minDirectionSeparationDeg: 30 },
    });
    expect(yesterday.reachedRingM).toBe(500);
    expect(yesterday.gateDirections).toEqual([9, 10]);
  });

  /**
   * LA CLASSE 4 SUR LE CERCLE, ET JAMAIS PLUS
   * PRÈS.
   *
   * Le monde est celui de Thairé : rien d'importance 2–3 sous 2 km, un réseau
   * structurant à 3 km qui porte deux directions, deux importance 4 qui
   * COUPENT la bande 1 800–2 000 m (la D203E5 à l'ouest-nord et la D113 au
   * sud) — et la rue du bourg, d'importance 4 elle aussi, à 20 m de l'arrêt.
   * C'est elle que la règle « classe 4 au plus proche » choisissait, en
   * sortant 1,78 km d'approche de l'étude ; c'est elle que le principe 7
   * refuse.
   */
  const THAIRE: AxisStageParams = { ...PARAMS, minReachM: 1_800 };

  function thaireShapedWorld(extra: readonly RoadWay[] = []): readonly RoadWay[] {
    return [
      // Le réseau structurant, hors du cercle : 3 km au nord, deux portes.
      way('LOIN', [at(3_000, -4_000), at(3_000, 4_000)], 3, { name: 'D-structurante' }),
      way('L-loin-est', [at(3_000, 3_000), at(2_600, 2_600)], 4),
      way('L-loin-ouest', [at(3_000, -3_000), at(2_600, -2_600)], 4),
      // Les deux importance 4 du cercle : leurs sommets sont à 1 904 m.
      way('D203E5', [at(1_900, -120), at(1_900, 120)], 4, { name: 'D203E5' }),
      way('D113', [at(-1_900, -120), at(-1_900, 120)], 4, { name: 'D113' }),
      // La rue du bourg : une importance 4, à 20 m. Jamais une ancre.
      way('RUE-DU-BOURG', [at(20, -300), at(20, 300)], 4, { name: 'rue du bourg' }),
      ...extra,
    ];
  }

  it('rien de 2–3 sous 2 km : les portes de classe 4 se posent SUR LE CERCLE', async () => {
    const calls: string[] = [];
    const search = await runAxisStage({
      stop: O,
      source: sourceOf(thaireShapedWorld(), calls),
      params: THAIRE,
    });

    expect(search.reason).toBe('ring_class4');
    expect(search.reachedRingM).toBe(2_000);
    // La passe qui a servi est publiée : c'est ce que l'onglet écrit.
    expect(search.importanceMax).toBe(4);
    expect(search.retained.map((gate) => gate.importance)).toEqual([4, 4, 4, 4]);
    // LA RÈGLE, en un seul `expect` : aucune porte de classe 4 sous le cercle.
    expect(search.retained.every((gate) => gate.distanceM >= 1_800)).toBe(true);
    expect(search.retained.every((gate) => gate.distanceM <= 2_000)).toBe(true);
    // Donc rien à déclarer non étudié : toute l'approche est contrôlée.
    expect(search.uncontrolled).toEqual([]);
    expect(search.gateDirections).toHaveLength(2);
    expect(search.boundedByPrinciple34).toBe(true);
    expect(search.fallback).toBe('axes');
    // La rue du bourg est VUE, et refusée pour la bonne raison — pas tue.
    expect(search.rejected.map((row) => row.axisWayId)).toContain('RUE-DU-BOURG');
    expect(search.rejected.find((row) => row.axisWayId === 'RUE-DU-BOURG')?.reasons).toEqual([
      'axis_short_of_ring_band',
    ]);
    // La troisième vague (15 km) n'est jamais demandée : le cercle a répondu.
    // Et la passe de bande ne demande QUE la classe 4, jamais les 2–3 déjà vus.
    expect(calls.filter((c) => c.endsWith(':2-3'))).toEqual(['500:2-3', '5000:2-3']);
    expect(calls.filter((c) => c.endsWith(':4-4'))).toEqual(['2000:4-4']);
    // Aucune rue locale demandée pour la bande : une porte de bande n'est pas
    // une jonction.
    expect(calls.filter((c) => c.endsWith(':4-5'))).toEqual([]);
  });

  /**
   * CE QUE LA PREMIÈRE ÉCRITURE FAISAIT, ET QUE
   * LE PRINCIPE 7 REFUSE : poser l'ancre sur la rue du village parce qu'elle
   * est d'importance 4. Seule dans le cercle, elle ne rend RIEN.
   */
  it('une classe 4 qui n’atteint pas le cercle n’est pas une ancre', async () => {
    const search = await runAxisStage({
      stop: O,
      source: sourceOf([way('RUE-DU-BOURG', [at(20, -300), at(20, 300)], 4, { name: 'rue du bourg' })]),
      params: THAIRE,
    });
    expect(search.retained).toEqual([]);
    expect(search.rejected.map((row) => row.reasons)).toEqual([['axis_short_of_ring_band']]);
    expect(search.fallback).toBe('r0_no_gate');
  });

  it('sans la passe, le même monde part chercher à 3 km ce qui passe à 1 900 m', async () => {
    const search = await runAxisStage({
      stop: O,
      source: sourceOf(thaireShapedWorld()),
      // `circleFallbackImportanceMax` à 3 : la passe ne sert à rien, et
      // l'étage se comporte comme avant ce soir.
      params: { ...THAIRE, circleFallbackImportanceMax: 3 },
    });
    expect(search.reason).toBe('ring_reached');
    expect(search.reachedRingM).toBe(5_000);
    expect(search.importanceMax).toBe(3);
    expect(search.retained.every((gate) => gate.distanceM > 4_000)).toBe(true);
  });

  /**
   * UNE PORTE DE BANDE N'EST PAS UNE JONCTION.
   *
   * Pas de rue locale, donc pas de `localWayId` : le dire par un identifiant
   * fabriqué (l'axe recopié en rue locale) serait un fait faux. Et le routeur
   * part du point lui-même, comme R0 le fait pour ses cinq ancres depuis
   * toujours — il n'y a pas de branche par où entrer.
   */
  it('une porte de bande n’a ni rue locale ni point d’entrée à part', async () => {
    const search = await runAxisStage({
      stop: O,
      source: sourceOf(thaireShapedWorld()),
      params: THAIRE,
    });
    expect(search.retained.every((gate) => gate.localWayId === null)).toBe(true);
    expect(search.retained.every((gate) => gate.localImportance === null)).toBe(true);
    expect(search.retained.every((gate) => gate.inward === gate.at)).toBe(true);
    expect(search.retained.map((gate) => gate.axisWayId).sort()).toEqual([
      'D113',
      'D113',
      'D203E5',
      'D203E5',
    ]);
  });

  /**
   * UNE PORTE SUR LE CERCLE, MÊME SEULE, ARRÊTE
   * L'ESCALADE.
   *
   * « Si on trouve une départementale à moins de 2 km je vois mal l'intérêt
   * d'aller chercher plus loin » (principe 34) : une seule direction de classe
   * 4 sur le cercle ne remplit pas le critère d'arrêt, mais elle vaut mieux que
   * quatre portes à 5 km toutes dans la même approche. Le motif le DIT
   * (`best_ring_kept`) plutôt que de laisser croire que le compte a été atteint.
   */
  it('une seule direction en classe 4 : on la garde, et on n’escalade pas', async () => {
    const world = [
      way('LOIN', [at(3_000, -4_000), at(3_000, 4_000)], 3, { name: 'D-structurante' }),
      way('L-loin-est', [at(3_000, 3_000), at(2_600, 2_600)], 4),
      way('L-loin-ouest', [at(3_000, -3_000), at(2_600, -2_600)], 4),
      way('D203E5', [at(1_900, -120), at(1_900, 120)], 4, { name: 'D203E5' }),
    ];
    const calls: string[] = [];
    const search = await runAxisStage({ stop: O, source: sourceOf(world, calls), params: THAIRE });

    expect(calls.filter((c) => c.endsWith(':4-4'))).toEqual(['2000:4-4']);
    expect(calls).not.toContain('15000:2-3');
    expect(search.reason).toBe('best_ring_kept');
    expect(search.boundedByPrinciple34).toBe(true);
    expect(search.reachedRingM).toBe(2_000);
    expect(search.importanceMax).toBe(4);
    expect(search.gateDirections).toHaveLength(1);
    expect(search.retained.every((gate) => gate.distanceM >= 1_800)).toBe(true);
    expect(search.fallback).toBe('axes');
  });

  /**
   * ET QUAND LA BANDE NE REND RIEN DU TOUT, l'escalade se fait :
   * c'est la seule chose qui reste, et le principe 34 l'autorise alors.
   */
  it('aucune porte sur le cercle, en 2–3 comme en 4 : l’escalade se fait', async () => {
    const world = [
      way('LOIN', [at(3_000, -4_000), at(3_000, 4_000)], 3, { name: 'D-structurante' }),
      way('L-loin-est', [at(3_000, 3_000), at(2_600, 2_600)], 4),
      way('L-loin-ouest', [at(3_000, -3_000), at(2_600, -2_600)], 4),
      // La seule classe 4 du cercle s'arrête à 20 m : elle ne le coupe pas.
      way('RUE-DU-BOURG', [at(20, -300), at(20, 300)], 4, { name: 'rue du bourg' }),
    ];
    const calls: string[] = [];
    const search = await runAxisStage({ stop: O, source: sourceOf(world, calls), params: THAIRE });

    expect(calls.filter((c) => c.endsWith(':4-4'))).toEqual(['2000:4-4']);
    expect(search.reason).toBe('ring_reached');
    expect(search.reachedRingM).toBe(5_000);
    expect(search.importanceMax).toBe(3);
    expect(search.gateDirections).toHaveLength(2);
  });

  it('aucun axe dans les 15 km : aucun anneau ne suffit, et rien n’est sondé', async () => {
    const search = await runAxisStage({ stop: O, source: sourceOf([]), params: PARAMS });
    expect(search.reason).toBe('no_axis_within_max');
    expect(search.reachedRingM).toBeNull();
    expect(search.ringProbes.every((probe) => probe.axes === 0)).toBe(true);
  });

  /** Le prix du bon critère se LIT, anneau par anneau, au lieu de se deviner. */
  it('chaque anneau sondé est publié avec ce qu’il a coûté', async () => {
    const world = [
      eastWestAxis('AX', 400),
      way('L1', [at(400, 300), at(120, 90)], 4),
      way('L2', [at(400, -300), at(120, -90)], 4),
    ];
    const search = await runAxisStage({ stop: O, source: sourceOf(world), params: PARAMS });

    expect(search.ringProbes.map((probe) => probe.ringM)).toEqual([50, 250, 500]);
    expect(search.ringProbes.map((probe) => probe.axes)).toEqual([0, 0, 1]);
    expect(search.ringProbes.at(-1)?.directions).toBe(2);
    expect(search.ringProbes.every((probe) => probe.fetchRadiusM === 500)).toBe(true);
  });
});

describe('un axe est un réseau continu, pas un tronçon', () => {
  it('trois morceaux bout à bout de même classe ne font qu’un axe', () => {
    const pieces = [
      way('p1', [at(400, -900), at(400, -300)], 3),
      way('p2', [at(400, -300), at(400, 300)], 3),
      way('p3', [at(400, 300), at(400, 900)], 3),
    ];
    const axes = findAxisCorridors(prepareAxisNetwork(O, pieces, 12), 2_000, [...RINGS]);
    expect(axes).toHaveLength(1);
    expect(axes[0]?.wayIds).toEqual(['p1', 'p2', 'p3']);
  });

  it('deux classes différentes ne se recollent pas, même bout à bout', () => {
    const pieces = [
      way('p1', [at(400, -900), at(400, -300)], 3),
      way('p2', [at(400, -300), at(400, 300)], 2),
    ];
    const axes = findAxisCorridors(prepareAxisNetwork(O, pieces, 12), 2_000, [...RINGS]);
    expect(axes).toHaveLength(2);
  });

  it('deux axes dans des directions opposées occupent deux secteurs', () => {
    const north = way('n', [at(400, -300), at(400, 300)], 3);
    const south = way('s', [at(-400, -300), at(-400, 300)], 3);
    const axes = findAxisCorridors(prepareAxisNetwork(O, [north, south], 12), 2_000, [...RINGS]);
    expect(axes).toHaveLength(2);
    expect(new Set(axes.map((a) => a.sector)).size).toBe(2);
    // Secteur 0 = [0°, 30°[ depuis le nord ; secteur 6 = [180°, 210°[.
    expect(axes.map((a) => a.sector).sort((a, b) => a - b)).toEqual([0, 6]);
  });
});

// -------------------------------------------------------------- les portes --

/** Un monde minimal : un axe est-ouest à 400 m au nord, et des rues qui y montent. */
function axisWorld(): { readonly axisWay: RoadWay; readonly axes: ReturnType<typeof findAxisCorridors> } {
  const axisWay = way('AX', [at(400, -900), at(400, 900)], 3, { name: 'D113' });
  const axes = findAxisCorridors(prepareAxisNetwork(O, [axisWay], 12), 2_000, [...RINGS]);
  return { axisWay, axes };
}

function gatesOf(localWays: readonly RoadWay[]): ReturnType<typeof findAxisGates> {
  const { axisWay, axes } = axisWorld();
  return findAxisGates({
    stop: O,
    axes,
    axisWays: new Map([[axisWay.id, axisWay]]),
    localWays,
    radiusM: 2_000,
    sectorCount: 12,
  });
}

describe('une porte est une rue locale qui quitte l’axe du côté de l’adresse', () => {
  it('une rue qui descend de l’axe vers l’adresse est une porte', () => {
    const local = way('L1', [at(400, 0), at(100, 0)], 4, { name: 'Rue de la Poste' });
    const found = gatesOf([local]);
    expect(found.gates).toHaveLength(1);
    expect(found.gates[0]?.localWayId).toBe('L1');
    expect(found.gates[0]?.label).toBe('D113 × Rue de la Poste');
    // Le point d'entrée est à 20 m sur la branche, vers l'adresse : donc au sud.
    expect(found.gates[0]?.inward.lat).toBeLessThan(found.gates[0]!.at.lat);
  });

  it('une rue qui monte de l’autre côté de l’axe est refusée', () => {
    const local = way('L2', [at(400, 0), at(700, 0)], 4);
    const found = gatesOf([local]);
    expect(found.gates).toHaveLength(0);
    expect(found.rejected[0]?.reasons).toContain('branch_wrong_side_of_axis');
  });

  it('une rue parallèle à l’axe n’en part pas', () => {
    const local = way('L3', [at(400, 0), at(395, 300)], 4);
    const found = gatesOf([local]);
    expect(found.gates).toHaveLength(0);
    expect(found.rejected[0]?.reasons).toContain('branch_parallel_to_axis');
  });

  it('une rue dont le bout est à 40 m de l’axe ne le rejoint pas — et 20 m, si', () => {
    expect(gatesOf([way('L4', [at(360, 0), at(100, 0)], 4)]).gates).toHaveLength(0);
    expect(gatesOf([way('L5', [at(380, 0), at(100, 0)], 4)]).gates).toHaveLength(1);
  });

  it('une voie privée n’est une porte pour personne', () => {
    const local = way('L6', [at(400, 0), at(100, 0)], 4, { isPrivate: true });
    const found = gatesOf([local]);
    expect(found.gates).toHaveLength(0);
    expect(found.rejected[0]?.reasons).toContain('legal_incompatible');
  });

  it('deux portes du même axe à moins de 35 m sont la même', () => {
    const found = gatesOf([
      way('L7', [at(400, 0), at(100, 0)], 4),
      way('L8', [at(400, 20), at(100, 20)], 4),
    ]);
    expect(found.gates).toHaveLength(1);
  });
});

describe('les trois refus qui n’avaient pas de témoin', () => {
  /**
   * `chord_crosses_retained_axis` — la porte est derrière une porte.
   *
   * Deux axes parallèles : la D113 à 400 m au nord, la D5 à 800 m. Une rue qui
   * quitte la D5 vers l’adresse doit traverser la D113 pour l’atteindre.
   */
  function twoAxesWorld(secondPieces: readonly RoadWay[]): ReturnType<typeof findAxisGates> {
    const near = way('AX', [at(400, -900), at(400, 900)], 3, { name: 'D113' });
    const ways = [near, ...secondPieces];
    const axes = findAxisCorridors(prepareAxisNetwork(O, ways, 12), 2_000, [...RINGS]);
    return findAxisGates({
      stop: O,
      axes,
      axisWays: new Map(ways.map((w) => [w.id, w])),
      localWays: [way('L-far', [at(800, 0), at(500, 0)], 4)],
      radiusM: 2_000,
      sectorCount: 12,
    });
  }

  it('la corde qui traverse l’axe proche est refusée', () => {
    const found = twoAxesWorld([way('FAR', [at(800, -900), at(800, 900)], 2, { name: 'D5' })]);
    expect(found.gates.map((g) => g.localWayId)).not.toContain('L-far');
    expect(found.rejected.some((r) => r.reasons.includes('chord_crosses_retained_axis'))).toBe(true);
  });

  /**
   * LE CAS QUE LA PREMIÈRE PASSE LAISSAIT PASSER : l’axe proche est coupé en
   * onze morceaux, et la plus longue corde n’est PAS celle que la corde
   * traverse. L’engine teste tous les tronçons, et c’est ce qu’on porte.
   */
  it('l’axe proche coupé en morceaux est quand même vu — tous les tronçons comptent', () => {
    const pieces: RoadWay[] = [];
    for (let i = 0; i < 11; i += 1) {
      pieces.push(way(`AXP${i}`, [at(400, -900 + i * 160), at(400, -900 + (i + 1) * 160)], 3, { name: 'D113' }));
    }
    // Le long tronçon est loin à l’ouest : c’est lui qui gagnerait la « plus
    // longue corde », et la corde vers l’adresse ne le croise jamais.
    const ways = [
      way('AXLONG', [at(401, -4_000), at(401, -900)], 3, { name: 'D113' }),
      ...pieces,
      way('FAR', [at(800, -900), at(800, 900)], 2, { name: 'D5' }),
    ];
    const axes = findAxisCorridors(prepareAxisNetwork(O, ways, 12), 2_000, [...RINGS]);
    const found = findAxisGates({
      stop: O,
      axes,
      axisWays: new Map(ways.map((w) => [w.id, w])),
      localWays: [way('L-far', [at(800, 0), at(500, 0)], 4)],
      radiusM: 2_000,
      sectorCount: 12,
    });
    expect(found.rejected.some((r) => r.reasons.includes('chord_crosses_retained_axis'))).toBe(true);
  });

  it('`beyond_search_radius` : au-delà de 1,2 × le rayon, la jonction ne compte pas', () => {
    const axisWay = way('AX', [at(400, -900), at(400, 900)], 3, { name: 'D113' });
    const axes = findAxisCorridors(prepareAxisNetwork(O, [axisWay], 12), 2_000, [...RINGS]);
    const found = findAxisGates({
      stop: O,
      axes,
      axisWays: new Map([[axisWay.id, axisWay]]),
      localWays: [way('L-near', [at(400, 0), at(100, 0)], 4)],
      // Rayon d’étage à 100 m : la jonction est à 400 m, donc au-delà de 120 m.
      radiusM: 100,
      sectorCount: 12,
    });
    expect(found.gates).toHaveLength(0);
    expect(found.rejected[0]?.reasons).toContain('beyond_search_radius');
  });

  it('`road_quality_rejected` : un chemin au-delà de 2 km, non ; en deçà, oui', () => {
    const axisWay = way('AX', [at(3_000, -900), at(3_000, 900)], 3, { name: 'D113' });
    const axes = findAxisCorridors(prepareAxisNetwork(O, [axisWay], 12), 5_000, [...RINGS]);
    const chemin = way('L-chemin', [at(3_000, 0), at(2_700, 0)], 4, { tags: { nature: 'Chemin' } });
    const far = findAxisGates({
      stop: O,
      axes,
      axisWays: new Map([[axisWay.id, axisWay]]),
      localWays: [chemin],
      radiusM: 5_000,
      sectorCount: 12,
    });
    expect(far.gates).toHaveLength(0);
    expect(far.rejected[0]?.reasons).toContain('road_quality_rejected');

    // Le même chemin à 400 m : les derniers mètres, on les garde.
    const nearAxis = way('AX2', [at(400, -900), at(400, 900)], 3, { name: 'D113' });
    const nearAxes = findAxisCorridors(prepareAxisNetwork(O, [nearAxis], 12), 2_000, [...RINGS]);
    const near = findAxisGates({
      stop: O,
      axes: nearAxes,
      axisWays: new Map([[nearAxis.id, nearAxis]]),
      localWays: [way('L-chemin2', [at(400, 0), at(100, 0)], 4, { tags: { nature: 'Chemin' } })],
      radiusM: 2_000,
      sectorCount: 12,
    });
    expect(near.gates).toHaveLength(1);
  });
});

// ----------------------------------------------------- la sélection finale --

describe('cinq portes, une par direction d’abord', () => {
  it('six portes dans six directions : les cinq plus proches sont prises, une par secteur', () => {
    const gates = [0, 1, 2, 3, 4, 5].map((i) => ({
      id: `g${i}`,
      at: at(100, 0),
      inward: at(90, 0),
      axisId: 'axis-AX',
      axisWayId: 'AX',
      localWayId: `L${i}`,
      label: `porte ${i}`,
      importance: 3,
      localImportance: 4,
      azimuthDeg: i * 30 + 15,
      distanceM: 1_000 + i,
      sector: i,
      rank: null,
      reasonCodes: [],
      uncontrolledBeyondM: null,
    }));
    const selection = selectAxisGates(gates, 5, 12, 0);
    expect(selection.retained).toHaveLength(5);
    expect(new Set(selection.retained.map((g) => g.sector)).size).toBe(5);
    expect(selection.gates.filter((g) => g.rank === null)[0]?.reasonCodes).toEqual(['slots_full']);
  });

  it('trois portes dans un seul secteur : le quota monte jusqu’à les prendre', () => {
    const gates = [0, 1, 2].map((i) => ({
      id: `g${i}`,
      at: at(100, 0),
      inward: at(90, 0),
      axisId: 'axis-AX',
      axisWayId: 'AX',
      localWayId: `L${i}`,
      label: `porte ${i}`,
      importance: 3,
      localImportance: 4,
      azimuthDeg: 10 + i,
      distanceM: 1_000 + i,
      sector: 0,
      rank: null,
      reasonCodes: [],
      uncontrolledBeyondM: null,
    }));
    const selection = selectAxisGates(gates, 5, 12, 0);
    expect(selection.retained).toHaveLength(3);
    // L'ordre de prise est celui de la distance : quota 1, puis 2, puis 3.
    expect(selection.retained.map((g) => g.rank)).toEqual([1, 2, 3]);
  });
});

/**
 * LA SÉLECTION DES PORTES DE BANDE : LE TOUR DU
 * CERCLE, ET AUCUN IDENTIFIANT QUI TRANCHE.
 *
 * Toutes les portes de bande sont entre 1 800 et 2 000 m : la distance ne les
 * départage pas, et la règle d'hier (distance, puis identifiant) laissait donc
 * le `cleabs` BD TOPO décider — le défaut H3/H4 de la fiche S3. Les deux cas
 * mesurés à Thairé, en laboratoire.
 */
describe('les portes de bande se prennent tous les 60° du cercle', () => {
  const bandGate = (id: string, azimuthDeg: number, distanceM = 2_000) => ({
    id,
    at: at(2_000, 0),
    inward: at(2_000, 0),
    axisId: 'axis-MEGA',
    axisWayId: id,
    localWayId: null,
    label: id,
    importance: 4,
    localImportance: null,
    azimuthDeg,
    distanceM,
    sector: Math.floor(azimuthDeg / 30) % 12,
    rank: null,
    reasonCodes: [] as readonly string[],
    uncontrolledBeyondM: null as number | null,
  });

  /**
   * LE CAS DE LA D113 : deux portes du même secteur, à 11° l'une de l'autre, et
   * un identifiant qui décidait. Le tour du cercle part du point qui suit le
   * plus grand vide, donc c'est la géométrie qui tranche, pas le nom.
   */
  it('deux portes du même secteur : c’est le tour du cercle qui choisit, pas l’identifiant', () => {
    const gates = [
      bandGate('zzz-D113', 56.3),
      bandGate('aaa-voisine', 45.4),
      bandGate('bbb-est', 82.3),
      bandGate('ccc-sud', 211.5),
      bandGate('ddd-ouest', 272.6),
      bandGate('eee-nord', 356.1),
    ];
    const retained = selectBandGates(gates, 5, 12, 60, 1_800).retained.map((g) => g.id);
    // Le plus grand vide est entre 82,3° et 211,5° : le tour commence à 211,5°,
    // et prend ensuite 272,6°, 356,1°, 56,3° — la D113, à 60,2° de 356,1°.
    expect(retained).toContain('zzz-D113');
    expect(retained).not.toContain('aaa-voisine');
  });

  /**
   * LE CAS DE LA D203E5 : une porte à 309,3° prenait la place de celle à
   * 272,6° — 36,7° d'écart, la même approche — parce qu'elle passait la
   * première. Le tour du cercle les voit dans l'ordre des azimuts.
   */
  it('deux portes à 37° d’écart : une seule est gardée, et c’est le tour qui dit laquelle', () => {
    const gates = [
      bandGate('aaa-309', 309.3),
      bandGate('bbb-D203E5', 272.6),
      bandGate('ccc-sud', 211.5),
    ];
    // Deux places : seul le tour du cercle sert, et il ne voit qu'UNE direction
    // entre 272,6° et 309,3°. La porte gardée est celle que le tour rencontre.
    const selection = selectBandGates(gates, 2, 12, 60, 1_800);
    expect(selection.retained.map((g) => g.id)).toEqual(['ccc-sud', 'bbb-D203E5']);
    expect(selection.gates.find((g) => g.id === 'aaa-309')?.reasonCodes).toEqual(['slots_full']);
  });

  it('les places qui restent après le tour vont aux quotas de secteur', () => {
    const gates = [bandGate('a', 10), bandGate('b', 100), bandGate('c', 190), bandGate('d', 20)];
    const selection = selectBandGates(gates, 5, 12, 60, 1_800);
    // Trois par le tour (10°, 100°, 190°), la quatrième par le quota : son
    // secteur (0) est déjà pris par « a », donc elle passe au quota 2.
    expect(selection.retained).toHaveLength(4);
    expect(selection.retained.map((g) => g.id).sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('aucune porte de bande ne déclare d’approche non étudiée', () => {
    const selection = selectBandGates([bandGate('a', 10, 1_850)], 5, 12, 60, 1_800);
    expect(selection.retained[0]?.uncontrolledBeyondM).toBeNull();
    expect(selection.retained[0]?.reasonCodes).toEqual([]);
  });
});

describe('principe 34 — une porte sous le cercle est RETENUE, et son approche est nommée', () => {
  const gate = (id: string, distanceM: number, sector: number) => ({
    id,
    at: at(100, 0),
    inward: at(90, 0),
    axisId: 'axis-AX',
    axisWayId: 'AX',
    localWayId: `L-${id}`,
    label: `porte ${id}`,
    importance: 2,
    localImportance: 4,
    azimuthDeg: sector * 30 + 15,
    distanceM,
    sector,
    rank: null,
    reasonCodes: [] as readonly string[],
    uncontrolledBeyondM: null as number | null,
  });

  it('à 33 m elle est la première retenue, et porte ses 1 767 m non étudiés', () => {
    const selection = selectAxisGates([gate('proche', 33, 0), gate('loin', 1_900, 1)], 5, 12, 1_800);
    expect(selection.retained.map((g) => g.id).sort()).toEqual(['loin', 'proche']);
    const proche = selection.gates.find((g) => g.id === 'proche');
    expect(proche?.rank).toBe(1);
    expect(proche?.reasonCodes).toEqual(['approach_uncontrolled_beyond_gate']);
    expect(proche?.uncontrolledBeyondM).toBe(1_767);
  });

  it('au-delà du cercle, rien à dire : ni motif, ni mètres', () => {
    const selection = selectAxisGates([gate('loin', 1_900, 1)], 5, 12, 1_800);
    const loin = selection.gates[0];
    expect(loin?.reasonCodes).toEqual([]);
    expect(loin?.uncontrolledBeyondM).toBeNull();
  });

  it('la phrase de l’onglet a toute sa matière', () => {
    const selection = selectAxisGates([gate('proche', 33, 0)], 5, 12, 1_800);
    expect(uncontrolledApproaches(selection.retained, () => 'D 947', 1_800)).toEqual([
      {
        gateId: 'proche',
        axisLabel: 'D 947',
        importance: 2,
        gateDistanceM: 33,
        uncontrolledM: 1_767,
        minReachM: 1_800,
      },
    ]);
  });

  it('une porte NON retenue ne porte pas le motif, mais son refus', () => {
    const gates = [0, 1, 2, 3, 4, 5].map((i) => gate(`g${i}`, 100 + i, i));
    const selection = selectAxisGates(gates, 5, 12, 1_800);
    const refused = selection.gates.filter((g) => g.rank === null);
    expect(refused).toHaveLength(1);
    expect(refused[0]?.reasonCodes).toEqual(['slots_full']);
    expect(refused[0]?.uncontrolledBeyondM).toBeNull();
  });
});

// ------------------------------------------------------------ l'étage entier --



describe('l’étage entier : ce qu’il trouve, et ce qu’il dit quand il ne trouve rien', () => {
  it('un axe à 400 m et ses deux rues : l’anneau de 500 m, une seule requête d’axes', async () => {
    const calls: string[] = [];
    const world = [
      way('AX', [at(400, -900), at(400, 900)], 3, { name: 'D113' }),
      way('L1', [at(400, 0), at(100, 0)], 4, { name: 'Rue de la Poste' }),
      // La seconde direction, sans laquelle l'anneau ne suffirait pas
      // (`minGateDirections` = 2) et où l'étage irait chercher à 5 puis 15 km.
      // À l'OUEST, et non à l'est à 300 m : depuis le 2026-09-14 au soir, une
      // porte au nord (secteur 0) et une porte à 37° (secteur 1) sont VOISINES
      // et ne comptent que pour une direction.
      way('L2', [at(400, -300), at(120, -90)], 4, { name: 'Rue du Moulin' }),
    ];
    const search = await runAxisStage({ stop: O, source: sourceOf(world, calls), params: PARAMS });
    expect(search.reason).toBe('ring_reached');
    expect(search.reachedRingM).toBe(500);
    expect(search.axes).toHaveLength(1);
    expect(search.retained).toHaveLength(2);
    expect(search.fallback).toBe('axes');
    // Une requête d'axes (500 m a suffi), une de rues locales autour de
    // l'adresse, et une le long de l'axe — celle qui manquait à Thairé.
    expect(calls).toEqual(['500:2-3', '600:4-5', '1500:4-5']);
  });

  it('aucun axe dans les 15 km : quatre requêtes — le cercle en classe 4 comprise', async () => {
    const calls: string[] = [];
    const search = await runAxisStage({ stop: O, source: sourceOf([], calls), params: PARAMS });
    expect(search.reason).toBe('no_axis_within_max');
    expect(search.reachedRingM).toBeNull();
    expect(search.fallback).toBe('r0_no_axis');
    // LE PRIX DE LA CLASSE 4, NOMMÉ : une adresse
    // dont le cercle ne donne pas le compte paie UNE requête d'axes de plus,
    // celle de la bande en classe 4 (2 000 m, importance 4 SEULE — les 2–3 ont
    // déjà été vus), et elle passe AVANT l'escalade : l'ordre du principe 34.
    expect(calls).toEqual(['500:2-3', '5000:2-3', '2000:4-4', '15000:2-3']);
  });

  it('sans BD TOPO, l’étage dit « on n’a pas regardé », pas « aucun axe »', async () => {
    const search = await runAxisStage({ stop: O, source: null, params: PARAMS });
    expect(search.reason).toBe('no_source');
    expect(search.fetch.queries).toBe(0);
  });

  it('une source qui tousse ne fait échouer personne', async () => {
    const source: AxisSourcePort = {
      fetchByImportance: async () => {
        throw new Error('PostGIS muette');
      },
    };
    const search = await runAxisStage({ stop: O, source, params: PARAMS });
    expect(search.reason).toBe('fetch_failed');
    expect(search.retained).toEqual([]);
  });

  /**
   * LE BUDGET DE TOUT L'ÉTAGE, et non d'une requête.
   *
   * `queryTimeoutMs` borne une requête côté serveur ; il ne peut rien contre
   * une source qui ne répond JAMAIS — ni contre 58 requêtes qui répondent
   * chacune juste avant leur propre budget. Sans `stageTimeoutMs`, ce cas
   * resterait bloqué jusqu'au délai de vitest, exactement comme un run de prod
   * resterait bloqué avant son `complete`.
   */
  it('une source muette : l’étage rend « timeout » sous son budget, et rend la main', async () => {
    const source: AxisSourcePort = {
      fetchByImportance: () => new Promise(() => undefined),
    };
    const startedAt = Date.now();
    const search = await runAxisStage({
      stop: O,
      source,
      params: { ...PARAMS, stageTimeoutMs: 50 },
    });
    const elapsedMs = Date.now() - startedAt;

    expect(search.reason).toBe('timeout');
    expect(search.retained).toEqual([]);
    // `timeout` porte son propre repli,
    // distinct de `r0_no_axis` (une absence établie) : ici on ne sait pas
    // s'il y avait un axe, on n'a pas eu le temps de regarder.
    expect(search.fallback).toBe('r0_timeout');
    // Sous le budget, à la marge d'ordonnancement près — et surtout très loin
    // des 58 requêtes en série que le budget remplace.
    expect(elapsedMs).toBeLessThan(1_000);
  });

  /**
   * LE MEILLEUR ANNEAU DÉJÀ TROUVÉ N'EST PLUS JETÉ AU
   * TIMEOUT. `raceBudget` rendait `empty(...)` inconditionnellement : ce que
   * `search()` avait déjà établi dans sa boucle (une porte retenue à 400 m)
   * disparaissait avec la promesse abandonnée. « Ce qu'on a mesuré vaut mieux
   * que rien » (principe 5) vaut aussi pour un budget épuisé.
   *
   * RELU LE 2026-09-14 — « vaut mieux que rien » veut dire PUBLIÉ, pas SERVI :
   * un étage coupé au budget n'a pas fini de JUGER son meilleur anneau, et le
   * servir quand même serait activer un ancrage sur une seule direction que
   * personne n'a vérifiée jusqu'au bout. `fallback` reste donc `r0_timeout`
   * même quand `retained` n'est pas vide — c'était `'axes'` avant cette
   * correction, exactement le défaut que la relecture a bloqué.
   */
  it('un timeout après la première vague rend le meilleur anneau déjà trouvé, pas rien — mais ne le sert pas', async () => {
    const world = [
      way('AX', [at(400, -900), at(400, 900)], 3, { name: 'D400' }),
      way('L1', [at(400, 0), at(100, 0)], 4),
    ];
    const base = sourceOf(world);
    let axisWaveCalls = 0;
    const source: AxisSourcePort = {
      fetchByImportance: async (centre, radiusM, range, limit) => {
        const isAxisRange = range.min === PARAMS.importanceMin && range.max === PARAMS.importanceMax;
        if (isAxisRange) {
          axisWaveCalls += 1;
          // La première vague (500 m) répond tout de suite et trouve UNE
          // porte (une seule direction, sous le cercle : elle ne qualifie
          // pas). La seconde (5 000 m, nécessaire pour atteindre l'anneau de
          // 2 000 m) ne répond JAMAIS — c'est elle que le budget doit couper.
          if (axisWaveCalls >= 2) return new Promise(() => undefined);
        }
        return base.fetchByImportance(centre, radiusM, range, limit);
      },
    };
    const search = await runAxisStage({
      stop: O,
      source,
      params: { ...PARAMS, stageTimeoutMs: 80 },
    });

    expect(search.reason).toBe('timeout');
    expect(search.boundedByPrinciple34).toBe(false);
    expect(search.reachedRingM).toBe(500);
    // L'anneau reste PUBLIÉ : ses axes et sa porte sont là, lisibles.
    expect(search.retained).toHaveLength(1);
    // …mais R0 sert : un étage inachevé n'est pas une décision (principe 5).
    expect(search.fallback).toBe('r0_timeout');
  });

  /**
   * L'OBJET RENDU NE DOIT PLUS BOUGER APRÈS
   * COUP. `fetch` et `progress.probes` restaient des références PARTAGÉES,
   * mutées par la boucle de `search()` restée en vol après que le budget a
   * déjà rendu un résultat — et `full.ts` sérialise l'analyse à CHAQUE poll
   * (l'API (hors instantané)) : sans copie, un run déjà `complete`
   * continuerait de changer sous les yeux d'un client qui le relit.
   */
  it('un timeout : la recherche abandonnée ne réécrit plus ce qui a déjà été rendu', async () => {
    const world = [
      way('AX', [at(400, -900), at(400, 900)], 3, { name: 'D400' }),
      way('L1', [at(400, 0), at(100, 0)], 4),
    ];
    const base = sourceOf(world);
    let axisWaveCalls = 0;
    const held: { release: (() => void) | null } = { release: null };
    const source: AxisSourcePort = {
      fetchByImportance: async (centre, radiusM, range, limit) => {
        const isAxisRange = range.min === PARAMS.importanceMin && range.max === PARAMS.importanceMax;
        if (isAxisRange) {
          axisWaveCalls += 1;
          if (axisWaveCalls === 2) {
            // Répond APRÈS que le budget a déjà rendu la main : la recherche
            // reste en vol, exactement comme sur une source réelle dont la
            // requête finit sur son `statement_timeout` après coup.
            await new Promise<void>((resolve) => {
              held.release = resolve;
            });
          }
        }
        return base.fetchByImportance(centre, radiusM, range, limit);
      },
    };
    const search = await runAxisStage({
      stop: O,
      source,
      params: { ...PARAMS, stageTimeoutMs: 80 },
    });
    const publishedFetch = { ...search.fetch };
    const publishedProbeCount = search.ringProbes.length;

    // Laisse la recherche abandonnée reprendre la main et finir sa boucle.
    held.release?.();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(search.fetch).toEqual(publishedFetch);
    expect(search.ringProbes).toHaveLength(publishedProbeCount);
  });

  it('un axe sans aucune rue locale : des axes, pas de porte, et le repli le dit', async () => {
    const world = [way('AX', [at(400, -900), at(400, 900)], 3)];
    const search = await runAxisStage({ stop: O, source: sourceOf(world), params: PARAMS });
    expect(search.axes).toHaveLength(1);
    expect(search.retained).toEqual([]);
    expect(search.fallback).toBe('r0_no_gate');
  });

  it('drapeau baissé : l’étage cherche quand même, et le repli est « R0 en silence »', async () => {
    const world = [
      way('AX', [at(400, -900), at(400, 900)], 3),
      way('L1', [at(400, 0), at(100, 0)], 4),
    ];
    const search = await runAxisStage({
      stop: O,
      source: sourceOf(world),
      params: { ...PARAMS, enabled: false },
    });
    expect(search.retained).toHaveLength(1);
    expect(search.fallback).toBe('r0_silent');
  });
});
