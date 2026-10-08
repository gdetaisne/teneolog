/**
 * la géométrie de l'impasse que la carte du demi-tour dessine :
 * l'axe orienté de la bouche vers le bout, l'arrêt dessus, le bout fermé, et
 * les branches avec leur côté et leur angle.
 *
 * Ce que les tests prouvent, contre quoi ils pourraient échouer :
 *  - le CÔTÉ est celui du conducteur dans le sens d'ENTRÉE, lu dans le plan
 *    est/nord : la même allée de service au sud est à DROITE quand on entre
 *    vers l'est (Sèvremoine) et à GAUCHE quand on entre vers l'ouest (le
 *    miroir) ; au nord, c'est l'inverse. Un signe inversé (le repère y vers le
 *    bas de swept-path) échouerait sur les quatre ;
 *  - une voie qui traverse l'axe donne DEUX bras, deux ids distincts ;
 *  - l'axe est retourné quand la chaîne du handoff court du bout vers la
 *    bouche (impasse coudée, rue sans bouche dessinée à l'envers) ;
 *  - sans sens d'entrée établi, le côté n'existe pas : inconnue dite ;
 *  - le champ n'existe qu'avec le bloc de policy, et il n'en change aucun autre ;
 *  - relecture du 24/09 : l'axe est coupé à l'entrée quand la chaîne passe le
 *    carrefour de la bouche, et dit s'il part d'une entrée ; la portée de
 *    lecture des branches est servie ; l'arrêt projeté sur la bouche même la
 *    garde ; un bout que la chaîne repasse (anneau, boucle en « P ») n'est pas
 *    un bout fermé. Chacun de ces tests échoue sans sa correction — celui de
 *    l'anneau, que l'ancienne garde couvrait déjà, échoue si la garde saute ;
 *  - seconde relecture du 24/09 : l'arrêt sur la bouche en QUEUE de chaîne
 *    (l'impasse dessinée du bout vers la bouche) échoue si la queue rend un
 *    autre sens ; l'arrêt sur le nœud de fermeture d'un anneau, qui est la
 *    bouche, échoue si ce nœud est pris pour un bout (le sens du dessin).
 */
import { describe, expect, it } from 'vitest';
import { IMPASSE_AXIS_ORIENTATION_UNKNOWN, type GeoPoint, type ImpasseGeometry, type TerminalTopology } from '@teneolog/domain';

import { haversineM } from '../src/geometry.js';
import { resolveHandoffWalk } from '../src/handoff.js';
import { computeImpasseGeometry } from '../src/impasse-geometry.js';
import type { RoadNeighbourhood, RoadWay } from '../src/ports.js';
import { assessTopology } from '../src/topology-assessment.js';
import { at, sevremoine, neighbourhood, way } from './fixtures.js';

const O: GeoPoint = { lat: 47.125714, lon: -0.946111 };
const FETCHED_AT = '2026-09-24T10:00:00Z';
/** La portée de la policy de référence : celle de la recherche des lieux de demi-tour. */
const PARAMS = { maxBranchAlongM: 120 };

function geometryOf(
  hood: RoadNeighbourhood,
  deliveryWayId: string,
  deliveryPoint: GeoPoint = O,
  options: { readonly kind?: TerminalTopology['kind']; readonly maxBranchAlongM?: number } = {},
) {
  return computeImpasseGeometry({
    neighbourhood: hood,
    topologyKind: options.kind ?? 'DEAD_END',
    handoff: resolveHandoffWalk({
      neighbourhood: hood,
      deliveryWayId,
      deliveryPoint,
      maxDepth: 2,
      maxDeviationDeg: 40,
      fetchedAt: FETCHED_AT,
    }),
    params: { maxBranchAlongM: options.maxBranchAlongM ?? PARAMS.maxBranchAlongM },
    fetchedAt: FETCHED_AT,
  });
}

function measured(fact: ReturnType<typeof computeImpasseGeometry>): {
  readonly value: ImpasseGeometry;
  readonly reasonCodes: readonly string[];
} {
  if (!fact.known) throw new Error(`expected a geometry, got ${fact.why}`);
  return { value: fact.value, reasonCodes: fact.reliability.reasonCodes };
}

function branch(value: ImpasseGeometry, id: string) {
  const found = value.branches.find((b) => b.id === id);
  if (found === undefined) throw new Error(`no branch ${id} in ${value.branches.map((b) => b.id).join(', ')}`);
  return found;
}

function expectNear(a: GeoPoint | null | undefined, b: GeoPoint, toleranceM = 0.01): void {
  if (a === null || a === undefined) throw new Error('expected a point');
  expect(haversineM(a, b)).toBeLessThan(toleranceM);
}

/** Sèvremoine with the stub drawn to the north of `j` instead of the south. */
function sevremoineStubNorth(): RoadNeighbourhood {
  const [allee, parent, other] = sevremoine(O) as [RoadWay, RoadWay, RoadWay, RoadWay];
  const stubNorth = way('stub', ['j', 'loopIn'], [at(O, 0, 10), at(O, 45, 10)], { tags: { highway: 'service' } });
  return neighbourhood(O, 120, [allee, parent, other, stubNorth]);
}

/** Sèvremoine mirrored east–west: the mouth is east of the stop, the tip west. Entry is WESTWARD. */
function sevremoineMirrored(stubNorthM: number): RoadNeighbourhood {
  const allee = way('allee', ['mouth', 'j', 'tip'], [at(O, 0, 20), at(O, 0, -10), at(O, 0, -40)], {
    tags: { highway: 'residential' },
  });
  const parent = way('parent', ['p1', 'mouth', 'p2'], [at(O, 200, 20), at(O, 0, 20), at(O, -200, 20)], {
    tags: { highway: 'residential' },
  });
  const stub = way('stub', ['j', 'loopIn'], [at(O, 0, -10), at(O, stubNorthM, -10)], { tags: { highway: 'service' } });
  return neighbourhood(O, 120, [allee, parent, stub]);
}

describe('Sèvremoine : l’axe, l’arrêt, le bout, les branches', () => {
  const { value, reasonCodes } = measured(geometryOf(neighbourhood(O, 120, sevremoine(O)), 'allee'));

  it('l’axe va de la bouche au bout fermé, l’arrêt à 20 m de la bouche', () => {
    expectNear(value.axis[0], at(O, 0, -20));
    expectNear(value.axis[value.axis.length - 1], at(O, 0, 40));
    expect(value.stopAlongM).toBeCloseTo(20, 1);
    expectNear(value.tip, at(O, 0, 40));
    expect(reasonCodes).toContain('axis_oriented_from_mouth');
    expect(reasonCodes).not.toContain('impasse_tip_not_proven');
  });

  it('l’allée de service au sud de j : à DROITE en entrant vers l’est, à angle droit, 10 m après l’arrêt', () => {
    const stub = branch(value, 'branch:j:stub@180');
    expect(stub.side).toBe('right');
    expect(stub.angleDeg).toBeCloseTo(90, 1);
    expect(stub.alongFromStopM).toBeCloseTo(10, 1);
    expect(stub.lengthM).toBeCloseTo(45, 0);
    expect(stub).toMatchObject({ nodeId: 'j', wayId: 'stub', highway: 'service', service: null, isMouth: false });
    expectNear(stub.at, at(O, 0, 10));
  });

  it('la parente à la bouche : deux bras, deux ids, tous deux la bouche — nord à gauche, sud à droite', () => {
    const north = branch(value, 'branch:mouth:parent@0');
    const south = branch(value, 'branch:mouth:parent@180');
    expect([north.side, south.side]).toEqual(['left', 'right']);
    expect(north.angleDeg).toBeCloseTo(90, 1);
    expect(south.angleDeg).toBeCloseTo(90, 1);
    expect(north.isMouth && south.isMouth).toBe(true);
    // Négatif : vers la bouche.
    expect(north.alongFromStopM).toBeCloseTo(-20, 1);
    // La longueur est celle du bras, pas de la voie entière : 200 m de chaque côté.
    expect(north.lengthM).toBeCloseTo(200, 0);
    expect(south.lengthM).toBeCloseTo(200, 0);
  });

  it('seules les chaussées qui partent de l’axe : ni la rue d’à côté, ni l’axe lui-même ; ordonnées par abscisse', () => {
    expect(value.branches.map((b) => b.id)).toEqual([
      'branch:mouth:parent@0',
      'branch:mouth:parent@180',
      'branch:j:stub@180',
    ]);
  });
});

describe('le côté, dans le sens d’entrée, lu dans le plan est/nord', () => {
  it('symétrie : la même allée au NORD de j est à GAUCHE en entrant vers l’est', () => {
    const { value } = measured(geometryOf(sevremoineStubNorth(), 'allee'));
    const stub = branch(value, 'branch:j:stub@0');
    expect(stub.side).toBe('left');
    expect(stub.angleDeg).toBeCloseTo(90, 1);
  });

  it('le miroir est–ouest : en entrant vers l’OUEST, l’allée au sud est à GAUCHE, celle au nord à DROITE', () => {
    const south = measured(geometryOf(sevremoineMirrored(-45), 'allee')).value;
    const north = measured(geometryOf(sevremoineMirrored(45), 'allee')).value;
    expect(branch(south, 'branch:j:stub@180').side).toBe('left');
    expect(branch(north, 'branch:j:stub@0').side).toBe('right');
    // L'axe part toujours de la bouche, ici à l'est.
    expectNear(south.axis[0], at(O, 0, 20));
    expect(branch(south, 'branch:j:stub@180').alongFromStopM).toBeCloseTo(10, 1);
  });

  it('l’angle est l’écart au sens d’entrée : une branche qui part en avant est aiguë, en arrière obtuse', () => {
    const [allee, parent] = sevremoine(O) as [RoadWay, RoadWay, RoadWay, RoadWay];
    // Deux allées depuis j : l'une en avant vers le nord-est (45°), l'autre en arrière vers le sud-ouest.
    const ahead = way('ahead', ['j', 'a1'], [at(O, 0, 10), at(O, 20, 30)], { tags: { highway: 'service', service: 'driveway' } });
    const back = way('back', ['j', 'b1'], [at(O, 0, 10), at(O, -20, -10)], { tags: { highway: 'service' } });
    const { value } = measured(geometryOf(neighbourhood(O, 120, [allee, parent, ahead, back]), 'allee'));
    const a = value.branches.find((b) => b.wayId === 'ahead');
    const b = value.branches.find((x) => x.wayId === 'back');
    expect(a?.angleDeg).toBeCloseTo(45, 0);
    expect(a?.side).toBe('left');
    expect(a?.service).toBe('driveway');
    expect(b?.angleDeg).toBeCloseTo(135, 0);
    expect(b?.side).toBe('right');
  });
});

describe('une impasse coudée, dessinée du bout vers la bouche', () => {
  /**
   * Mouth 40 m north of a corner, then 30 m west to the tip at O; a driveway
   * leaves `d` (15 m east of the tip) to the north. The way is drawn tip first,
   * so the handoff's chain runs backwards and the axis must be turned round.
   */
  function bent(): RoadNeighbourhood {
    const impasse = way('impasse', ['tip', 'd', 'corner', 'mouth'], [O, at(O, 0, 15), at(O, 0, 30), at(O, 40, 30)]);
    const parent = way('parent', ['p1', 'mouth', 'p2'], [at(O, 40, -10), at(O, 40, 30), at(O, 40, 70)], {
      name: 'Rue Haute',
    });
    const cross = way('cross', ['c1', 'p1', 'c2'], [at(O, 80, -10), at(O, 40, -10), at(O, 0, -10)]);
    const drive = way('drive', ['d', 'dEnd'], [at(O, 0, 15), at(O, 20, 15)], { tags: { highway: 'service' } });
    return neighbourhood(O, 120, [impasse, parent, cross, drive]);
  }
  const stop = at(O, -2, 20);

  it('l’axe part de la bouche, tourne au coin, finit au bout ; l’arrêt à 50 m le long de l’axe', () => {
    const { value } = measured(geometryOf(bent(), 'impasse', stop));
    expectNear(value.axis[0], at(O, 40, 30));
    expectNear(value.axis[1], at(O, 0, 30));
    expectNear(value.tip, O);
    expect(value.stopAlongM).toBeCloseTo(50, 0);
  });

  it('au coin tourné vers l’ouest, l’allée au nord est à DROITE ; à la bouche, en entrant vers le sud, l’est est à GAUCHE', () => {
    const { value } = measured(geometryOf(bent(), 'impasse', stop));
    const drive = branch(value, 'branch:d:drive@0');
    expect(drive.side).toBe('right');
    expect(drive.angleDeg).toBeCloseTo(90, 1);
    expect(drive.alongFromStopM).toBeCloseTo(5, 0);
    expect(branch(value, 'branch:mouth:parent@90').side).toBe('left');
    expect(branch(value, 'branch:mouth:parent@270').side).toBe('right');
    expect(branch(value, 'branch:mouth:parent@90').alongFromStopM).toBeCloseTo(-50, 0);
  });

  it('au coin même, la branche se lit contre la tangente (la bissectrice sud / ouest), pas contre un des deux côtés', () => {
    const spur = way('spur', ['corner', 'sEnd'], [at(O, 0, 30), at(O, 0, 60)], { tags: { highway: 'service' } });
    const hood = bent();
    const { value } = measured(geometryOf(neighbourhood(O, 120, [...hood.ways, spur]), 'impasse', stop));
    const east = branch(value, 'branch:corner:spur@90');
    // Arrivée vers le sud, départ vers l'ouest : tangente au sud-ouest ; l'est est à 135°, à gauche.
    expect(east.angleDeg).toBeCloseTo(135, 0);
    expect(east.side).toBe('left');
  });

  it('la portée de policy borne la liste, des deux côtés de l’arrêt', () => {
    const { value } = measured(geometryOf(bent(), 'impasse', stop, { maxBranchAlongM: 30 }));
    expect(value.branches.map((b) => b.id)).toEqual(['branch:d:drive@0']);
  });
});

describe('sans bouche, avec une bouche imbriquée, et ce qui n’est pas une réponse', () => {
  /**
   * The silence test's villa: its feeder carries straight on, so the handoff
   * chains both into one street leaving the fetch at the far west — no
   * junction, no mouth. The villa is drawn tip first: the chain starts at the
   * closed tip and must be turned round by it.
   */
  function noMouth(): RoadNeighbourhood {
    const villa = way('villa', ['tip', 'k', 'j'], [at(O, -4, 45), at(O, -4, 20), at(O, -4, -10)]);
    const feeder = way('feeder', ['j', 'f0'], [at(O, -4, -10), at(O, -4, -300)]);
    const drive = way('drive', ['k', 'kEnd'], [at(O, -4, 20), at(O, -24, 20)], { tags: { highway: 'service' } });
    return neighbourhood(O, 120, [villa, feeder, drive]);
  }

  it('sans bouche : orientée par le seul bout fermé, et la raison le dit', () => {
    const hood = noMouth();
    const walk = resolveHandoffWalk({ neighbourhood: hood, deliveryWayId: 'villa', deliveryPoint: O, maxDepth: 2, maxDeviationDeg: 40, fetchedAt: FETCHED_AT });
    expect(walk.mouth.known).toBe(false);

    const { value, reasonCodes } = measured(geometryOf(hood, 'villa'));
    expect(reasonCodes).toContain('axis_oriented_by_closed_tip_no_mouth');
    expectNear(value.axis[0], at(O, -4, -300));
    expectNear(value.tip, at(O, -4, 45));
    // En entrant vers l'est, l'allée au sud est à droite.
    expect(branch(value, 'branch:k:drive@180').side).toBe('right');
    expect(value.branches.some((b) => b.isMouth)).toBe(false);
  });

  it('bouche imbriquée : l’axe part de la jonction vers la poche, aucune branche n’est la bouche, et c’est dit', () => {
    const inner = way('inner', ['j1', 'tip'], [at(O, 0, -10), at(O, 0, 25)]);
    const pocket = way('pocket', ['pocket-tip', 'j2', 'j1'], [at(O, 70, -10), at(O, 35, -10), at(O, 0, -10)]);
    const through = way('through', ['t1', 'j2', 't2'], [at(O, 35, -60), at(O, 35, -10), at(O, 35, 40)]);
    const crossT = way('cross-t', ['x1', 't1', 'x2'], [at(O, 70, -60), at(O, 35, -60), at(O, 0, -60)]);
    const hood = neighbourhood(O, 120, [inner, pocket, through, crossT]);

    const { value, reasonCodes } = measured(geometryOf(hood, 'inner'));
    expect(reasonCodes).toContain('axis_oriented_from_nested_mouth');
    expectNear(value.axis[0], at(O, 0, -10));
    const toPocket = branch(value, 'branch:j1:pocket@0');
    expect(toPocket.side).toBe('left');
    expect(toPocket.isMouth).toBe(false);
  });

  it('fermée aux deux bouts, sans bouche : le sens d’entrée n’est pas connu — inconnue dite, jamais un sens au hasard', () => {
    const pocket = way('pocket', ['a', 'b'], [at(O, 0, -20), at(O, 0, 20)]);
    const fact = geometryOf(neighbourhood(O, 120, [pocket]), 'pocket');
    expect(fact).toMatchObject({ known: false, why: 'no_data', provenance: { method: IMPASSE_AXIS_ORIENTATION_UNKNOWN } });
  });

  it('bout non prouvé (au bord du voisinage) : l’axe est servi, le bout est null, et c’est dit', () => {
    const [allee, parent, other, stub] = sevremoine(O) as [RoadWay, RoadWay, RoadWay, RoadWay];
    // 40 m east of the stop, the tip sits on the edge of a 40 m fetch: not proven.
    const { value, reasonCodes } = measured(geometryOf(neighbourhood(O, 40, [allee, parent, other, stub]), 'allee'));
    expect(value.tip).toBeNull();
    expect(reasonCodes).toContain('impasse_tip_not_proven');
  });

  it('rue traversante : sans objet ; rue absente du voisinage : no_data, sans provenance inventée', () => {
    const hood = neighbourhood(O, 120, sevremoine(O));
    expect(geometryOf(hood, 'allee', O, { kind: 'THROUGH' })).toEqual({ known: false, why: 'not_applicable' });
    expect(geometryOf(hood, 'nowhere')).toEqual({ known: false, why: 'no_data' });
  });
});

describe('assessTopology — le bloc de policy décide seul de la présence du champ', () => {
  const base = {
    neighbourhood: neighbourhood(O, 120, sevremoine(O)),
    surfaces: [],
    deliveryWayId: 'allee',
    deliveryPoint: O,
    turnaroundSearchRadiusM: 120,
    maxMouthDepth: 2,
    maxDeviationDeg: 40,
    barrierSnapM: 6,
    measurement: {
      defaultTurningCircleDiameterM: null,
      fallbackCarriagewayWidthM: null,
      loopClosureToleranceM: 3,
      observedAt: FETCHED_AT,
    },
  };

  it('absent : aucun champ ; présent : le même assessment, plus la géométrie, rien d’autre ne bouge', () => {
    const without = assessTopology(base);
    const withGeometry = assessTopology({ ...base, impasseGeometry: PARAMS });
    expect('impasseGeometry' in without).toBe(false);

    const { impasseGeometry, ...rest } = withGeometry;
    expect(rest).toEqual(without);
    expect(impasseGeometry).toEqual(geometryOf(base.neighbourhood, 'allee'));
    expect(impasseGeometry?.known).toBe(true);
  });
});

/** The kind the terminal classification gives, and the geometry, the way `assessTopology` chains them. */
function assessed(hood: RoadNeighbourhood, deliveryWayId: string, deliveryPoint: GeoPoint) {
  const assessment = assessTopology({
    neighbourhood: hood,
    surfaces: [],
    deliveryWayId,
    deliveryPoint,
    turnaroundSearchRadiusM: 120,
    maxMouthDepth: 2,
    maxDeviationDeg: 40,
    barrierSnapM: 6,
    measurement: {
      defaultTurningCircleDiameterM: null,
      fallbackCarriagewayWidthM: null,
      loopClosureToleranceM: 3,
      observedAt: FETCHED_AT,
    },
    impasseGeometry: PARAMS,
  });
  if (assessment.impasseGeometry === undefined) throw new Error('expected the geometry field');
  return { kind: assessment.topology.kind, geometry: assessment.impasseGeometry };
}

describe('relecture — l’axe commence à l’entrée, pas au bout de la chaîne', () => {
  /**
   * The impasse carries straight on across its mouth X as another way, `far`
   * (150 m, a side way at `cm`, a through street D at its far end). The
   * handoff chains `far` and the impasse (0° apart): the chain starts 150 m
   * before the mouth, on the other side of the crossroads.
   */
  function crossroads(): RoadNeighbourhood {
    const impasse = way('impasse', ['X', 'a1', 'tip'], [at(O, 0, -30), at(O, 0, 5), at(O, 0, 40)]);
    const far = way('far', ['c0', 'cm', 'X'], [at(O, 0, -180), at(O, 0, -100), at(O, 0, -30)]);
    const b = way('B', ['b1', 'X', 'b2'], [at(O, 200, -30), at(O, 0, -30), at(O, -200, -30)]);
    const d = way('D', ['d1', 'c0', 'd2'], [at(O, 200, -180), at(O, 0, -180), at(O, -200, -180)]);
    const side = way('side', ['cm', 's1'], [at(O, 0, -100), at(O, 40, -100)], { tags: { highway: 'service' } });
    return neighbourhood(O, 120, [impasse, far, b, d, side]);
  }

  it('la chaîne passe le carrefour, l’axe servi commence à la bouche : l’arrêt à 30 m, rien de l’autre côté', () => {
    const hood = crossroads();
    const walk = resolveHandoffWalk({ neighbourhood: hood, deliveryWayId: 'impasse', deliveryPoint: O, maxDepth: 2, maxDeviationDeg: 40, fetchedAt: FETCHED_AT });
    // Le handoff, lui, chaîne bien les deux voies : c'est l'axe qui se coupe.
    expectNear(walk.street?.points[0], at(O, 0, -180));

    const { value, reasonCodes } = measured(geometryOf(hood, 'impasse'));
    expect(reasonCodes).toContain('axis_oriented_from_mouth');
    expect(value.startsAtEntry).toBe(true);
    expectNear(value.axis[0], at(O, 0, -30));
    expect(value.axis).toHaveLength(3);
    expect(value.stopAlongM).toBeCloseTo(30, 1);
    expectNear(value.tip, at(O, 0, 40));
    // Les bras de la parente à la bouche, et eux seuls : l'allée de `cm`, de
    // l'autre côté du carrefour, n'est pas une branche de l'impasse.
    expect(value.branches.map((b) => [b.id, b.isMouth])).toEqual([
      ['branch:X:B@0', true],
      ['branch:X:B@180', true],
    ]);
    expect(value.branches[0]?.alongFromStopM).toBeCloseTo(-30, 1);
  });

  it('bouche en tête de chaîne (Sèvremoine) : rien n’est coupé, l’axe est celui d’avant', () => {
    const { value } = measured(geometryOf(neighbourhood(O, 120, sevremoine(O)), 'allee'));
    expect(value.startsAtEntry).toBe(true);
    expect(value.axis).toHaveLength(3);
  });

  it('sans bouche, orientée par le seul bout fermé : aucune entrée connue, et le champ le dit', () => {
    const villa = way('villa', ['tip', 'k', 'j'], [at(O, -4, 45), at(O, -4, 20), at(O, -4, -10)]);
    const feeder = way('feeder', ['j', 'f0'], [at(O, -4, -10), at(O, -4, -300)]);
    const { value, reasonCodes } = measured(geometryOf(neighbourhood(O, 120, [villa, feeder]), 'villa'));
    expect(reasonCodes).toEqual(['axis_oriented_by_closed_tip_no_mouth']);
    expect(value.startsAtEntry).toBe(false);
    // Rien n'est coupé : l'axe commence là où la chaîne a été lue.
    expectNear(value.axis[0], at(O, -4, -300));
  });

  it('la portée où les branches sont lues est servie avec la géométrie', () => {
    const { value } = measured(geometryOf(neighbourhood(O, 120, sevremoine(O)), 'allee', O, { maxBranchAlongM: 45 }));
    expect(value.branchesReadWithinM).toBe(45);
  });
});

describe('relecture — l’arrêt projeté sur la bouche même', () => {
  // 3 m au nord et 4 m avant la bouche : la projection se pose sur la tête de la chaîne, la bouche.
  const onMouth = at(O, 3, -24);

  it('la bouche connue donne le sens d’entrée, et ses bras restent la bouche', () => {
    const hood = neighbourhood(O, 120, sevremoine(O));
    const walk = resolveHandoffWalk({ neighbourhood: hood, deliveryWayId: 'allee', deliveryPoint: onMouth, maxDepth: 2, maxDeviationDeg: 40, fetchedAt: FETCHED_AT });
    expect(walk.mouth.known && walk.mouth.value.distanceFromStopM).toBe(0);

    const { value, reasonCodes } = measured(geometryOf(hood, 'allee', onMouth));
    expect(reasonCodes).toEqual(['axis_oriented_from_mouth']);
    expect(value.stopAlongM).toBe(0);
    expect(value.startsAtEntry).toBe(true);
    const north = branch(value, 'branch:mouth:parent@0');
    const south = branch(value, 'branch:mouth:parent@180');
    expect([north.isMouth, south.isMouth]).toEqual([true, true]);
    expect([north.side, south.side]).toEqual(['left', 'right']);
    expect(north.alongFromStopM).toBe(0);
  });

  it('la même impasse dessinée du bout vers la bouche : la bouche, en QUEUE de chaîne, donne le même sens', () => {
    // La moitié « queue » de la relecture : sans elle, l'axe se coupait à la
    // queue (un seul sommet, aucune branche) ou prenait le sens du bout fermé.
    const [, parent, other, stub] = sevremoine(O) as [RoadWay, RoadWay, RoadWay, RoadWay];
    const allee = way('allee', ['tip', 'j', 'mouth'], [at(O, 0, 40), at(O, 0, 10), at(O, 0, -20)], {
      declaredWidthM: 3,
      tags: { highway: 'residential' },
    });
    const hood = neighbourhood(O, 120, [allee, parent, other, stub]);
    const walk = resolveHandoffWalk({ neighbourhood: hood, deliveryWayId: 'allee', deliveryPoint: onMouth, maxDepth: 2, maxDeviationDeg: 40, fetchedAt: FETCHED_AT });
    expect(walk.street?.nodeIds).toEqual(['tip', 'j', 'mouth']);
    expect(walk.legs?.[0]?.fromAlongM).toBe(walk.legs?.[0]?.toAlongM);
    expect(walk.legs?.[0]?.toAlongM).toBe(walk.street?.alongM[2]);

    const { value, reasonCodes } = measured(geometryOf(hood, 'allee', onMouth));
    expect(reasonCodes).toEqual(['axis_oriented_from_mouth']);
    expect(value.axis).toHaveLength(3);
    expectNear(value.axis[0], at(O, 0, -20));
    expectNear(value.tip, at(O, 0, 40));
    expect(value.stopAlongM).toBe(0);
    expect(value.startsAtEntry).toBe(true);
    const north = branch(value, 'branch:mouth:parent@0');
    const south = branch(value, 'branch:mouth:parent@180');
    expect([north.isMouth, south.isMouth]).toEqual([true, true]);
    expect([north.side, south.side]).toEqual(['left', 'right']);
    const stubArm = branch(value, 'branch:j:stub@180');
    expect(stubArm.side).toBe('right');
    expect(stubArm.alongFromStopM).toBeCloseTo(30, 1);
  });

  it('le bout finit sur une boucle (pas de bout prouvé) : la bouche suffit, la géométrie est connue', () => {
    const [allee, parent, other, stub] = sevremoine(O) as [RoadWay, RoadWay, RoadWay, RoadWay];
    // Une boucle dessinée comme une voie fermée au bout : le bout n'est plus un bout fermé.
    const loop = way('loop', ['tip', 'l1', 'l2', 'tip'], [at(O, 0, 40), at(O, 20, 50), at(O, 20, 30), at(O, 0, 40)]);
    const hood = neighbourhood(O, 120, [allee, parent, other, stub, loop]);
    const { value, reasonCodes } = measured(geometryOf(hood, 'allee', onMouth));
    expect(reasonCodes).toEqual(['axis_oriented_from_mouth', 'impasse_tip_not_proven']);
    expectNear(value.axis[0], at(O, 0, -20));
    expect(value.tip).toBeNull();
  });

  it('bouche au milieu de la chaîne, sous l’arrêt : le bout fermé donne le sens, la bouche reste la bouche et l’axe part d’elle', () => {
    // La rue continue la chaîne au-delà du carrefour X en tournant de 30° : l'arrêt, au sud-est du coude, se projette sur X.
    const impasse = way('impasse', ['X', 'a1', 'tip'], [at(O, 0, -30), at(O, 20, 5), at(O, 40, 40)]);
    const far = way('far', ['c0', 'cm', 'X'], [at(O, 0, -180), at(O, 0, -100), at(O, 0, -30)]);
    const b = way('B', ['b1', 'X', 'b2'], [at(O, 200, -30), at(O, 0, -30), at(O, -200, -30)]);
    const d = way('D', ['d1', 'c0', 'd2'], [at(O, 200, -180), at(O, 0, -180), at(O, -200, -180)]);
    const hood = neighbourhood(O, 120, [impasse, far, b, d]);
    const stop = at(O, -5, -28);
    const walk = resolveHandoffWalk({ neighbourhood: hood, deliveryWayId: 'impasse', deliveryPoint: stop, maxDepth: 2, maxDeviationDeg: 40, fetchedAt: FETCHED_AT });
    expect(walk.legs?.[0]?.fromAlongM).toBe(walk.legs?.[0]?.toAlongM);
    expect(walk.street?.nodeIds[0]).toBe('c0');

    const { value, reasonCodes } = measured(geometryOf(hood, 'impasse', stop));
    expect(reasonCodes).toEqual(['axis_oriented_by_closed_tip']);
    expect(value.startsAtEntry).toBe(true);
    expectNear(value.axis[0], at(O, 0, -30));
    expect(value.stopAlongM).toBe(0);
    expect(value.branches.map((x) => [x.id, x.isMouth])).toEqual([
      ['branch:X:B@0', true],
      ['branch:X:B@180', true],
    ]);
  });
});

describe('relecture — un bout que la chaîne repasse n’est pas un bout fermé', () => {
  it('une voie de livraison en anneau, la tige accrochée ailleurs qu’au nœud de fermeture : pas de bout', () => {
    const ring = way('ring', ['a', 'b', 'c', 'a'], [at(O, -25, 20), at(O, 0, -10), at(O, 25, 20), at(O, -25, 20)]);
    const stem = way('stem', ['b', 's1'], [at(O, 0, -10), at(O, 0, -40)]);
    const through = way('through', ['p1', 's1', 'p2'], [at(O, 200, -40), at(O, 0, -40), at(O, -200, -40)]);
    const { kind, geometry } = assessed(neighbourhood(O, 120, [ring, stem, through]), 'ring', at(O, 12, 6));
    expect(kind).not.toBe('THROUGH');
    const { value, reasonCodes } = measured(geometry);
    expect(value.tip).toBeNull();
    expect(reasonCodes).toContain('impasse_tip_not_proven');
  });

  it('l’arrêt projeté sur le nœud de fermeture, qui est la bouche : pas de sens tiré du sens du dessin', () => {
    // La rue quitte ce nœud des deux côtés de l'anneau : ni la tête ni la
    // queue de la chaîne n'y est un bout. Avant la garde, le sens était celui
    // du dessin — l'allée de `b` à gauche à 36 m, ou à droite à 76 m.
    const pos: Record<string, GeoPoint> = { a: at(O, 0, -20), b: at(O, 20, 10), c: at(O, -20, 10) };
    const stop = at(O, 0, -25);
    for (const order of [['a', 'b', 'c', 'a'], ['a', 'c', 'b', 'a']]) {
      const ring = way('ring', order, order.map((id) => pos[id]!));
      const parent = way('parent', ['p1', 'a', 'p2'], [at(O, 200, -20), at(O, 0, -20), at(O, -200, -20)]);
      const drv = way('drv', ['b', 'd1'], [at(O, 20, 10), at(O, 20, 50)], { tags: { highway: 'service' } });
      const hood = neighbourhood(O, 120, [ring, parent, drv]);
      const walk = resolveHandoffWalk({ neighbourhood: hood, deliveryWayId: 'ring', deliveryPoint: stop, maxDepth: 2, maxDeviationDeg: 40, fetchedAt: FETCHED_AT });
      expect(walk.legs?.[0]).toMatchObject({ fromAlongM: 0, toAlongM: 0 });

      const { kind, geometry } = assessed(hood, 'ring', stop);
      expect(kind).toBe('TERMINAL_LOOP');
      expect(geometry.known).toBe(false);
      if (geometry.known) continue;
      expect(geometry.provenance?.method).toBe(IMPASSE_AXIS_ORIENTATION_UNKNOWN);
    }
  });

  it('une raquette dessinée d’un trait, en P : le col de la boucle n’est pas le bout de l’impasse', () => {
    const d = way('d', ['m', 's'], [at(O, 0, -20), at(O, 0, 0)]);
    const p = way('p', ['s', 'x', 'l1', 'l2', 'x'], [at(O, 0, 0), at(O, 0, 30), at(O, 15, 45), at(O, -15, 45), at(O, 0, 30)]);
    const parent = way('parent', ['p1', 'm', 'p2'], [at(O, 200, -20), at(O, 0, -20), at(O, -200, -20)]);
    const { kind, geometry } = assessed(neighbourhood(O, 120, [d, p, parent]), 'd', at(O, 3, -10));
    expect(kind).toBe('TERMINAL_LOOP');
    const { value, reasonCodes } = measured(geometry);
    expect(reasonCodes).toEqual(['axis_oriented_from_mouth', 'impasse_tip_not_proven']);
    expect(value.tip).toBeNull();
  });
});
