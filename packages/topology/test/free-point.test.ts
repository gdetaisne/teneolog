/**
 * tranche 2 — un point cliqué sur la carte : la chaussée la plus
 * proche, la marche le long de la chaussée jusqu'à la porte, les bandes, et
 * les trois réponses qui ne sont pas des mesures.
 *
 * Le croquis est celui de la Sèvremoine (`fixtures.ts`) : la porte est
 * l'origine, sur l'allée (est–ouest) ; la bouche 20 m à l'ouest ; la Rue des
 * Voisine MA (nord–sud) la croise à la bouche ; `other` part de la parente 40 m au
 * sud de la bouche ; `stub` (service) part de `j`, 10 m à l'est de la porte.
 */
import { describe, expect, it } from 'vitest';
import type { GeoPoint } from '@teneolog/domain';

import { freePointOutOfArea, measureFreePoint, type FreePointInput } from '../src/free-point.js';
import { haversineM } from '../src/geometry.js';
import type { RoadNeighbourhood, RoadWay } from '../src/ports.js';
import { at, sevremoine, neighbourhood, way } from './fixtures.js';

const O: GeoPoint = { lat: 47.125714, lon: -0.946111 };
const PARAMS = { maxSnapM: 30, areaRadiusM: 300, plainWalkMaxM: 50, portageWalkMaxM: 150 };

/** Sèvremoine, plus a street nobody's road reaches: 80 m south-east, not joined to anything. */
function hood(): RoadNeighbourhood {
  const [allee, parent, other, stub] = sevremoine(O) as [RoadWay, RoadWay, RoadWay, RoadWay];
  const voisineMa: RoadWay = { ...parent, name: 'Rue Voisine MA', declaredWidthM: 5.5 };
  const island = way('island', ['i1', 'i2'], [at(O, -80, 60), at(O, -80, 140)], {
    name: 'Chemin isolé',
    tags: { highway: 'residential' },
  });
  return neighbourhood(O, 320, [allee, voisineMa, other, stub, island]);
}

function click(point: GeoPoint, overrides: Partial<FreePointInput> = {}) {
  return measureFreePoint({
    neighbourhood: hood(),
    deliveryWayId: 'allee',
    deliveryPoint: O,
    point,
    params: PARAMS,
    ...overrides,
  });
}

describe('measureFreePoint — Sèvremoine', () => {
  it('un clic 5 m à côté de la Rue Voisine MA, 25 m au sud de la bouche : arrêt sur son axe, 45 m par la route, bande plain', () => {
    const answer = click(at(O, -25, -15));
    expect(answer.status).toBe('measured');
    expect(haversineM(answer.stopAt ?? O, at(O, -25, -20))).toBeLessThan(0.1);
    expect(answer.street?.name).toBe('Rue Voisine MA');
    expect(answer.street?.segmentId).toBe('parent');
    // 20 m porte → bouche le long de l'allée, puis 25 m sur la parente.
    expect(answer.walk?.roadM).toBeCloseTo(45, 0);
    expect(answer.walk?.pointToAxisM).toBeCloseTo(0, 5);
    expect(answer.band).toBe('plain');
  });

  it('plus loin sur la parente, la bande suit la marche : 120 m portage, 200 m au-delà — mesuré quand même', () => {
    const portage = click(at(O, -100, -20));
    expect(portage.status).toBe('measured');
    expect(portage.walk?.roadM).toBeCloseTo(120, 0);
    expect(portage.band).toBe('portage');

    const beyond = click(at(O, -180, -20));
    expect(beyond.status).toBe('measured');
    expect(beyond.walk?.totalM).toBeCloseTo(200, 0);
    expect(beyond.band).toBe('beyond');
  });

  it('la route, pas le vol d’oiseau : Allée Voisine JC à 40 m de la porte, 80 m à pied', () => {
    const point = at(O, -40, 0);
    expect(haversineM(O, point)).toBeCloseTo(40, 0);
    const answer = click(point);
    expect(answer.street?.segmentId).toBe('other');
    // 20 (allée) + 40 (parente, bouche → q) + 20 (other, q → le clic).
    expect(answer.walk?.roadM).toBeCloseTo(80, 0);
    expect(answer.band).toBe('portage');
  });

  it('un clic dans l’impasse, au-delà de j : la marche le long de l’allée (30 m)', () => {
    const answer = click(at(O, 3, 30));
    expect(answer.status).toBe('measured');
    expect(answer.street?.segmentId).toBe('allee');
    expect(answer.walk?.roadM).toBeCloseTo(30, 0);
  });

  it('un clic sur le même tronçon que la porte : la course directe (5 m), pas le détour par un nœud (15 m)', () => {
    const answer = click(at(O, 2, 5));
    expect(answer.walk?.roadM).toBeCloseTo(5, 0);
  });

  it('par le service de la boucle (stub) : 10 m d’allée jusqu’à j, puis 30 m', () => {
    const answer = click(at(O, -30, 12));
    expect(answer.street?.segmentId).toBe('stub');
    expect(answer.walk?.roadM).toBeCloseTo(40, 0);
  });

  it('la porte hors de l’axe : le dernier tronçon porte → axe s’ajoute, comme pour l’arrêt de repli', () => {
    const door = at(O, 8, 0);
    const answer = click(at(O, -25, -15), { deliveryPoint: door });
    expect(answer.walk?.pointToAxisM).toBeCloseTo(8, 0);
    expect(answer.walk?.totalM).toBeCloseTo(53, 0);
    expect(answer.band).toBe('portage');
  });
});

describe('measureFreePoint — ce qui n’est pas une mesure', () => {
  it('loin de toute chaussée (100 m au nord-est) : no_street_near_point, sans arrêt ni marche', () => {
    expect(click(at(O, 100, 100))).toEqual({
      status: 'no_street_near_point',
      stopAt: null,
      street: null,
      walk: null,
      band: null,
    });
  });

  it('sur une voie qu’aucune route du voisinage ne relie à la porte : unreachable, l’arrêt dit, aucune distance', () => {
    const answer = click(at(O, -85, 100));
    expect(answer.status).toBe('unreachable');
    expect(answer.street?.name).toBe('Chemin isolé');
    expect(answer.stopAt).not.toBeNull();
    expect(answer.walk).toBeNull();
    expect(answer.band).toBeNull();
  });

  it('au-delà de la zone lue autour de la porte : out_of_area, avant même de chercher une rue', () => {
    const far = at(O, -310, -20); // sur l'axe de la parente prolongée, mais à 310 m
    expect(click(far).status).toBe('out_of_area');
    expect(freePointOutOfArea(O, far, PARAMS)?.status).toBe('out_of_area');
    expect(freePointOutOfArea(O, at(O, -25, -20), PARAMS)).toBeNull();
  });

  it('une voie non carrossable (sentier) n’accroche pas le clic', () => {
    const path = way('path', ['f1', 'f2'], [at(O, 60, 100), at(O, 60, 200)], { tags: { highway: 'footway' } });
    const base = hood();
    const answer = click(at(O, 62, 150), { neighbourhood: neighbourhood(O, 320, [...base.ways, path]) });
    expect(answer.status).toBe('no_street_near_point');
  });
});
