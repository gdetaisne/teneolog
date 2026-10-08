/**
 * les aires où un camion ne manœuvre pas, lues dans OSM (`overpass-non-drivable.ts`) :
 * la requête porte chaque étiquette de la liste (et `area=yes` là où elle compte), un chemin fermé
 * donne un anneau, un multipolygone ses contours extérieurs raboutés, le reste est laissé de côté.
 */
import { NON_DRIVABLE_AREA_TAGS } from '@teneolog/topology';
import { describe, expect, it } from 'vitest';

import type { OverpassPayload } from '../src/overpass-mapping.js';
import { mapNonDrivableAreas, nonDrivableQuery } from '../src/overpass-non-drivable.js';

const g = (lat: number, lon: number) => ({ lat, lon });

describe('la requête', () => {
  it('porte chaque clé de la liste, en chemin et en multipolygone ; highway piéton seulement en aire', () => {
    const query = nonDrivableQuery({ south: 48.89, west: 2.3, north: 48.9, east: 2.31 }, 25);
    for (const { key, values } of NON_DRIVABLE_AREA_TAGS) {
      expect(query).toContain(`way["${key}"~"^(${values.join('|')})$"]`);
      expect(query).toContain(`relation["${key}"~"^(${values.join('|')})$"]["type"="multipolygon"]`);
    }
    expect(query).toContain('way["highway"~"^(pedestrian|footway)$"]["area"="yes"](48.89,2.3,48.9,2.31);');
    expect(query).toContain('[timeout:25]');
    expect(query).toContain('out body geom;');
  });
});

describe('les anneaux', () => {
  it('un chemin fermé : un anneau, sans répéter le premier sommet ; un chemin ouvert : rien', () => {
    const payload: OverpassPayload = {
      elements: [
        { type: 'way', id: 1, geometry: [g(0, 0), g(0, 1), g(1, 1), g(0, 0)] },
        { type: 'way', id: 2, geometry: [g(0, 0), g(0, 1), g(1, 1)] },
      ],
    };
    expect(mapNonDrivableAreas(payload)).toEqual([[g(0, 0), g(0, 1), g(1, 1)]]);
  });

  it('un multipolygone : ses membres extérieurs raboutés (même à rebours), ses membres intérieurs laissés', () => {
    const payload: OverpassPayload = {
      elements: [
        {
          type: 'relation',
          id: 3,
          members: [
            { type: 'way', ref: 10, role: 'outer', geometry: [g(0, 0), g(0, 2)] },
            { type: 'way', ref: 11, role: 'outer', geometry: [g(2, 2), g(0, 2)] },
            { type: 'way', ref: 12, role: 'outer', geometry: [g(2, 2), g(2, 0), g(0, 0)] },
            { type: 'way', ref: 13, role: 'inner', geometry: [g(0.5, 0.5), g(0.5, 1), g(1, 1), g(0.5, 0.5)] },
            // Un membre qui ne se referme pas est laissé de côté.
            { type: 'way', ref: 14, role: 'outer', geometry: [g(5, 5), g(5, 6)] },
          ],
        },
      ],
    };
    expect(mapNonDrivableAreas(payload)).toEqual([[g(0, 0), g(0, 2), g(2, 2), g(2, 0)]]);
  });
});
