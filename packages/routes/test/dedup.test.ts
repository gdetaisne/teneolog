/**
 * le dédoublonnage des candidats R0, mesuré en mètres.
 *
 * Les fixtures sont des lignes droites construites en mètres autour d'un point :
 * un décalage de 5 m, de 1 m ou de 300 m se lit dans le test, pas dans des
 * décimales. Ce qui est vérifié ici est la RÈGLE PORTÉE DE L'ENGINE :
 *
 *  - même géométrie complète, à l'arrondi de 5 décimales près (~1,1 m) → un
 *    seul itinéraire ;
 *  - mêmes 500 derniers mètres (entrante) ou 500 premiers (sortante) → un seul
 *    itinéraire, sur la signature `approach`, celle qui n'écarte rien par
 *    défaut ;
 *  - une entrante et une sortante ne se comparent jamais.
 */
import { describe, expect, it } from 'vitest';
import type { GeoPoint } from '@teneolog/domain';

import {
  DEDUP_COORD_DECIMALS,
  dropsLeg,
  geometrySignature,
  markDuplicates,
  type DedupLeg,
} from '../src/dedup.js';

const O: GeoPoint = { lat: 47.0, lon: 1.0 };
const M_PER_DEG_LAT = 111_320;

function at(northM: number, eastM = 0): GeoPoint {
  return {
    lat: O.lat + northM / M_PER_DEG_LAT,
    lon: O.lon + eastM / (M_PER_DEG_LAT * Math.cos((O.lat * Math.PI) / 180)),
  };
}

/** Une droite du nord vers l'arrêt, un sommet tous les 100 m, décalée de `eastM`. */
function fromNorth(eastM = 0, lengthM = 2_000): readonly GeoPoint[] {
  const points: GeoPoint[] = [];
  for (let m = lengthM; m >= 0; m -= 100) points.push(at(m, eastM));
  return points;
}

/** Une droite de l'est vers l'arrêt — une tout autre approche. */
function fromEast(lengthM = 2_000): readonly GeoPoint[] {
  const points: GeoPoint[] = [];
  for (let m = lengthM; m >= 0; m -= 100) points.push(at(0, m));
  return points;
}

function leg(id: string, polyline: readonly GeoPoint[], direction: 'in' | 'out' = 'in'): DedupLeg {
  return { id, direction, polyline };
}

describe('la signature géométrique', () => {
  it('arrondit à 5 décimales, soit environ 1,1 m', () => {
    expect(DEDUP_COORD_DECIMALS).toBe(5);
    expect(geometrySignature([{ lat: 47.000001, lon: 1.037102 }])).toBe('47.00000,1.03710');
    expect(geometrySignature([{ lat: 47.000006, lon: 1.037102 }])).toBe('47.00001,1.03710');
  });

  it('sépare deux tracés dès qu’un sommet bouge de plus d’un arrondi', () => {
    expect(geometrySignature(fromNorth(0))).not.toBe(geometrySignature(fromNorth(5)));
  });
});

describe('deux candidats R0 qui sont le même itinéraire', () => {
  it('deux tracés identiques : le second est le doublon du premier, sur la géométrie', () => {
    const marks = markDuplicates([leg('a:in', fromNorth()), leg('b:in', fromNorth())]);
    expect(marks.get('b:in')).toEqual({ candidateId: 'a:in', on: 'geometry' });
    expect(marks.has('a:in')).toBe(false);
  });

  it('deux tracés écartés de 5 m : pas la même géométrie, mais la même approche', () => {
    const marks = markDuplicates([leg('a:in', fromNorth(0)), leg('b:in', fromNorth(5))]);
    expect(marks.get('b:in')).toEqual({ candidateId: 'a:in', on: 'approach' });
  });

  it('deux approches qui n’ont pas les mêmes rues sur les 500 derniers mètres : rien', () => {
    const marks = markDuplicates([leg('nord:in', fromNorth()), leg('est:in', fromEast())]);
    expect(marks.size).toBe(0);
  });

  it('un tracé identique jusqu’aux 500 derniers mètres, puis ailleurs : deux itinéraires', () => {
    // La jambe bis rejoint l'arrêt par l'est sur ses 600 derniers mètres :
    // l'amont est commun, la fin ne l'est pas — et c'est la fin qui décide.
    const detour: GeoPoint[] = [];
    for (let m = 2_000; m > 600; m -= 100) detour.push(at(m, 0));
    for (let m = 600; m >= 0; m -= 100) detour.push(at(0, m));
    const marks = markDuplicates([leg('a:in', fromNorth()), leg('b:in', detour)]);
    expect(marks.size).toBe(0);
  });

  it('une entrante et une sortante ne se comparent jamais, même tracé', () => {
    const marks = markDuplicates([leg('a:in', fromNorth(), 'in'), leg('a:out', fromNorth(), 'out')]);
    expect(marks.size).toBe(0);
  });

  it('une sortante se compare sur ses 500 PREMIERS mètres', () => {
    // Les deux quittent l'arrêt par les mêmes 800 m vers le nord, puis se
    // séparent : la fenêtre de sortie ne voit que le départ, donc une seule
    // sortie — mais pas sur la géométrie, qui diverge après.
    const commun: GeoPoint[] = [];
    for (let m = 0; m <= 800; m += 100) commun.push(at(m, 0));
    const droit = [...commun];
    for (let m = 900; m <= 1_600; m += 100) droit.push(at(m, 0));
    const coude = [...commun];
    for (let m = 100; m <= 800; m += 100) coude.push(at(800, m));
    const marks = markDuplicates([leg('a:out', droit, 'out'), leg('b:out', coude, 'out')]);
    expect(marks.get('b:out')).toEqual({ candidateId: 'a:out', on: 'approach' });
  });

  it('trois copies : toutes nomment la première, jamais la deuxième', () => {
    const marks = markDuplicates([
      leg('a:in', fromNorth()),
      leg('b:in', fromNorth()),
      leg('c:in', fromNorth()),
    ]);
    expect(marks.get('b:in')?.candidateId).toBe('a:in');
    expect(marks.get('c:in')?.candidateId).toBe('a:in');
  });

  it('une jambe d’un seul point n’est le doublon de personne', () => {
    const marks = markDuplicates([leg('a:in', fromNorth()), leg('court:in', [at(0)])]);
    expect(marks.has('court:in')).toBe(false);
  });
});

describe('ce que les drapeaux écartent', () => {
  const geometry = { candidateId: 'a:in', on: 'geometry' } as const;
  const approach = { candidateId: 'a:in', on: 'approach' } as const;

  it('baissés, rien n’est écarté — c’est la production', () => {
    expect(dropsLeg(geometry, { enabled: false, approach: false })).toBe(false);
    expect(dropsLeg(approach, { enabled: false, approach: false })).toBe(false);
    expect(dropsLeg(approach, { enabled: false, approach: true })).toBe(false);
  });

  it('`enabled` seul écarte le même tracé, pas la même fin', () => {
    expect(dropsLeg(geometry, { enabled: true, approach: false })).toBe(true);
    expect(dropsLeg(approach, { enabled: true, approach: false })).toBe(false);
  });

  it('`approach` levé écarte aussi les jambes qui ne se rejoignent que sur la fin', () => {
    expect(dropsLeg(approach, { enabled: true, approach: true })).toBe(true);
  });

  it('une jambe sans marque n’est jamais écartée', () => {
    expect(dropsLeg(undefined, { enabled: true, approach: true })).toBe(false);
  });
});
