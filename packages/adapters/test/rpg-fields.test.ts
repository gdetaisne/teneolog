/**
 * le champ RPG le plus proche : la distance au polygone, les trois
 * issues (un champ, aucun dans le rayon, une inconnue nommée) et la coupe.
 * Aucun réseau : la lecture du corps GeoJSON est pure.
 */
import { describe, expect, it } from 'vitest';

import { readNearestField, RPG_LAYER } from '../src/rpg-fields.js';

const O = { lat: 46.37, lon: -0.29 };
const M = 111_320;
const K = M * Math.cos((O.lat * Math.PI) / 180);
/** Un carré de `sizeM` dont le coin sud-ouest est à (east, north) mètres de O, en lon/lat GeoJSON. */
function square(east: number, north: number, sizeM: number): number[][] {
  const p = (e: number, n: number) => [O.lon + e / K, O.lat + n / M];
  return [p(east, north), p(east + sizeM, north), p(east + sizeM, north + sizeM), p(east, north + sizeM), p(east, north)];
}
function body(features: { coordinates: number[][]; code?: string; type?: string }[]): string {
  return JSON.stringify({
    type: 'FeatureCollection',
    features: features.map((f) => ({
      type: 'Feature',
      geometry: f.type === 'Polygon' ? { type: 'Polygon', coordinates: [f.coordinates] } : { type: 'MultiPolygon', coordinates: [[f.coordinates]] },
      properties: { code_cultu: f.code ?? 'BTH' },
    })),
  });
}
const OPTS = { radiusM: 300, limit: 10 };

describe('readNearestField', () => {
  it('le point dans un champ : 0 m, avec le code culture', () => {
    const r = readNearestField(body([{ coordinates: square(-20, -20, 40), code: 'PPH' }]), O, OPTS, 700);
    expect(r).toEqual({
      known: true,
      value: { nearestM: 0, cultureCode: 'PPH', fieldsRead: 1, radiusM: 300, truncated: false, layer: RPG_LAYER, fetchMs: 700 },
    });
  });

  it('le plus proche des champs lus, mesuré au bord (Polygon ou MultiPolygon)', () => {
    const r = readNearestField(
      body([{ coordinates: square(200, -10, 20), code: 'MIS' }, { coordinates: square(80, -10, 20), code: 'BTH', type: 'Polygon' }]),
      O,
      OPTS,
      1,
    );
    expect(r.known && r.value.nearestM).toBeCloseTo(80, 0);
    expect(r.known && r.value.cultureCode).toBe('BTH');
  });

  it('un champ lu au-delà du rayon : « lu, aucun » — pas une inconnue', () => {
    const r = readNearestField(body([{ coordinates: square(350, 0, 20) }]), O, OPTS, 1);
    expect(r).toMatchObject({ known: true, value: { nearestM: null, cultureCode: null, fieldsRead: 1 } });
  });

  it('aucun champ du tout : lu, aucun', () => {
    expect(readNearestField(body([]), O, OPTS, 1)).toMatchObject({ known: true, value: { nearestM: null, fieldsRead: 0 } });
  });

  it('coupée sans champ dans le rayon : une inconnue — un champ non lu pourrait y être', () => {
    const far = Array.from({ length: 11 }, () => ({ coordinates: square(400, 0, 10) }));
    expect(readNearestField(body(far), O, OPTS, 1)).toEqual({ known: false, why: 'truncated', fetchMs: 1 });
  });

  it('coupée avec un champ dans le rayon : il existe, et la coupe est dite', () => {
    const many = [{ coordinates: square(50, 0, 10) }, ...Array.from({ length: 10 }, () => ({ coordinates: square(400, 0, 10) }))];
    expect(readNearestField(body(many), O, OPTS, 1)).toMatchObject({ known: true, value: { truncated: true, fieldsRead: 10 } });
  });

  it('un corps illisible est une inconnue nommée', () => {
    expect(readNearestField('<html>', O, OPTS, 3)).toEqual({ known: false, why: 'malformed', fetchMs: 3 });
    expect(readNearestField('{"type":"x"}', O, OPTS, 3)).toEqual({ known: false, why: 'malformed', fetchMs: 3 });
  });
});
