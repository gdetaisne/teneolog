/**
 * une jambe qui traverse une autre ancre, mesurée en mètres.
 *
 * Trois nombres viennent de l'engine et sont vérifiés ici pour ce qu'ils
 * valent, pas pour ce qu'ils disent : 30 m pour « traverser », 15 m de
 * dégagement au départ, 5 m de départage entre deux ancres. Le quatrième point
 * est le plus important : la mesure se fait PAR ARÊTE, donc une ancre posée au
 * milieu d'un long segment est vue même si aucun sommet ne la longe — c'est ce
 * défaut-là qui, côté engine, faisait dépendre le résultat de la décimation
 * d'OSRM.
 */
import { describe, expect, it } from 'vitest';
import type { GeoPoint } from '@teneolog/domain';

import {
  GATE_DEPARTURE_CLEARANCE_M,
  GATE_SITE_PROXIMITY_M,
  detectGatePass,
  gateKeyOf,
} from '../src/gate-pass.js';
import type { Gate } from '../src/gates.js';

const O: GeoPoint = { lat: 47.0, lon: 1.0 };
const M_PER_DEG_LAT = 111_320;

function at(northM: number, eastM = 0): GeoPoint {
  return {
    lat: O.lat + northM / M_PER_DEG_LAT,
    lon: O.lon + eastM / (M_PER_DEG_LAT * Math.cos((O.lat * Math.PI) / 180)),
  };
}

function gate(wayId: string, azimuthDeg: number, northM: number, eastM = 0): Gate {
  return { wayId, azimuthDeg, at: at(northM, eastM), distanceM: Math.hypot(northM, eastM) };
}

/** L'ancre lointaine, sur la même pénétrante nord que l'ancre proche. */
const LOIN = gate('penetrante', 0, 1_900);
const PROCHE = gate('penetrante', 1, 900);
const AILLEURS = gate('est', 90, 0, 1_900);

/** Une droite du nord vers l'arrêt, un sommet tous les 100 m. */
function nord(fromM: number, eastM = 0): readonly GeoPoint[] {
  const points: GeoPoint[] = [];
  for (let m = fromM; m >= 0; m -= 100) points.push(at(m, eastM));
  return points;
}

describe('la clé d’une ancre', () => {
  it('est `wayId@azimut`, l’avant de l’identifiant d’une jambe', () => {
    expect(gateKeyOf(LOIN)).toBe('penetrante@0');
    expect(gateKeyOf(AILLEURS)).toBe('est@90');
  });
});

describe('une entrante qui traverse une ancre plus proche', () => {
  it('la marque, avec la distance mesurée', () => {
    const mark = detectGatePass({
      polyline: nord(1_900),
      gate: LOIN,
      gates: [LOIN, PROCHE, AILLEURS],
      stop: at(0),
      direction: 'in',
    });
    expect(mark?.gateId).toBe('penetrante@1');
    expect(mark?.distanceM).toBeLessThan(1);
  });

  it('ne la marque pas quand l’ancre passe à plus de 30 m', () => {
    const mark = detectGatePass({
      // Même pénétrante, mais décalée de 50 m à l'est : la jambe longe l'autre
      // ancre sans jamais la traverser.
      polyline: nord(1_900, 50),
      gate: LOIN,
      gates: [LOIN, PROCHE],
      stop: at(0),
      direction: 'in',
    });
    expect(mark).toBeNull();
    expect(GATE_SITE_PROXIMITY_M).toBe(30);
  });

  it('ne traverse jamais une ancre PLUS LOIN que la sienne — la plus proche est la vraie porte', () => {
    const mark = detectGatePass({
      polyline: nord(900),
      gate: PROCHE,
      gates: [PROCHE, LOIN],
      stop: at(0),
      direction: 'in',
    });
    expect(mark).toBeNull();
  });

  it('rend la plus proche quand deux ancres sont traversées', () => {
    const mark = detectGatePass({
      polyline: nord(1_900),
      gates: [LOIN, gate('penetrante', 2, 1_200), gate('penetrante', 3, 600, 20)],
      gate: LOIN,
      stop: at(0),
      direction: 'in',
    });
    expect(mark?.gateId).toBe('penetrante@2');
  });
});

describe('le dégagement de 15 m au départ', () => {
  it('une ancre collée à la sienne n’est pas « traversée » : on en part', () => {
    const voisine = gate('penetrante', 5, 1_890);
    const mark = detectGatePass({
      polyline: nord(1_900),
      gate: LOIN,
      gates: [LOIN, voisine],
      stop: at(0),
      direction: 'in',
    });
    expect(mark).toBeNull();
    expect(GATE_DEPARTURE_CLEARANCE_M).toBe(15);
  });

  it('une sortante ne traverse pas non plus l’ancre collée au point de livraison', () => {
    const auPied = gate('locale', 180, 10);
    const mark = detectGatePass({
      polyline: [...nord(1_900)].reverse(),
      gate: LOIN,
      gates: [LOIN, auPied],
      stop: at(0),
      direction: 'out',
    });
    expect(mark).toBeNull();
  });
});

describe('la mesure se fait par arête, pas par sommet', () => {
  it('voit une ancre posée au milieu d’un segment de 800 m', () => {
    // Deux sommets seulement : un balayage sommet par sommet verrait 400 m.
    const polyline = [at(1_900), at(1_100), at(0)];
    const milieu = gate('penetrante', 7, 1_500, 5);
    const mark = detectGatePass({
      polyline,
      gate: LOIN,
      gates: [LOIN, milieu],
      stop: at(0),
      direction: 'in',
    });
    expect(mark?.gateId).toBe('penetrante@7');
    expect(mark?.distanceM).toBeLessThan(GATE_SITE_PROXIMITY_M);
  });
});

describe('les cas où il n’y a rien à dire', () => {
  it('une seule ancre retenue : aucune traversée possible', () => {
    expect(
      detectGatePass({ polyline: nord(1_900), gate: LOIN, gates: [LOIN], stop: at(0), direction: 'in' }),
    ).toBeNull();
  });

  it('une jambe d’un seul point ne traverse rien', () => {
    expect(
      detectGatePass({
        polyline: [at(1_900)],
        gate: LOIN,
        gates: [LOIN, PROCHE],
        stop: at(0),
        direction: 'in',
      }),
    ).toBeNull();
  });
});
