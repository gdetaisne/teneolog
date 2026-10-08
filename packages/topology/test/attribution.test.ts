/**
 * The graft, case by case. Each test names the way it could go wrong.
 *
 * The geometry is drawn in metres from an origin near Thairé (17290), the
 * village the measurements in `attribution.ts` come from, so a failing case
 * can be looked at on a map.
 */
import { describe, expect, it } from 'vitest';

import {
  circleExtent,
  corridorExtent,
  graftDeclaredWidth,
  type GraftOptions,
} from '../src/attribution.js';
import { at, way } from './fixtures.js';

const O = { lat: 46.0735, lon: -0.9654 };

/**
 * The production tolerances, measured on 2026-09-10 over Thairé and Paris 11e
 * (2 220 and 5 973 matched samples): the lateral gap between the OSM axis and
 * the BD TOPO axis has a median of 0,7 m / 0,5 m and a p90 of 2,0 m / 1,7 m.
 * Five metres is two and a half times that p90, and the recall curve is flat
 * from three metres to ten — so the extra reach buys nothing and only widens
 * the chance of catching the street next door.
 */
const OPTS: GraftOptions = {
  sampleStepM: 10,
  lateralToleranceM: 5,
  bearingToleranceDeg: 25,
  minCoverage: 0.6,
};

/** A north–south street through the origin, `lengthM` long, `eastM` to the side. */
function northSouth(
  id: string,
  lengthM: number,
  eastM: number,
  overrides: Parameters<typeof way>[3] = {},
) {
  return way(
    id,
    [`${id}:a`, `${id}:b`],
    [at(O, -lengthM / 2, eastM), at(O, lengthM / 2, eastM)],
    { tags: { highway: 'residential' }, ...overrides },
  );
}

describe('graftDeclaredWidth', () => {
  it('grafts the donor width and says where it came from', () => {
    const osm = northSouth('street', 120, 0);
    const donor = northSouth('TRONROUT042', 120, 2, {
      source: 'bdtopo-postgis',
      declaredWidthM: 5.2,
    });

    const [out] = graftDeclaredWidth([osm], [donor], OPTS);

    expect(out?.declaredWidthM).toBe(5.2);
    expect(out?.attributed?.declaredWidthM?.source).toBe('bdtopo-postgis');
    expect(out?.attributed?.declaredWidthM?.donorWayId).toBe('TRONROUT042');
    expect(out?.attributed?.declaredWidthM?.coverage).toBeGreaterThanOrEqual(0.9);
    expect(out?.attributed?.declaredWidthM?.offsetM).toBeGreaterThan(1.5);
    expect(out?.attributed?.declaredWidthM?.offsetM).toBeLessThan(2.5);
  });

  it('leaves the graph alone: the way keeps its id, its source and its tags', () => {
    // The whole posture of the change. OSM draws the road; only the missing
    // attribute is borrowed. A graft that renamed the way, or restamped its
    // source, would take the street furniture and the access tags with it.
    const osm = northSouth('street', 120, 0, { name: 'Rue de l’Exemple' });
    const donor = northSouth('TRONROUT042', 120, 2, {
      source: 'bdtopo-postgis',
      declaredWidthM: 5.2,
    });

    const [out] = graftDeclaredWidth([osm], [donor], OPTS);

    expect(out?.id).toBe('street');
    expect(out?.source).toBe('osm-overpass');
    expect(out?.name).toBe('Rue de l’Exemple');
    expect(out?.nodeIds).toEqual(osm.nodeIds);
    expect(out?.tags).toEqual(osm.tags);
  });

  it('never overrides a width the way already states', () => {
    // Borrowing is for silence, not for arbitration. Deciding between two
    // stated widths is a different question and this is not the place for it.
    const osm = northSouth('street', 120, 0, { declaredWidthM: 6 });
    const donor = northSouth('TRONROUT042', 120, 2, {
      source: 'bdtopo-postgis',
      declaredWidthM: 3,
    });

    const [out] = graftDeclaredWidth([osm], [donor], OPTS);

    expect(out?.declaredWidthM).toBe(6);
    expect(out?.attributed).toBeUndefined();
  });

  it('sees a donor drawn with two vertices 120 m apart', () => {
    // THE REASON THIS MODULE PROJECTS. A sample at mid-street is 60 m from the
    // nearest donor VERTEX and 2 m from the donor AXIS. `nearestWay` in
    // packages/pipeline/src/analyse.ts:410 measures to vertices and would
    // reject this at any sane tolerance — and this is the ordinary shape of a
    // straight village street.
    const osm = northSouth('street', 120, 0);
    const donor = northSouth('TRONROUT042', 120, 2, {
      source: 'bdtopo-postgis',
      declaredWidthM: 5.2,
    });
    expect(donor.geometry).toHaveLength(2);

    const [out] = graftDeclaredWidth([osm], [donor], OPTS);

    expect(out?.declaredWidthM).toBe(5.2);
  });

  it('refuses the perpendicular street that crosses at zero metres', () => {
    // A point snap cannot tell this from a match: the crossing street passes
    // through the sample exactly. Only the heading filter separates them.
    const osm = northSouth('street', 120, 0);
    const crossing = way(
      'TRONROUT099',
      ['x:a', 'x:b'],
      [at(O, 0, -60), at(O, 0, 60)],
      { source: 'bdtopo-postgis', declaredWidthM: 3, tags: { highway: 'residential' } },
    );

    const [out] = graftDeclaredWidth([osm], [crossing], OPTS);

    expect(out?.declaredWidthM).toBeNull();
    expect(out?.attributed).toBeUndefined();
  });

  it('accepts a parallel donor at 3 m and refuses one at 9 m', () => {
    // Brackets the 5 m tolerance from both sides, so moving it breaks a test
    // instead of passing unnoticed. 9 m is the service alley behind the
    // frontage — parallel, plausible, and the wrong road.
    const osm = northSouth('street', 120, 0);
    const near = northSouth('TRONROUT-near', 120, 3, {
      source: 'bdtopo-postgis',
      declaredWidthM: 5.2,
    });
    const far = northSouth('TRONROUT-far', 120, 9, {
      source: 'bdtopo-postgis',
      declaredWidthM: 3,
    });

    expect(graftDeclaredWidth([osm], [near], OPTS)[0]?.declaredWidthM).toBe(5.2);
    expect(graftDeclaredWidth([osm], [far], OPTS)[0]?.declaredWidthM).toBeNull();
  });

  it('takes the narrowest when the donor network is cut into stretches', () => {
    // The BD TOPO cuts at every junction and every attribute change, so one
    // OSM street routinely matches several stretches. Narrowest wins — the
    // same rule the domain already applies to a ring width and to a merged
    // legal limit, and the only direction that is safe for a lorry.
    const osm = northSouth('street', 120, 0);
    const donors = [
      way('T-north', ['n:a', 'n:b'], [at(O, 20, 2), at(O, 60, 2)], {
        source: 'bdtopo-postgis',
        declaredWidthM: 5.5,
        tags: { highway: 'residential' },
      }),
      way('T-middle', ['m:a', 'm:b'], [at(O, -20, 2), at(O, 20, 2)], {
        source: 'bdtopo-postgis',
        declaredWidthM: 4,
        tags: { highway: 'residential' },
      }),
      way('T-south', ['s:a', 's:b'], [at(O, -60, 2), at(O, -20, 2)], {
        source: 'bdtopo-postgis',
        declaredWidthM: 5.5,
        tags: { highway: 'residential' },
      }),
    ];

    const [out] = graftDeclaredWidth([osm], donors, OPTS);

    expect(out?.declaredWidthM).toBe(4);
    expect(out?.attributed?.declaredWidthM?.donorWayId).toBe('T-middle');
  });

  it('stays silent when the donor only covers a quarter of the way', () => {
    // A partial match is a silence, not a weak value. A width that is probably
    // the next street along is worse than no width: the rest of the engine has
    // no way to argue with it.
    const osm = northSouth('street', 200, 0);
    const stub = way('T-stub', ['t:a', 't:b'], [at(O, -100, 2), at(O, -75, 2)], {
      source: 'bdtopo-postgis',
      declaredWidthM: 3,
      tags: { highway: 'residential' },
    });

    const [out] = graftDeclaredWidth([osm], [stub], OPTS);

    expect(out?.declaredWidthM).toBeNull();
    expect(out?.attributed).toBeUndefined();
  });

  it('does not graft onto a footway', () => {
    // Same reason `annotateRoute` filters its corridor: a pavement running a
    // metre from the carriageway would otherwise take a lorry's width off it.
    const pavement = northSouth('foot', 120, 1, { tags: { highway: 'footway' } });
    const donor = northSouth('TRONROUT042', 120, 2, {
      source: 'bdtopo-postgis',
      declaredWidthM: 5.2,
    });

    const [out] = graftDeclaredWidth([pavement], [donor], OPTS);

    expect(out?.declaredWidthM).toBeNull();
  });

  it('returns the very same array when there is nothing to graft', () => {
    // The degradation contract, expressed as identity: a dead donor source
    // must cost the caller nothing at all, not even a copy.
    const osm = northSouth('street', 120, 0);
    const ways = [osm];

    expect(graftDeclaredWidth(ways, [], OPTS)).toBe(ways);
    expect(graftDeclaredWidth(ways, [northSouth('T', 120, 2, { source: 'bdtopo-postgis' })], OPTS)).toBe(ways);
  });

  it('matches a street the two sources drew in opposite directions', () => {
    // The BD TOPO carries a "Sens inverse" value precisely because digitising
    // order is arbitrary. Without folding the heading into [0, 90], about half
    // of all streets would be rejected at 180°.
    const osm = northSouth('street', 120, 0);
    const reversed = way(
      'TRONROUT042',
      ['r:a', 'r:b'],
      [at(O, 60, 2), at(O, -60, 2)],
      { source: 'bdtopo-postgis', declaredWidthM: 5.2, tags: { highway: 'residential' } },
    );

    const [out] = graftDeclaredWidth([osm], [reversed], OPTS);

    expect(out?.declaredWidthM).toBe(5.2);
  });

  describe('judged only where the donor was asked', () => {
    // Overpass `around` returns a way whole as soon as one node touches the
    // circle; the BD TOPO is asked inside the circle only. Thairé, 160 m,
    // 2026-09-10: Rue Voisine 17 has 11 % of its vertices inside and stayed
    // mute for it, with 4,8 m waiting in the BD TOPO.
    const inside80 = circleExtent(O, 80);
    const tertiary = { tags: { highway: 'tertiary' } };

    it('grafts a long street that enters the neighbourhood by one end', () => {
      // 600 m of street, 80 m of it in view, and the donor covers those 80 m.
      const osm = way('long', ['l:a', 'l:b'], [at(O, -520, 0), at(O, 80, 0)], tertiary);
      const donor = way('T', ['t:a', 't:b'], [at(O, -100, 2), at(O, 100, 2)], {
        ...tertiary,
        source: 'bdtopo-postgis',
        declaredWidthM: 4.8,
      });

      // Judged whole, 17 of 61 samples can be answered: mute. That is the bug.
      expect(graftDeclaredWidth([osm], [donor], OPTS)[0]?.declaredWidthM).toBeNull();

      const [out] = graftDeclaredWidth([osm], [donor], OPTS, inside80);
      expect(out?.declaredWidthM).toBe(4.8);
      expect(out?.attributed?.declaredWidthM?.coverage).toBeGreaterThanOrEqual(0.9);
    });

    it('judges whole a street that merely clips the circle', () => {
      // 600 m of street, 15 m of it in view: two samples are not a majority,
      // and one of them may well sit on the junction. So the way is judged as
      // it was before the extent existed — whole. A donor that runs the whole
      // length still wins; one that stops at 100 m still loses.
      const osm = way('clip', ['c:a', 'c:b'], [at(O, 65, 0), at(O, 665, 0)], tertiary);
      const whole = way('T-whole', ['t:a', 't:b'], [at(O, 0, 2), at(O, 700, 2)], {
        ...tertiary,
        source: 'bdtopo-postgis',
        declaredWidthM: 4.8,
      });
      const short = way('T-short', ['u:a', 'u:b'], [at(O, 0, 2), at(O, 100, 2)], {
        ...tertiary,
        source: 'bdtopo-postgis',
        declaredWidthM: 4.8,
      });

      expect(graftDeclaredWidth([osm], [whole], OPTS, inside80)[0]?.declaredWidthM).toBe(4.8);
      const [out] = graftDeclaredWidth([osm], [short], OPTS, inside80);
      expect(out?.declaredWidthM).toBeNull();
      expect(out?.attributed).toBeUndefined();
    });

    it('bounds a corridor by its margin, through the index', () => {
      // A route heading north through the origin, 30 m of margin either side.
      const route = [at(O, -500, 0), at(O, 0, 0), at(O, 500, 0)];
      const within = corridorExtent(route, 30);

      expect(within(at(O, 100, 25))).toBe(true);
      expect(within(at(O, 100, -25))).toBe(true);
      expect(within(at(O, 100, 35))).toBe(false);
      expect(within(at(O, 540, 0))).toBe(false);
      expect(corridorExtent([at(O, 0, 0)], 30)(at(O, 0, 0))).toBe(false);
    });

    it('keeps a short stub that lies entirely in view', () => {
      // A 12 m service stub has two steps in total, both in view. Its own
      // length is its say; the floor is for ways cut by the circle, not short ones.
      const osm = way('stub', ['s:a', 's:b'], [at(O, -6, 0), at(O, 6, 0)], {
        tags: { highway: 'service' },
      });
      const donor = way('T', ['t:a', 't:b'], [at(O, -50, 2), at(O, 50, 2)], {
        tags: { highway: 'service' },
        source: 'bdtopo-postgis',
        declaredWidthM: 3,
      });

      expect(graftDeclaredWidth([osm], [donor], OPTS, inside80)[0]?.declaredWidthM).toBe(3);
    });
  });
});
