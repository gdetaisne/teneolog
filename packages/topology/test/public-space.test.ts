/**
 * l'espace public d'une vue du ciel (`public-space.ts`) : dans le
 * cadre, ce que ne couvre aucune parcelle, moins le bâti, relié au trajet du
 * camion, coupé aux liens fermés aux véhicules. Même cœur que le bout de
 * l'impasse (`open-space-served.ts`) : ces cas prouvent la zone (le cadre) et
 * les graines (le trajet), et que la coupe s'y applique.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import type { GeoPoint } from '@teneolog/domain';

import { computePublicSpace, type PublicSpaceInput } from '../src/public-space.js';
import type { OpenSpaceLinks, OpenSpaceParcel } from '../src/open-space.js';

const M = (6_371_008.8 * Math.PI) / 180;
const O: GeoPoint = { lat: 47.0, lon: -0.98 };
const K = M * Math.cos((O.lat * Math.PI) / 180);
const at = (x: number, y: number): GeoPoint => ({ lat: O.lat + y / M, lon: O.lon + x / K });
const xyOf = (p: GeoPoint): readonly [number, number] => [(p.lon - O.lon) * K, (p.lat - O.lat) * M];
const rect = (x0: number, y0: number, x1: number, y1: number): GeoPoint[] => [
  at(x0, y0),
  at(x1, y0),
  at(x1, y1),
  at(x0, y1),
];
const boxOf = (x0: number, y0: number, x1: number, y1: number) => ({
  south: at(0, y0).lat,
  west: at(x0, 0).lon,
  north: at(0, y1).lat,
  east: at(x1, 0).lon,
});

function covers(rings: readonly (readonly GeoPoint[])[], p: GeoPoint): boolean {
  const [x, y] = xyOf(p);
  let inside = false;
  for (const ring of rings) {
    const pts = ring.map(xyOf);
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i, i += 1) {
      const [xi, yi] = pts[i]!;
      const [xj, yj] = pts[j]!;
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

/**
 * Un virage : une rue est–ouest (y ∈ [−4, 4]) et une rue nord–sud (x ∈ [−4, 4])
 * qui s'y branche au sud, publiques dans une grande parcelle ; une placette au
 * coin nord-est ; une cour enclavée au nord-ouest ; une place au sud-est, reliée
 * à la rue par un passage de 4 m.
 */
const STREETS = [-300, -4, 300, 4] as const;
const SIDE_STREET = [-4, -300, 4, -4] as const;
const CORNER = [4, 4, 16, 14] as const;
const COURTYARD = [-30, 10, -18, 22] as const;
const PASSAGE = [20, -20, 24, -4] as const;
const SQUARE = [15, -35, 40, -20] as const;
const PARCELS: OpenSpaceParcel[] = [
  {
    polygons: [
      [
        rect(-400, -400, 400, 400),
        ...[STREETS, SIDE_STREET, CORNER, COURTYARD, PASSAGE, SQUARE].map(([x0, y0, x1, y1]) =>
          rect(x0, y0, x1, y1),
        ),
      ],
    ],
  },
];
/** Le trajet du camion dans la vue : il arrive par l'ouest et tourne au sud. */
const ROUTE = [at(-80, 0), at(0, 0), at(0, -80)];
const FRAME = boxOf(-50, -50, 50, 50);

function input(over: Partial<PublicSpaceInput> = {}): PublicSpaceInput {
  return { box: FRAME, seeds: [ROUTE], parcels: PARCELS, buildings: [], ...over };
}

function measured(over: Partial<PublicSpaceInput> = {}) {
  const result = computePublicSpace(input(over));
  if (!result.known) throw new Error(`inconnu : ${result.why}`);
  return result.value;
}

describe('computePublicSpace — le cadre de la vue, le trajet du camion', () => {
  it('les deux rues du virage et la placette du coin : servies, jusqu’au bord du cadre et pas au-delà', () => {
    const space = measured();
    expect(covers(space.rings, at(-45, 3.5))).toBe(true);
    expect(covers(space.rings, at(45, -3.5))).toBe(true); // la rue continue à l'est, au-delà du virage
    expect(covers(space.rings, at(3.5, -45))).toBe(true);
    expect(covers(space.rings, at(10, 9))).toBe(true); // la placette du coin
    // Hors du cadre, la rue n'est pas servie : la vue ne voit rien au-delà.
    expect(covers(space.rings, at(-55, 0))).toBe(false);
    expect(covers(space.rings, at(0, -55))).toBe(false);
    // Les parcelles, jamais.
    expect(covers(space.rings, at(-10, -10))).toBe(false);
    // Dans le cadre : rue 100 × 8, rue latérale 46 × 8 ; placette 12 × 10 ; place 25 × 15 et passage 4 × 16.
    const expected = 100 * 8 + 46 * 8 + 120 + 375 + 64;
    expect(space.areaM2).toBeGreaterThan(expected * 0.98);
    expect(space.areaM2).toBeLessThan(expected * 1.02);
    expect(space.method).toBe('cadastre-minus-bdtopo-buildings/raster-0.25m/opening-1.25m');
  });

  it('une cour enclavée, qu’aucune rue ne rejoint, n’est pas servie', () => {
    expect(covers(measured().rings, at(-24, 16))).toBe(false);
  });

  it('un bâti posé sur la rue en est retiré (un kiosque : un trou)', () => {
    const space = measured({ buildings: [rect(-30, -1, -28, 1)] });
    expect(covers(space.rings, at(-29, 0))).toBe(false);
    expect(covers(space.rings, at(-29, 3))).toBe(true);
  });

  it('la coupe s’applique : la place qu’on ne rejoint que par un passage piéton n’est plus servie', () => {
    const joined = measured();
    expect(covers(joined.rings, at(30, -28))).toBe(true);
    const links: OpenSpaceLinks = {
      closed: [[at(22, 0), at(22, -28)]],
      open: [[at(-300, 0), at(300, 0)], [at(0, 0), at(0, -300)]],
    };
    const cut = measured({ links });
    expect(covers(cut.rings, at(30, -28))).toBe(false);
    expect(covers(cut.rings, at(22, -2))).toBe(true); // la rue, là où le passage la quitte
    expect(covers(cut.rings, at(22, -16))).toBe(false); // le passage, au-delà de son entrée
    expect(cut.method).toBe(`${joined.method}/closed-links-cut-3m`);
  });

  it('des inconnues nommées, jamais un espace vide', () => {
    const degenerate = { south: 47, west: -0.98, north: 47, east: -0.97 };
    expect(computePublicSpace(input({ box: degenerate }))).toEqual({ known: false, why: 'empty_box' });
    // 600 × 600 m à 0,25 m : 5,8 millions de cellules, au-delà de la garde.
    expect(computePublicSpace(input({ box: boxOf(-300, -300, 300, 300) }))).toEqual({
      known: false,
      why: 'area_too_large',
    });
    // Le trajet passe loin du cadre.
    expect(computePublicSpace(input({ seeds: [[at(200, 200), at(250, 200)]] }))).toEqual({
      known: false,
      why: 'no_seed',
    });
    expect(computePublicSpace(input({ seeds: [] }))).toEqual({ known: false, why: 'no_seed' });
    // Le trajet court sur des parcelles (voie privée cadastrée).
    expect(computePublicSpace(input({ seeds: [[at(-10, -20), at(-30, -20)]] }))).toEqual({
      known: false,
      why: 'seed_on_parcels',
    });
  });

  it('un point seul suffit comme graine', () => {
    const space = measured({ seeds: [[at(-20, 0)]] });
    expect(covers(space.rings, at(3.5, -45))).toBe(true);
  });
});

describe('un lien fermé court entre deux tronçons ouverts (potelets, escalier court)', () => {
  // Une rue publique de 6 m (y ∈ [−3, 3]) entre deux îlots, d'un seul tenant de x = −50 à 50.
  const STREET: OpenSpaceParcel[] = [
    { polygons: [[rect(-100, -100, 100, 100), rect(-50, -3, 50, 3)]] },
  ];
  const street = (links?: OpenSpaceLinks) =>
    measured({
      box: boxOf(-60, -20, 60, 20),
      seeds: [[at(-40, 0)]],
      parcels: STREET,
      ...(links === undefined ? {} : { links }),
    });
  // La BD TOPO la trace en trois tronçons : ouvert | 4 m « Physiquement impossible » | ouvert.
  const bollards: OpenSpaceLinks = {
    closed: [[at(0, 0), at(4, 0)]],
    open: [
      [at(-60, 0), at(0, 0)],
      [at(4, 0), at(60, 0)],
    ],
  };

  it('un bout de 4 m sépare les deux côtés ; sans lui, la rue est d’un seul tenant', () => {
    const joined = street({ closed: [], open: [[at(-60, 0), at(60, 0)]] });
    expect(covers(joined.rings, at(30, 0))).toBe(true);
    const cut = street(bollards);
    expect(covers(cut.rings, at(-30, 0))).toBe(true);
    expect(covers(cut.rings, at(2, 2.5))).toBe(true); // le bout lui-même, recousu depuis le côté servi
    expect(covers(cut.rings, at(6, 0))).toBe(false); // au-delà de son nœud, rien
    expect(covers(cut.rings, at(30, 0))).toBe(false);
    // Le côté servi (50 × 6 m) et le bout (4 × 6 m), au m² près : la moitié de la rue.
    expect(cut.areaM2).toBeGreaterThan(324 - 6);
    expect(cut.areaM2).toBeLessThan(324 + 6);
  });

  it('un sommet à 0,5 m du nœud ne rouvre pas la garde au-delà de lui', () => {
    const cut = street({
      closed: bollards.closed,
      open: [
        [at(-60, 0), at(-0.5, 0.05), at(0, 0)],
        [at(4, 0), at(4.5, -0.05), at(60, 0)],
      ],
    });
    expect(covers(cut.rings, at(30, 0))).toBe(false);
  });

  it('au carrefour, la voie que le lien quitte n’est pas coupée : tracée en deux tronçons au nœud, le même contour qu’entière', () => {
    const passage = [at(22, 0), at(22, -28)];
    const whole = measured({
      links: {
        closed: [passage],
        open: [
          [at(-300, 0), at(300, 0)],
          [at(0, 0), at(0, -300)],
        ],
      },
    });
    const split = measured({
      links: {
        closed: [passage],
        open: [
          [at(-300, 0), at(22, 0)],
          [at(22, 0), at(300, 0)],
          [at(0, 0), at(0, -300)],
        ],
      },
    });
    expect(split.rings).toEqual(whole.rings);
    expect(covers(split.rings, at(45, -3.5))).toBe(true);
  });
});

interface SèvremoineFixture {
  readonly axis: GeoPoint[];
  readonly places: GeoPoint[];
  readonly parcels: OpenSpaceParcel[];
  readonly buildings: GeoPoint[][];
}

describe('Sèvremoine vue du ciel : un cadre de 100 m centré sur la placette', () => {
  const fixture = JSON.parse(
    readFileSync(new URL('./fixtures/sevremoine-open-space.json', import.meta.url), 'utf8'),
  ) as SèvremoineFixture;
  const read = JSON.parse(
    readFileSync(new URL('./fixtures/sevremoine-links.json', import.meta.url), 'utf8'),
  ) as { links: { closed: boolean; lines: GeoPoint[][] }[] };
  const links: OpenSpaceLinks = {
    closed: read.links.filter((l) => l.closed).flatMap((l) => l.lines),
    open: read.links.filter((l) => !l.closed).flatMap((l) => l.lines),
  };
  const centre = fixture.places[0]!;
  const half = { lat: 50 / M, lon: 50 / (M * Math.cos((centre.lat * Math.PI) / 180)) };
  // Les parcelles ont été lues sur l'emprise de l'impasse : le cadre se garde dedans (au sud-est, la voie privée).
  const box = {
    south: centre.lat - half.lat,
    west: centre.lon - half.lon,
    north: centre.lat + half.lat,
    east: centre.lon + half.lon,
  };
  const base = { box, seeds: [fixture.axis], parcels: fixture.parcels, buildings: fixture.buildings };

  it('la placette est servie ; la place de l’Allée Voisine JC aussi sans les tronçons, plus avec eux', () => {
    const joined = computePublicSpace(base);
    const cut = computePublicSpace({ ...base, links });
    if (!joined.known || !cut.known) throw new Error('inconnu');
    expect(covers(joined.value.rings, centre)).toBe(true);
    expect(covers(cut.value.rings, centre)).toBe(true);
    expect(covers(joined.value.rings, fixture.places[1]!)).toBe(true);
    expect(covers(cut.value.rings, fixture.places[1]!)).toBe(false);
    expect(cut.value.areaM2).toBeLessThan(joined.value.areaM2 - 500);
  });
});
