/**
 * The BUG-087 family, as unit facts. Every fixture is the field situation the
 * engine got wrong: a limit in one source and not the other, sources
 * disagreeing, "sauf desserte locale", and private-is-not-forbidden.
 */
import { describe, expect, it } from 'vitest';
import type { RoadWay } from '@teneolog/topology';

import { mergeLegalBands } from '../src/legal-bands.js';
import { assembleStopConstraints } from '../src/stop-constraints.js';

function way(source: RoadWay['source'], overrides: Partial<RoadWay> = {}): RoadWay {
  return {
    id: `${source}-1`,
    source,
    nodeIds: ['a', 'b'],
    geometry: [
      { lat: 48.0, lon: 2.0 },
      { lat: 48.001, lon: 2.0 },
    ],
    name: null,
    importance: null,
    declaredWidthM: null,
    laneCount: null,
    oneWay: 'no',
    isPrivate: false,
    limits: { maxWeightT: null, maxHeightM: null, maxWidthM: null, maxLengthM: null },
    tags: {},
    ...overrides,
  };
}

const AT = '2026-08-24T00:00:00Z';

describe('mergeLegalBands', () => {
  it('BUG-087: a weight limit present in OSM and absent from BDTOPO reaches the band', () => {
    const bdtopo = way('bdtopo-postgis');
    const osm = way('osm-overpass', {
      limits: { maxWeightT: 7.5, maxHeightM: null, maxWidthM: null, maxLengthM: null },
    });

    const bands = mergeLegalBands({ descriptions: [bdtopo, osm], fetchedAt: AT });

    expect(bands.maxWeightT.known).toBe(true);
    if (!bands.maxWeightT.known) return;
    expect(bands.maxWeightT.value.value).toBe(7.5);
    expect(bands.maxWeightT.value.sources).toEqual(['osm-overpass']);
  });

  it('disagreeing sources: the smallest wins and the disagreement stays visible', () => {
    const bdtopo = way('bdtopo-postgis', {
      limits: { maxWeightT: 19, maxHeightM: null, maxWidthM: null, maxLengthM: null },
    });
    const osm = way('osm-overpass', {
      limits: { maxWeightT: 7.5, maxHeightM: null, maxWidthM: null, maxLengthM: null },
    });

    const bands = mergeLegalBands({ descriptions: [bdtopo, osm], fetchedAt: AT });

    expect(bands.maxWeightT.known).toBe(true);
    if (!bands.maxWeightT.known) return;
    expect(bands.maxWeightT.value.value).toBe(7.5);
    expect(bands.maxWeightT.value.statedValues).toHaveLength(2);
    expect(bands.maxWeightT.reliability.reasonCodes).toContain('legal_limit_sources_disagree');
  });

  it('silence from every source is unknown, never "no limit"', () => {
    const bands = mergeLegalBands({ descriptions: [way('bdtopo-postgis')], fetchedAt: AT });
    expect(bands.maxWeightT.known).toBe(false);
  });

  it('E1: access=destination is conditional — sauf desserte locale, position judged later', () => {
    const osm = way('osm-overpass', { tags: { access: 'destination' } });

    const bands = mergeLegalBands({ descriptions: [osm], fetchedAt: AT });

    expect(bands.access.known).toBe(true);
    if (!bands.access.known) return;
    expect(bands.access.value.kind).toBe('conditional');
    if (bands.access.value.kind !== 'conditional') return;
    expect(bands.access.value.permits).toContain('destination');
  });

  it('hgv=no bars heavy goods only; access=no bars everyone', () => {
    const hgvOnly = mergeLegalBands({ descriptions: [way('osm-overpass', { tags: { hgv: 'no' } })], fetchedAt: AT });
    expect(hgvOnly.access.known && hgvOnly.access.value.kind === 'forbidden' && hgvOnly.access.value.appliesTo).toBe('hgv');

    const all = mergeLegalBands({ descriptions: [way('osm-overpass', { tags: { access: 'no' } })], fetchedAt: AT });
    expect(all.access.known && all.access.value.kind === 'forbidden' && all.access.value.appliesTo).toBe('all');
  });

  it('M8e: access=private is neither forbidden nor conditional — a commissioned delivery is the permitted case', () => {
    const bands = mergeLegalBands({
      descriptions: [way('osm-overpass', { tags: { access: 'private' }, isPrivate: true })],
      fetchedAt: AT,
    });
    expect(bands.access.known && bands.access.value.kind).toBe('open');
  });

  it('the strictest source speaks: OSM conditional does not soften a BDTOPO-described street, and vice versa', () => {
    const bdtopo = way('bdtopo-postgis');
    const osm = way('osm-overpass', { tags: { hgv: 'destination' } });

    const bands = mergeLegalBands({ descriptions: [bdtopo, osm], fetchedAt: AT });
    expect(bands.access.known && bands.access.value.kind).toBe('conditional');
  });

  it('LEZ is an honest unknown until an adapter feeds it — the difference is a fine', () => {
    const bands = mergeLegalBands({ descriptions: [way('osm-overpass')], fetchedAt: AT });
    expect(bands.lowEmissionZone.known).toBe(false);
  });
});

describe('mergeAccess — empty descriptions', () => {
  it('empty descriptions → access is known: false, not a fabricated open', () => {
    const bands = mergeLegalBands({ descriptions: [], fetchedAt: AT });
    expect(bands.access.known).toBe(false);
    if (bands.access.known) return; // type narrowing only
    expect(bands.access.why).toBe('no_data');
  });

  it('single description with no access tags → open (source present, no restriction stated)', () => {
    const bands = mergeLegalBands({ descriptions: [way('osm-overpass')], fetchedAt: AT });
    expect(bands.access.known).toBe(true);
    if (!bands.access.known) return;
    expect(bands.access.value.kind).toBe('open');
  });

  it('empty descriptions: all limits are also unknown (consistent no_data)', () => {
    const bands = mergeLegalBands({ descriptions: [], fetchedAt: AT });
    expect(bands.maxWeightT.known).toBe(false);
    expect(bands.maxHeightM.known).toBe(false);
    expect(bands.maxWidthM.known).toBe(false);
    expect(bands.maxLengthM.known).toBe(false);
    expect(bands.access.known).toBe(false);
  });
});

describe('assembleStopConstraints', () => {
  it('the narrowest declared width wins and the disagreement is coded', () => {
    const bdtopo = way('bdtopo-postgis', { declaredWidthM: 5 });
    const osm = way('osm-overpass', { declaredWidthM: 4.2 });

    const stop = assembleStopConstraints({
      at: { lat: 48.0005, lon: 2.0 },
      descriptions: [bdtopo, osm],
      fetchedAt: AT,
      declaredWidthConfidence: 0.55,
    });

    expect(stop.width.known).toBe(true);
    if (!stop.width.known) return;
    expect(stop.width.value.freeM).toBe(4.2);
    expect(stop.width.reliability.basis).toBe('declared');
    expect(stop.width.reliability.reasonCodes).toContain('declared_width_sources_disagree');
  });

  it('nothing declared a width: unknown, with slope and surface honest too', () => {
    const stop = assembleStopConstraints({
      at: { lat: 48.0005, lon: 2.0 },
      descriptions: [way('bdtopo-postgis')],
      fetchedAt: AT,
      declaredWidthConfidence: 0.55,
    });

    expect(stop.width.known).toBe(false);
    expect(stop.slopePct.known).toBe(false);
    expect(stop.surface.known).toBe(false);
  });
});

describe('width evidence preference', () => {
  const measured = (freeM: number, confidence: number) => ({
    known: true as const,
    value: { freeM, structuralM: freeM, measuredAt: { lat: 48, lon: 2 }, offsetFromAnchorM: 0 },
    provenance: { source: 'ign-ortho' as const, method: 'd10-stitched', fetchedAt: AT },
    reliability: { confidence, basis: 'measured' as const, reasonCodes: [] },
  });

  it('a confident measurement outranks the declared attribute', () => {
    const stop = assembleStopConstraints({
      at: { lat: 48.0005, lon: 2.0 },
      descriptions: [way('bdtopo-postgis', { declaredWidthM: 5 })],
      fetchedAt: AT,
      declaredWidthConfidence: 0.55,
      measuredWidth: measured(4.6, 0.7),
    });
    expect(stop.width.known && stop.width.value.freeM).toBe(4.6);
  });

  it('Auxerre-spur posture: a doubtful measurement does not displace a solid declared width', () => {
    const stop = assembleStopConstraints({
      at: { lat: 48.0005, lon: 2.0 },
      descriptions: [way('bdtopo-postgis', { declaredWidthM: 5 })],
      fetchedAt: AT,
      declaredWidthConfidence: 0.55,
      measuredWidth: measured(22.3, 0.4),
    });
    expect(stop.width.known && stop.width.value.freeM).toBe(5);
    expect(stop.width.known && stop.width.reliability.basis).toBe('declared');
  });

  it('doubtful beats silent: with nothing declared, a low-confidence measurement still publishes', () => {
    const stop = assembleStopConstraints({
      at: { lat: 48.0005, lon: 2.0 },
      descriptions: [way('osm-overpass')],
      fetchedAt: AT,
      declaredWidthConfidence: 0.55,
      measuredWidth: measured(22.3, 0.4),
    });
    expect(stop.width.known && stop.width.value.freeM).toBe(22.3);
  });

  it('a failed measurement never deletes the declared evidence', () => {
    const stop = assembleStopConstraints({
      at: { lat: 48.0005, lon: 2.0 },
      descriptions: [way('bdtopo-postgis', { declaredWidthM: 5 })],
      fetchedAt: AT,
      declaredWidthConfidence: 0.55,
      measuredWidth: { known: false, why: 'provider_error' },
    });
    expect(stop.width.known && stop.width.value.freeM).toBe(5);
  });
});
