/**
 * L'ANCRAGE À L'ÉCHELLE DU LIEU, sur les mêmes mondes de
 * laboratoire que la règle de secteurs (`axes-world.ts`).
 *
 * Ce qui est jugé ici, et rien d'autre : une ancre par AXE et par côté, l'arrêt
 * au premier anneau qui rend deux directions, l'anneau de plus pour la moitié
 * vide — un seul —, l'escalade quand rien ne répond, et ce que l'étage DIT de
 * ce qui manque. La règle de secteurs, elle, est jugée à l'identique dans
 * `axes.test.ts` : ce fichier ne doit rien y changer, et c'est le premier cas
 * ci-dessous qui le vérifie.
 */
import { describe, expect, it } from 'vitest';

import { emptyHalfOf, selectScaleGates, uncoveredArcsOf } from '../src/axes-scale.js';
import { runAxisStage, type AxisStageParams } from '../src/axes-stage.js';
import { at, O, PARAMS, sourceOf, way } from './axes-world.js';
import type { AxisGate } from '@teneolog/domain';

/** Le monde de laboratoire, joué sous la règle du 2026-09-15. */
const SCALE: AxisStageParams = { ...PARAMS, selection: 'axes' };

describe('la règle livrée reste celle des secteurs', () => {
  it('sans clé de policy, l’étage dit `sectors` et se comporte comme hier', async () => {
    const world = [
      way('AX', [at(400, -900), at(400, 900)], 3, { name: 'D113' }),
      way('L1', [at(400, 0), at(100, 0)], 4),
      way('L2', [at(400, -300), at(120, -90)], 4),
    ];
    const search = await runAxisStage({ stop: O, source: sourceOf(world), params: PARAMS });
    expect(search.selection).toBe('sectors');
    expect(search.reason).toBe('ring_reached');
    expect(search.reachedRingM).toBe(500);
  });

  it('avec `axes`, l’étage le dit — et c’est la seule différence de contrat', async () => {
    const world = [
      way('AX', [at(400, -900), at(400, 900)], 3, { name: 'D113' }),
      way('L1', [at(400, 0), at(100, 0)], 4),
      way('L2', [at(400, -300), at(120, -90)], 4),
    ];
    const search = await runAxisStage({ stop: O, source: sourceOf(world), params: SCALE });
    expect(search.selection).toBe('axes');
  });
});

describe('une ancre par AXE fiable, par côté', () => {
  /**
   * UNE ROCADE EN L : un seul axe BD TOPO qui passe au nord PUIS à l'ouest.
   *
   * « Un même axe peut donner deux portes seulement si leurs azimuts sont
   * séparés d'au moins 60° — une rocade qui passe au nord et à l'ouest, c'est
   * deux approches. » (sur la décision du responsable produit du
   * 2026-09-15). La troisième rue quitte le MÊME axe 22° à côté de la
   * première : c'est la même sortie, pas une approche de plus.
   */
  const rocade = [
    way('ROCADE', [at(300, 600), at(300, -300), at(-600, -300)], 3, { name: 'rocade' }),
    way('L-nord', [at(300, 0), at(80, 0)], 4),
    way('L-ouest', [at(0, -300), at(0, -80)], 4),
    way('L-nord-bis', [at(300, 120), at(120, 50)], 4),
  ];

  it('deux portes du même axe à 90° sont deux ancres ; une troisième à 22° ne l’est pas', async () => {
    const search = await runAxisStage({ stop: O, source: sourceOf(rocade), params: SCALE });

    expect(search.retained).toHaveLength(2);
    expect(search.retained.map((gate) => Math.round(gate.azimuthDeg))).toEqual([0, 270]);
    // Les deux portes retenues sont bien du MÊME axe : c'est l'axe qui tourne,
    // pas deux réseaux.
    expect(new Set(search.retained.map((gate) => gate.axisId)).size).toBe(1);

    const refused = search.gates.filter((gate) => gate.rank === null);
    expect(refused).toHaveLength(1);
    expect(refused[0]?.reasonCodes).toEqual(['axis_direction_taken']);
    // Elle reste PUBLIÉE : c'est la matière de l'élargissement à la demande.
    expect(Math.round(refused[0]?.azimuthDeg ?? -1)).toBe(22);
  });

  /**
   * DEUX AXES DU MÊME CÔTÉ : deux ancres, UNE direction.
   *
   * « Deux axes différents sur le même côté (< 60°) sont deux approches quand
   * même (deux routes = deux façons d'arriver) ; ils comptent pour deux ancres
   * mais pour UNE direction dans le critère d'arrêt. » Le critère n'est donc
   * pas rempli, et l'étage joue son anneau de plus — un seul.
   */
  const deuxAxesAuNord = [
    way('AX-nord', [at(400, -100), at(400, 200)], 3, { name: 'D-nord' }),
    way('L-nord', [at(400, 0), at(150, 0)], 4),
    way('AX-nord-est', [at(300, 300), at(600, 300)], 3, { name: 'D-nord-est' }),
    way('L-nord-est', [at(300, 300), at(120, 120)], 4),
  ];

  it('deux axes à 45° l’un de l’autre : deux ancres, une seule direction', async () => {
    const calls: string[] = [];
    const search = await runAxisStage({
      stop: O,
      source: sourceOf(deuxAxesAuNord, calls),
      params: SCALE,
    });

    expect(search.retained).toHaveLength(2);
    expect(new Set(search.retained.map((gate) => gate.axisId)).size).toBe(2);
    // Deux ancres, et pourtant UNE direction : 0° et 45° sont à moins de 60°.
    expect(search.gateDirections).toHaveLength(1);

    // UNE SEULE DIRECTION À R1, RIEN DE PLUS À R1+1 : on s'arrête là, avec ce
    // qu'on a — jamais 15 km d'emblée.
    expect(search.reason).toBe('best_ring_kept');
    expect(search.reachedRingM).toBe(500);
    expect(search.boundedByPrinciple34).toBe(true);
    const ringsProbed = search.ringProbes.map((probe) => probe.ringM);
    expect(ringsProbed).toEqual([50, 250, 500, 2_000]);
    expect(calls.filter((c) => c.endsWith(':2-3'))).toEqual(['500:2-3', '5000:2-3']);
    // Et l'écran a de quoi écrire « une seule approche fiable sous 2 000 m ».
    expect(search.uncoveredArcs.every((arc) => arc.searchedToM === 2_000)).toBe(true);
  });
});

describe('l’arrêt : deux directions, puis un anneau de plus pour la moitié vide', () => {
  it('deux ancres opposées dès 250 m : arrêt net, aucune moitié vide à combler', async () => {
    const world = [
      way('AX-nord', [at(200, -600), at(200, 600)], 3, { name: 'D-nord' }),
      way('L-nord', [at(200, 0), at(60, 0)], 4),
      way('AX-sud', [at(-200, -600), at(-200, 600)], 3, { name: 'D-sud' }),
      way('L-sud', [at(-200, 0), at(-60, 0)], 4),
    ];
    const calls: string[] = [];
    const search = await runAxisStage({ stop: O, source: sourceOf(world, calls), params: SCALE });

    expect(search.reason).toBe('ring_reached');
    expect(search.reachedRingM).toBe(250);
    expect(search.gateDirections).toHaveLength(2);
    // Nord ET sud : les deux moitiés sont occupées, rien à compléter — l'anneau
    // de plus ne se paie pas.
    expect(search.ringProbes.map((probe) => probe.ringM)).toEqual([50, 250]);
    expect(calls.filter((c) => c.endsWith(':2-3'))).toEqual(['500:2-3']);
  });

  /**
   * DEUX ANCRES AU NORD ET À L'EST : 270° de vide au sud-ouest. On sonde UN
   * anneau de plus pour cette moitié-là, on y trouve une troisième approche —
   * et on s'arrête, même si un quatrième axe attend à 3 km.
   */
  const quartNordEst = [
    way('AX-nord', [at(400, -600), at(400, 200)], 3, { name: 'D-nord' }),
    way('L-nord', [at(400, 0), at(150, 0)], 4),
    way('AX-est', [at(-600, 400), at(600, 400)], 3, { name: 'D-est' }),
    way('L-est', [at(0, 400), at(0, 150)], 4),
    // Dans la moitié vide, hors du cercle de 500 m : 1 342 m au sud-ouest.
    way('AX-sud-ouest', [at(-1_200, -1_800), at(-1_200, -600)], 3, { name: 'D-sud-ouest' }),
    way('L-sud-ouest', [at(-1_200, -600), at(-900, -450)], 4),
    // Le quatrième axe, à 3 km : l'anneau de 5 000 m ne doit jamais être sondé.
    way('AX-loin', [at(3_000, -600), at(3_000, 600)], 3, { name: 'D-loin' }),
    way('L-loin', [at(3_000, 0), at(2_700, 0)], 4),
  ];

  it('un anneau de plus pour la moitié vide, et un seul', async () => {
    const calls: string[] = [];
    const search = await runAxisStage({
      stop: O,
      source: sourceOf(quartNordEst, calls),
      params: SCALE,
    });

    expect(search.reason).toBe('ring_reached');
    // L'anneau de plus a rapporté la troisième approche : c'est lui qu'on garde.
    expect(search.reachedRingM).toBe(2_000);
    expect(search.retained).toHaveLength(3);
    expect(search.gateDirections).toHaveLength(3);
    expect(search.retained.map((gate) => Math.round(gate.azimuthDeg))).toEqual([0, 90, 207]);

    // UN anneau de plus, pas deux : 5 000 m n'est jamais sondé, et l'axe à 3 km
    // n'entre pas dans la sélection.
    expect(search.ringProbes.map((probe) => probe.ringM)).toEqual([50, 250, 500, 2_000]);
    expect(search.retained.some((gate) => gate.label.includes('D-loin'))).toBe(false);
  });
});

describe('quand rien ne répond, on monte — jusqu’à 15 km', () => {
  it('un seul axe à 6 km : l’escalade demande les trois vagues et garde ce qu’elle a', async () => {
    const world = [
      way('LOIN', [at(6_000, -900), at(6_000, 900)], 3, { name: 'D-loin' }),
      way('L1', [at(6_000, 0), at(5_700, 0)], 4),
    ];
    const calls: string[] = [];
    const search = await runAxisStage({ stop: O, source: sourceOf(world, calls), params: SCALE });

    expect(search.reason).toBe('best_ring_kept');
    expect(search.reachedRingM).toBe(10_000);
    expect(search.gateDirections).toHaveLength(1);
    expect(calls.filter((c) => c.endsWith(':2-3'))).toEqual(['500:2-3', '5000:2-3', '15000:2-3']);
  });

  it('aucun axe nulle part : tous les anneaux sont sondés, et l’étage le dit', async () => {
    const search = await runAxisStage({ stop: O, source: sourceOf([]), params: SCALE });

    expect(search.reason).toBe('no_axis_within_max');
    expect(search.retained).toEqual([]);
    expect(search.ringProbes.map((probe) => probe.ringM)).toEqual([
      50, 250, 500, 2_000, 5_000, 10_000, 15_000,
    ]);
    // Tout le cercle est sans ancre fiable, et on a regardé jusqu'à 15 km.
    expect(search.uncoveredArcs).toEqual([
      { fromDeg: 0, toDeg: 0, widthDeg: 360, searchedToM: 15_000 },
    ]);
  });
});

// --------------------------------------------------- les règles, sans monde --

describe('une ancre par axe : la règle seule', () => {
  /**
   * La porte est posée à SA distance et dans SA direction depuis l'arrêt.
   * Jusqu'au 2026-09-30 toutes les portes de ce bloc étaient posées sur l'arrêt
   * lui-même (`at: O`) : sans effet tant que la règle ne regardait pas où est
   * une porte, faux depuis qu'elle fusionne deux portes au même carrefour
   * (`same_site`). Aucun attendu n'a bougé avec la fixture.
   */
  function gate(id: string, axisId: string, azimuthDeg: number, distanceM: number): AxisGate {
    const rad = (azimuthDeg * Math.PI) / 180;
    const site = at(distanceM * Math.cos(rad), distanceM * Math.sin(rad));
    return {
      id,
      at: site,
      inward: site,
      axisId,
      axisWayId: axisId,
      localWayId: `local-${id}`,
      label: id,
      importance: 3,
      localImportance: 4,
      azimuthDeg,
      distanceM,
      sector: Math.floor((((azimuthDeg % 360) + 360) % 360) / 30),
      rank: null,
      reasonCodes: [],
      uncontrolledBeyondM: null,
    };
  }

  const rule = { gateCount: 5, minDirectionSeparationDeg: 60, minReachM: 0 };

  it('la plus proche gagne, et sa voisine du même axe tombe', () => {
    const selection = selectScaleGates(
      [gate('loin', 'A', 10, 900), gate('proche', 'A', 30, 400)],
      rule,
    );
    expect(selection.retained.map((g) => g.id)).toEqual(['proche']);
    expect(selection.gates.find((g) => g.id === 'loin')?.reasonCodes).toEqual([
      'axis_direction_taken',
    ]);
  });

  it('le même axe à 60° pile est une seconde approche', () => {
    const selection = selectScaleGates([gate('a', 'A', 0, 400), gate('b', 'A', 60, 500)], rule);
    expect(selection.retained.map((g) => g.id).sort()).toEqual(['a', 'b']);
  });

  it('deux axes à 10° d’écart font deux ancres : deux routes, deux façons d’arriver', () => {
    const selection = selectScaleGates([gate('a', 'A', 0, 400), gate('b', 'B', 10, 500)], rule);
    expect(selection.retained).toHaveLength(2);
  });

  it('au-delà du plafond, tout est publié non retenu', () => {
    // 1 000 m et non 100 : à 100 m, les portes à 0° et 350° ne sont qu'à 17 m
    // l'une de l'autre, et depuis le 2026-09-30 ce serait le même carrefour.
    const many = [0, 70, 140, 210, 280, 350].map((az, i) => gate(`g${i}`, `AX${i}`, az, 1_000 + i));
    const selection = selectScaleGates(many, rule);
    expect(selection.retained).toHaveLength(5);
    expect(selection.gates.filter((g) => g.rank === null).map((g) => g.reasonCodes)).toEqual([
      ['slots_full'],
    ]);
  });

  /**
   * CLAMART, 2026-09-15 : deux axes BD TOPO qui se croisent au même carrefour
   * (180 m, 53,8°) donnaient deux ancres au même point. Décision produit :
   * « deux ancres à moins de 35 m l'une de l'autre n'en font qu'une » — quel
   * que soit leur axe.
   */
  it('deux axes au même carrefour ne font qu’une ancre : la plus proche, l’autre dit pourquoi', () => {
    const selection = selectScaleGates(
      [gate('hugo', 'HUGO', 53.8, 180), gate('proto', 'PROTO', 53.8, 181), gate('peri', 'PERI', 25.5, 379)],
      rule,
    );
    expect(selection.retained.map((g) => g.id).sort()).toEqual(['hugo', 'peri']);
    expect(selection.gates.find((g) => g.id === 'proto')?.reasonCodes).toEqual(['same_site']);
  });

  it('l’axe fusionné est servi : sa jonction suivante du même côté ne devient pas son ancre', () => {
    // Relecture du 2026-09-30 : sans cette règle, `proto2` (même axe, 60°,
    // 64 m de l'ancre gardée) était retenu — le doublon revenu par la porte
    // d'à côté. Une direction vraiment autre sur le même axe reste une ancre.
    const selection = selectScaleGates(
      [
        gate('hugo', 'HUGO', 53.8, 180),
        gate('proto', 'PROTO', 53.8, 181),
        gate('proto2', 'PROTO', 60, 240),
        gate('proto-sud', 'PROTO', 170, 300),
      ],
      rule,
    );
    expect(selection.retained.map((g) => g.id).sort()).toEqual(['hugo', 'proto-sud']);
    expect(selection.gates.find((g) => g.id === 'proto2')?.reasonCodes).toEqual(['axis_direction_taken']);
  });

  it('à 30 m on fusionne, à 40 m ce sont deux ancres', () => {
    // Même azimut, deux distances : l'écart entre les deux portes EST la différence.
    const at30 = selectScaleGates([gate('a', 'A', 90, 300), gate('b', 'B', 90, 330)], rule);
    expect(at30.retained.map((g) => g.id)).toEqual(['a']);
    const at40 = selectScaleGates([gate('a', 'A', 90, 300), gate('b', 'B', 90, 340)], rule);
    expect(at40.retained.map((g) => g.id).sort()).toEqual(['a', 'b']);
  });

  it('une porte fusionnée ne prend pas de place : la suivante est retenue', () => {
    const five = [0, 70, 140, 210, 280].map((az, i) => gate(`g${i}`, `AX${i}`, az, 100 + i));
    const twin = gate('jumelle', 'AUTRE', 0, 100);
    const selection = selectScaleGates([...five, twin], rule);
    expect(selection.retained).toHaveLength(5);
    expect(selection.gates.find((g) => g.id === 'jumelle')?.reasonCodes).toEqual(['same_site']);
  });

  it('l’anneau de plus ne retient que la moitié vide ; le reste est publié', () => {
    const selection = selectScaleGates([gate('vide', 'A', 200, 900), gate('plein', 'B', 10, 400)], {
      ...rule,
      eligible: (g) => g.azimuthDeg > 135 && g.azimuthDeg < 315,
    });
    expect(selection.retained.map((g) => g.id)).toEqual(['vide']);
    expect(selection.gates.find((g) => g.id === 'plein')?.reasonCodes).toEqual([
      'outside_empty_half',
    ]);
  });
});

describe('la moitié vide, et ce qui manque', () => {
  it('nord et est : la moitié vide est au sud-ouest', () => {
    expect(emptyHalfOf([0, 90])).toEqual({ fromDeg: 135, toDeg: 315, widthDeg: 180 });
  });

  it('nord et sud : aucune moitié n’est vide', () => {
    expect(emptyHalfOf([0, 180])).toBeNull();
  });

  it('une seule ancre : la moitié vide est en face', () => {
    expect(emptyHalfOf([90])).toEqual({ fromDeg: 180, toDeg: 0, widthDeg: 180 });
  });

  it('aucune ancre : il n’y a pas de moitié à combler, il n’y a rien du tout', () => {
    expect(emptyHalfOf([])).toBeNull();
  });

  it('les arcs sans ancre : un vide de 60° ne se signale pas, un de 270° si', () => {
    expect(uncoveredArcsOf([0, 60], 5_000, 60)).toEqual([
      { fromDeg: 60, toDeg: 0, widthDeg: 300, searchedToM: 5_000 },
    ]);
  });

  it('trois ancres bien réparties : trois arcs, tous nommés avec l’anneau atteint', () => {
    const arcs = uncoveredArcsOf([0, 120, 240], 2_000, 60);
    expect(arcs.map((arc) => arc.widthDeg)).toEqual([120, 120, 120]);
    expect(arcs.every((arc) => arc.searchedToM === 2_000)).toBe(true);
  });
});
