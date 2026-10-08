/**
 * LE BRAS DE SORTIE, PIÈCE PAR PIÈCE.
 *
 * `exitWidth` recopiait `approachWidth` : un virage sortant d'une voie de 3 m
 * dans une rue de 5,2 m publiait 3 m deux fois, et la scène de revue
 * (`packages/scenes/src/scene.ts`, `outgoingWidthM`) dessinait deux bras de même
 * largeur quel que soit le carrefour. La lecture est maintenant faite au bout de
 * la manœuvre, sur la route CONDUITE — et « conduite » est le mot : la mesure
 * marche le long de la polyligne, dans le sens du camion, jamais à vol d'oiseau.
 *
 * Quatre fonctions décident où cette largeur est lue, et le test d'or du coin de
 * Thairé ne les traverse que par un cas chacune. Ce fichier les prend aux
 * bornes, là où un défaut se cache : un index avant le premier sommet, une
 * marche plus longue que la ligne, un index entre deux plages annotées (les
 * plages ne pavent PAS la ligne — le pas d'échantillonnage reste entre elles),
 * une liste de plages vide.
 *
 * Géométrie volontairement droite et métrique : une équerre de 100 m, dont on
 * sait lire les distances de tête. Ce qui est sous test est le REPÉRAGE, pas la
 * trigonométrie — `haversineM` a ses propres tests.
 */
import { describe, expect, it } from 'vitest';
import type { Fact, GeoPoint, RouteCandidate, RouteSegmentConstraint, Width } from '@teneolog/domain';

import {
  exitArmWidth,
  nearestIndex,
  segmentSpans,
  walkFrom,
  widthAtIndex,
} from '../src/route-points.js';

const O: GeoPoint = { lat: 46.0, lon: -1.0 };
const M = 111_320;

/** Un point à `northM` mètres au nord et `eastM` mètres à l'est de l'origine. */
function at(northM: number, eastM: number): GeoPoint {
  return {
    lat: O.lat + northM / M,
    lon: O.lon + eastM / (M * Math.cos((O.lat * Math.PI) / 180)),
  };
}

function width(freeM: number): Fact<Width> {
  return {
    known: true,
    value: { freeM, structuralM: freeM, measuredAt: O, offsetFromAnchorM: 0 },
    provenance: { source: 'bdtopo-postgis', method: 'declared-width-narrowest', fetchedAt: 'x' },
    reliability: { confidence: 0.55, basis: 'declared', reasonCodes: [] },
  };
}

function freeMOf(fact: Fact<Width>): number | null {
  return fact.known ? fact.value.freeM : null;
}

function segment(id: string, from: GeoPoint, to: GeoPoint, freeM: number): RouteSegmentConstraint {
  return {
    segmentId: id,
    from,
    to,
    position: 'approach',
    highway: 'residential',
    lengthM: 0,
    legal: {
      maxWeightT: { known: false, why: 'no_data' },
      maxHeightM: { known: false, why: 'no_data' },
      maxWidthM: { known: false, why: 'no_data' },
      maxLengthM: { known: false, why: 'no_data' },
      access: { known: false, why: 'no_data' },
      lowEmissionZone: { known: false, why: 'no_data' },
    },
    width: width(freeM),
  };
}

/**
 * L'équerre : 100 m plein est le long d'une voie ÉTROITE (3,0 m), puis 100 m
 * plein nord le long d'une rue LARGE (5,2 m). Le camion arrive par l'étroite et
 * repart par la large — la forme du coin de Thairé, réduite à ses os.
 */
const APEX = at(0, 100);
const LINE: readonly GeoPoint[] = [
  at(0, 0),
  at(0, 50),
  APEX,
  at(50, 100),
  at(100, 100),
];

function leg(line: readonly GeoPoint[] = LINE): RouteCandidate {
  return {
    id: 'equerre@0:in',
    direction: 'in',
    polyline: line,
    segments: [
      segment('approche', at(0, 0), at(0, 50), 3.0),
      segment('sortie', at(50, 100), at(100, 100), 5.2),
    ],
    generatedBy: 'gate',
    distanceM: 200,
    durationS: 30,
    coverage: { sampled: 10, matched: 10 },
    corridorReasonCodes: [],
    egressOf: null,
  } as unknown as RouteCandidate;
}

describe('nearestIndex — le sommet le plus proche, et les bornes', () => {
  it('trouve le sommet exact, quel que soit son rang', () => {
    expect(nearestIndex(LINE, at(0, 0))).toBe(0);
    expect(nearestIndex(LINE, APEX)).toBe(2);
    expect(nearestIndex(LINE, at(100, 100))).toBe(4);
  });

  it('avant le début et après la fin, les deux extrémités — jamais rien', () => {
    // Un point hors de la ligne n'est pas une absence : la lecture se rabat sur
    // le sommet le plus proche, qui est l'extrémité.
    expect(nearestIndex(LINE, at(0, -500))).toBe(0);
    expect(nearestIndex(LINE, at(500, 100))).toBe(4);
  });

  it('à égalité, le premier — l’ordre de la ligne est l’ordre de conduite', () => {
    // Pile entre les sommets 0 et 1 : la comparaison est stricte, donc le
    // premier rencontré gagne. Une règle arbitraire, mais FIXE : sans elle, un
    // apex à mi-chemin changerait de sommet d'une exécution à l'autre.
    expect(nearestIndex(LINE, at(0, 25))).toBe(0);
  });

  it('une ligne vide rend 0 — l’appelant a alors une plage vide, pas une erreur', () => {
    expect(nearestIndex([], O)).toBe(0);
  });
});

describe('walkFrom — marcher sur la route, pas à vol d’oiseau', () => {
  it('avance d’autant de sommets que la distance en demande', () => {
    // 60 m depuis le sommet 0 : le 1 est à 50 m, le 2 à 100 m. On s'arrête au 2,
    // le premier sommet AU-DELÀ de la distance — c'est ce que « lire 10 m après
    // la manœuvre » veut dire quand les sommets sont espacés.
    expect(walkFrom(LINE, 0, 60, 1)).toBe(2);
    expect(walkFrom(LINE, 0, 40, 1)).toBe(1);
  });

  it('recule quand le pas est négatif — le bras d’approche est le même calcul', () => {
    expect(walkFrom(LINE, 4, 60, -1)).toBe(2);
  });

  it('s’arrête au bout de la ligne plutôt que de sortir', () => {
    expect(walkFrom(LINE, 0, 100_000, 1)).toBe(4);
    expect(walkFrom(LINE, 4, 100_000, -1)).toBe(0);
  });

  it('une distance nulle ne bouge pas', () => {
    expect(walkFrom(LINE, 2, 0, 1)).toBe(2);
  });
});

describe('widthAtIndex — la plage qui couvre l’index, ou la plus proche', () => {
  const SPANS = segmentSpans(leg());

  it('dedans : la largeur de la plage', () => {
    expect(freeMOf(widthAtIndex(SPANS, 0))).toBe(3.0);
    expect(freeMOf(widthAtIndex(SPANS, 4))).toBe(5.2);
  });

  it('entre deux plages : la plus proche, parce que les plages ne pavent pas la ligne', () => {
    // Le sommet 2 (l'apex) n'appartient à aucune plage annotée — c'est le pas
    // d'échantillonnage de S3, ~25 % de la longueur sur le corpus. À égalité de
    // distance, la première l'emporte ; le sommet 3 penche vers la sortie.
    expect(freeMOf(widthAtIndex(SPANS, 2))).toBe(3.0);
    expect(freeMOf(widthAtIndex(SPANS, 3))).toBe(5.2);
  });

  it('aucune plage : inconnu, jamais une largeur par défaut', () => {
    const none = widthAtIndex([], 0);
    expect(none.known).toBe(false);
    expect(none.known === false && none.why).toBe('no_data');
  });
});

describe('segmentSpans — les tronçons annotés, posés sur la polyligne', () => {
  it('chaque tronçon devient une plage d’index, dans l’ordre de conduite', () => {
    expect(segmentSpans(leg()).map((s) => [s.from, s.to])).toEqual([
      [0, 1],
      [3, 4],
    ]);
  });

  it('garde la largeur du tronçon, sans la retoucher', () => {
    expect(segmentSpans(leg()).map((s) => freeMOf(s.width))).toEqual([3.0, 5.2]);
  });
});

describe('exitArmWidth — la rue où le camion DÉBOUCHE', () => {
  const TURN = {
    at: APEX,
    geometry: {
      known: true as const,
      value: {
        apex: APEX,
        kind: 'junction' as const,
        deflectionDeg: 90,
        approachBearingDeg: 90,
        exitBearingDeg: 0,
        arcLengthM: 20,
        radiusM: null,
        chainedWithPreviousM: null,
        approachWidth: width(3.0),
        exitWidth: width(3.0),
      },
      provenance: { source: 'osm-overpass' as const, method: 'turns', fetchedAt: 'x' },
      reliability: { confidence: 0.7, basis: 'derived' as const, reasonCodes: [] },
    },
  };

  it('sort de 3,0 m et lit 5,2 m — c’était 3,0 m des deux côtés', () => {
    // 10 m d'arc / 2 + 10 m de `bearingOffsetM` = 20 m après l'apex : le sommet
    // 3, dans la plage de sortie. C'est exactement là que le détecteur a lu le
    // cap de sortie qui définit l'angle, donc la même rue.
    const spans = segmentSpans(leg());
    expect(freeMOf(exitArmWidth(leg(), spans, TURN, 10))).toBe(5.2);
  });

  it('un virage au bout de la ligne lit la dernière plage, il n’invente rien', () => {
    // L'apex sur le dernier sommet : la marche ne peut plus avancer, `walkFrom`
    // rend le bout, et la largeur est celle de la plage qui s'y termine.
    const end = { ...TURN, at: at(100, 100) };
    const spans = segmentSpans(leg());
    expect(freeMOf(exitArmWidth(leg(), spans, end, 10))).toBe(5.2);
  });

  it('sans géométrie connue, la lecture se fait au décalage de cap seul', () => {
    // `arcLengthM` n'existe pas : la manœuvre vaut zéro mètre et on lit
    // `bearingOffsetM` après l'apex. 10 m depuis le sommet 2 mènent au 3.
    const blind = { at: APEX, geometry: { known: false as const, why: 'no_data' as const } };
    const spans = segmentSpans(leg());
    expect(freeMOf(exitArmWidth(leg(), spans, blind, 10))).toBe(5.2);
  });

  it('une jambe sans tronçon annoté rend inconnu, jamais zéro', () => {
    const bare = { ...leg(), segments: [] } as unknown as RouteCandidate;
    expect(exitArmWidth(bare, segmentSpans(bare), TURN, 10).known).toBe(false);
  });
});
