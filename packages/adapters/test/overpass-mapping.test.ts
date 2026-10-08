/**
 * Mapping tested on a REAL captured payload — 80 m around the Clamart BUG-037
 * address, fetched live from overpass.openstreetmap.fr on 2026-08-24. What the
 * fixture proves is field truth, not fixture convenience: Rue Paul
 * du Prototype really is tagged `highway=pedestrian` there.
 */
import { describe, expect, it } from 'vitest';

import { mapRoadNeighbourhood, type OverpassPayload } from '../src/overpass-mapping.js';
import clamartRaw from './fixtures/overpass-clamart-80m.json' with { type: 'json' };

const CLAMART = { lat: 48.80236, lon: 2.30104 };
const payload = clamartRaw as OverpassPayload;

describe('mapRoadNeighbourhood on the captured Clamart payload', () => {
  const hood = mapRoadNeighbourhood(payload, CLAMART, 80);

  it('carries every aligned way and drops none silently', () => {
    const rawWays = payload.elements.filter(
      (e) => e.type === 'way' && e.nodes !== undefined && e.geometry !== undefined,
    );
    expect(hood.ways.length).toBe(rawWays.length);
  });

  it('BUG-037b field truth: the delivery street is tagged pedestrian and must survive as a way', () => {
    const pvc = hood.ways.find((w) => w.name === 'Rue du Prototype');
    expect(pvc).toBeDefined();
    expect(pvc?.tags['highway']).toBe('pedestrian');
  });

  it('node degree is computed from the returned ways', () => {
    const junctions = hood.nodes.filter((n) => n.wayIds.length >= 2);
    expect(junctions.length).toBeGreaterThan(0);
    for (const j of junctions) {
      for (const wayId of j.wayIds) {
        expect(hood.ways.some((w) => w.id === wayId)).toBe(true);
      }
    }
  });

  it('geometry and node lists stay parallel on every mapped way', () => {
    for (const w of hood.ways) {
      expect(w.geometry.length).toBe(w.nodeIds.length);
    }
  });
});

describe('tag parsing rules', () => {
  const mini = (tags: Record<string, string>): OverpassPayload => ({
    elements: [
      {
        type: 'way',
        id: 1,
        tags,
        nodes: [10, 11],
        geometry: [
          { lat: 48.0, lon: 2.0 },
          { lat: 48.001, lon: 2.0 },
        ],
      },
    ],
  });
  const wayOf = (tags: Record<string, string>) =>
    mapRoadNeighbourhood(mini(tags), { lat: 48.0, lon: 2.0 }, 50).ways[0];

  it('keeps the smallest weight limit across tag spellings', () => {
    const w = wayOf({ maxweight: '19', 'maxweight:hgv': '7.5', highway: 'residential' });
    expect(w?.limits.maxWeightT).toBe(7.5);
  });

  it('a non-numeric limit is no reading, never zero', () => {
    const w = wayOf({ maxweight: 'default', highway: 'residential' });
    expect(w?.limits.maxWeightT).toBeNull();
  });

  it('French decimal commas parse', () => {
    const w = wayOf({ maxheight: '3,5', highway: 'residential' });
    expect(w?.limits.maxHeightM).toBe(3.5);
  });

  it('an unstated oneway on a roundabout ring is forward — the OSM convention', () => {
    const w = wayOf({ junction: 'roundabout', highway: 'primary' });
    expect(w?.oneWay).toBe('forward');
  });

  it('oneway=-1 is backward', () => {
    const w = wayOf({ oneway: '-1', highway: 'residential' });
    expect(w?.oneWay).toBe('backward');
  });

  it('access=private is recorded, not filtered', () => {
    const w = wayOf({ access: 'private', highway: 'service' });
    expect(w).toBeDefined();
    expect(w?.isPrivate).toBe(true);
  });

  it('a way with misaligned geometry is dropped whole, not shifted', () => {
    const broken: OverpassPayload = {
      elements: [
        { type: 'way', id: 2, tags: { highway: 'residential' }, nodes: [1, 2, 3], geometry: [{ lat: 48, lon: 2 }, { lat: 48.001, lon: 2 }] },
      ],
    };
    const hood = mapRoadNeighbourhood(broken, { lat: 48, lon: 2 }, 50);
    expect(hood.ways).toHaveLength(0);
  });
});
