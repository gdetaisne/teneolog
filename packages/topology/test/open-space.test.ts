/**
 * l'espace public au bout de l'impasse (`open-space.ts`) : ce que ne
 * couvre aucune parcelle, moins le bâti, relié à l'axe, dans la zone bornée.
 *
 * Deux jeux :
 *  - des cas synthétiques dans un repère local en mètres (x vers l'est, y vers
 *    le nord), où le domaine public est le TROU d'une grande parcelle — chaque
 *    règle y a son cas qui échoue sans elle ;
 *  - la Sèvremoine, sur les parcelles réelles lues le 2026-09-25 et les
 *    emprises BD TOPO du run (`fixtures/sevremoine-open-space.json`) : la
 *    placette de l'enquête (≈ 12,5 × 14,9 m, à gauche, s ≈ 156–171 m) et
 *    l'emprise publique de la voie (~6,5 m, là où la BD TOPO dit 3 m).
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import type { GeoPoint } from '@teneolog/domain';

import {
  computeOpenSpace,
  OPEN_SPACE_CELL_M,
  openSpaceExtent,
  type OpenSpaceInput,
  type OpenSpaceLinks,
  type OpenSpaceParcel,
} from '../src/open-space.js';

const M = (6_371_008.8 * Math.PI) / 180;
const O: GeoPoint = { lat: 47.0, lon: -0.98 };
const K = M * Math.cos((O.lat * Math.PI) / 180);
const at = (x: number, y: number): GeoPoint => ({ lat: O.lat + y / M, lon: O.lon + x / K });
const xyOf = (p: GeoPoint, origin: GeoPoint = O): readonly [number, number] => {
  const k = M * Math.cos((origin.lat * Math.PI) / 180);
  return [(p.lon - origin.lon) * k, (p.lat - origin.lat) * M];
};
const rect = (x0: number, y0: number, x1: number, y1: number): GeoPoint[] => [
  at(x0, y0),
  at(x1, y0),
  at(x1, y1),
  at(x0, y1),
];

/** Une grande parcelle de 400 × 400 m percée des rectangles publics donnés (qui ne se chevauchent pas). */
function publicLand(
  ...holes: readonly (readonly [number, number, number, number])[]
): OpenSpaceParcel {
  return {
    polygons: [
      [rect(-200, -200, 200, 200), ...holes.map(([x0, y0, x1, y1]) => rect(x0, y0, x1, y1))],
    ],
  };
}

/** Pair-impair sur tous les anneaux rendus : la règle de remplissage du contrat. */
function covers(rings: readonly (readonly GeoPoint[])[], p: GeoPoint): boolean {
  const [x, y] = xyOf(p);
  let inside = false;
  for (const ring of rings) {
    const pts = ring.map((q) => xyOf(q));
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i, i += 1) {
      const [xi, yi] = pts[i]!;
      const [xj, yj] = pts[j]!;
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

/**
 * Les fautes des anneaux SERVIS (lat/lon → mètres locaux) : deux côtés qui se
 * croisent, ou un sommet à moins de 0,1 mm d'un côté dont il n'est pas un bout.
 * Les anneaux ne doivent se toucher qu'en un sommet commun (relecture du 2026-09-25).
 */
function ringFaults(rings: readonly (readonly GeoPoint[])[]): number {
  type P = readonly [number, number];
  const sides = rings.flatMap((ring) => {
    const pts = ring.map((q) => xyOf(q));
    return pts.map((a, k) => [a, pts[(k + 1) % pts.length]!] as const);
  });
  const orient = (a: P, b: P, c: P): number =>
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const same = (a: P, b: P): boolean => Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6;
  const near = (p: P, a: P, b: P): boolean => {
    if (same(p, a) || same(p, b)) return false;
    const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
    const t = Math.max(
      0,
      Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)),
    );
    return Math.hypot(a[0] + t * dx - p[0], a[1] + t * dy - p[1]) < 1e-4;
  };
  let count = 0;
  for (let i = 0; i < sides.length; i += 1) {
    for (let j = i + 1; j < sides.length; j += 1) {
      const [a, b] = sides[i]!;
      const [c, d] = sides[j]!;
      const crossing =
        orient(a, b, c) * orient(a, b, d) < 0 && orient(c, d, a) * orient(c, d, b) < 0;
      const shared = same(a, c) || same(a, d) || same(b, c) || same(b, d);
      const touching = near(c, a, b) || near(d, a, b) || near(a, c, d) || near(b, c, d);
      if ((crossing && !shared) || touching) count += 1;
    }
  }
  return count + pinchCrossingsGeo(rings);
}

/**
 * Deux passages par un même sommet servi qui s'y croisent (seconde relecture du
 * 2026-09-25) : les directions de l'un de part et d'autre de l'angle de l'autre.
 */
function pinchCrossingsGeo(rings: readonly (readonly GeoPoint[])[]): number {
  const TAU = 2 * Math.PI;
  const passes = new Map<string, (readonly [number, number])[]>();
  for (const ring of rings) {
    const pts = ring.map((q) => xyOf(q));
    pts.forEach(([x, y], k) => {
      const [bx, by] = pts[(k - 1 + pts.length) % pts.length]!;
      const [ax, ay] = pts[(k + 1) % pts.length]!;
      const key = `${ring[k]!.lat},${ring[k]!.lon}`;
      const angles = [Math.atan2(by - y, bx - x), Math.atan2(ay - y, ax - x)] as const;
      passes.set(key, [...(passes.get(key) ?? []), angles]);
    });
  }
  let count = 0;
  for (const list of passes.values()) {
    for (let u = 0; u < list.length; u += 1) {
      for (let v = u + 1; v < list.length; v += 1) {
        const [a1, a2] = list[u]!;
        const turned = (angle: number): number => (((angle - a1) % TAU) + TAU) % TAU;
        const [b1, b2] = list[v]!.map(turned) as [number, number];
        if (b1 < turned(a2) !== b2 < turned(a2)) count += 1;
      }
    }
  }
  return count;
}

// La voie : axe de (-100, 0) à (100, 0), le bout fermé à x = 100 ; l'arrêt à s = 140 m, soit x = 40.
const AXIS = [at(-100, 0), at(0, 0), at(100, 0)];
const LANE = [-150, -3, 100, 3] as const; // 6 m d'emprise publique, jusqu'au bout
const PLACETTE = [70, 3, 85, 15] as const; // 15 × 12 m, à gauche en entrant (au nord)

function input(over: Partial<OpenSpaceInput> = {}): OpenSpaceInput {
  return {
    axis: AXIS,
    fromAlongM: 140,
    places: [],
    radiusM: 32,
    readDisc: { centre: at(40, 0), radiusM: 120 },
    parcels: [publicLand(LANE, PLACETTE)],
    buildings: [],
    ...over,
  };
}

function measured(over: Partial<OpenSpaceInput> = {}) {
  const result = computeOpenSpace(input(over));
  if (!result.known) throw new Error(`inconnu : ${result.why}`);
  return result.value;
}

describe('computeOpenSpace — la zone bornée, le creux du cadastre, la composante reliée à l’axe', () => {
  it('la voie publique depuis l’arrêt (moins le rayon) jusqu’au bout, et la placette : un anneau, l’aire au compte des cellules', () => {
    const space = measured();
    // Voie : de x = 40 − 32 = 8 à 100, 6 m ; placette 15 × 12 m.
    expect(space.areaM2).toBeGreaterThan((92 * 6 + 180) * 0.98);
    expect(space.areaM2).toBeLessThan((92 * 6 + 180) * 1.02);
    expect(space.rings).toHaveLength(1);
    expect(covers(space.rings, at(60, 0))).toBe(true);
    expect(covers(space.rings, at(77, 10))).toBe(true);
    // Avant l'arrêt, au-delà du rayon : la zone ne remonte pas vers la bouche.
    expect(covers(space.rings, at(0, 0))).toBe(false);
    // Hors du creux : une parcelle n'est jamais de l'espace public.
    expect(covers(space.rings, at(60, 5))).toBe(false);
    expect(space.method).toBe('cadastre-minus-bdtopo-buildings/raster-0.25m/opening-1.25m');
  });

  it('un bâti posé dans la placette en est retiré : un trou, et 4 m² de moins', () => {
    const without = measured();
    const withKiosk = measured({ buildings: [rect(76, 8, 78, 10)] });
    expect(withKiosk.rings).toHaveLength(2);
    expect(covers(withKiosk.rings, at(77, 9))).toBe(false);
    expect(covers(withKiosk.rings, at(77, 12))).toBe(true);
    expect(without.areaM2 - withKiosk.areaM2).toBeGreaterThanOrEqual(3);
    expect(without.areaM2 - withKiosk.areaM2).toBeLessThanOrEqual(5);
  });

  it('les anneaux servis ne se croisent ni ne se touchent hors d’un sommet commun, même près d’un petit bâti (relecture 2026-09-25)', () => {
    // Le cas de la relecture : une placette en trapèze, et un bâti triangulaire à 0,6 m du bord de la voie.
    const trapezoid = [at(65, 3), at(88, 3), at(86.3, 15.2), at(66.1, 14.7)];
    const parcels: OpenSpaceParcel[] = [
      { polygons: [[rect(-200, -200, 200, 200), rect(...LANE), trapezoid]] },
    ];
    const space = measured({ parcels, buildings: [[at(60.3, 0.9), at(63.1, 2.4), at(61.7, 1.9)]] });
    expect(covers(space.rings, at(75, 8))).toBe(true);
    expect(ringFaults(space.rings)).toBe(0);
    expect(ringFaults(measured({ buildings: [rect(76, 8, 78, 10)] }).rings)).toBe(0);
  });

  it('un creux enclavé, qui ne touche pas la voie, n’en est pas', () => {
    const space = measured({ parcels: [publicLand(LANE, [50, 8, 62, 20])] });
    expect(covers(space.rings, at(56, 14))).toBe(false);
  });

  it('relié par un jour de 0,5 m entre deux parcelles : pas relié ; par un passage de 3 m : relié', () => {
    const pocket = [50, 8, 62, 20] as const;
    const sliver = measured({ parcels: [publicLand(LANE, [55, 3, 55.5, 8], pocket)] });
    expect(covers(sliver.rings, at(56, 14))).toBe(false);
    const passage = measured({ parcels: [publicLand(LANE, [54, 3, 57, 8], pocket)] });
    expect(covers(passage.rings, at(56, 14))).toBe(true);
  });

  it('la zone ne sort pas du disque où le bâti a été lu', () => {
    const space = measured({ readDisc: { centre: at(40, 0), radiusM: 40 } });
    expect(covers(space.rings, at(75, 0))).toBe(true);
    expect(covers(space.rings, at(79, 4))).toBe(true); // à 39,2 m de l'arrêt
    // Dans l'emprise lue (x ≤ 80) mais hors du disque : à 41,4 m de l'arrêt.
    expect(covers(space.rings, at(79, 14))).toBe(false);
    expect(covers(space.rings, at(85, 0))).toBe(false); // hors de l'emprise
  });

  it('un lieu proposé par le moteur ajoute son disque : une place publique à 40 m de l’axe, reliée par une rue', () => {
    const square = [30, -60, 60, -30] as const;
    const street = [40, -30, 46, -3] as const;
    const parcels = [publicLand(LANE, square, street)];
    const alone = measured({ parcels });
    expect(covers(alone.rings, at(45, -50))).toBe(false); // à 50 m de l'axe : hors du tampon
    const offered = measured({ parcels, places: [at(45, -45)] });
    expect(covers(offered.rings, at(45, -50))).toBe(true);
  });

  it('une voie cadastrée (voie privée, ou axe décalé du cadastre) : aucune graine — inconnu nommé, jamais un espace vide', () => {
    const result = computeOpenSpace(
      input({ parcels: [{ polygons: [[rect(-200, -200, 200, 200)]] }] }),
    );
    expect(result).toEqual({ known: false, why: 'axis_on_parcels' });
  });

  it('sans axe : ni emprise ni espace', () => {
    expect(openSpaceExtent(input({ axis: [] }))).toBeNull();
    expect(computeOpenSpace(input({ axis: [] }))).toEqual({ known: false, why: 'no_axis' });
  });

  it('l’emprise à lire : le tampon de l’axe depuis l’arrêt et les disques des lieux, coupés au disque lu', () => {
    const box = openSpaceExtent(input({ places: [at(45, -45)] }))!;
    const [west, south] = xyOf({ lat: box.south, lon: box.west });
    const [east, north] = xyOf({ lat: box.north, lon: box.east });
    expect(west).toBeCloseTo(8, 0); // arrêt à x = 40, moins 32
    expect(east).toBeCloseTo(132, 0); // bout à x = 100, plus 32
    expect(north).toBeCloseTo(32, 0);
    expect(south).toBeCloseTo(-77, 0); // le lieu à y = −45, moins 32
  });
});

describe('la coupe aux liens fermés aux véhicules', () => {
  // Le tronçon de la voie, tel que la BD TOPO le trace : ouvert, il garde la voie.
  const OPEN_AXIS = [at(-150, 0), at(100, 0)];
  const PASSAGE = [60, 3, 64, 20] as const; // 4 m × 17 m, de la voie à la place
  const SQUARE = [50, 20, 80, 30] as const; // 30 × 10 m, à 20 m de l'axe
  const passageLinks: OpenSpaceLinks = { closed: [[at(62, 0), at(62, 25)]], open: [OPEN_AXIS] };

  it('un passage piéton vers une place : sans les tronçons la place est servie ; coupés, ni le passage au-delà de son entrée, ni la place', () => {
    const parcels = [publicLand(LANE, PASSAGE, SQUARE)];
    const joined = measured({ parcels });
    expect(covers(joined.rings, at(70, 25))).toBe(true);
    const cut = measured({ parcels, links: passageLinks });
    expect(covers(cut.rings, at(70, 25))).toBe(false); // la place
    expect(covers(cut.rings, at(62, 12))).toBe(false); // le passage, à 9 m de la voie
    expect(covers(cut.rings, at(62, 7.5))).toBe(true); // son entrée, recousue sur 6 m
    // La voie, là même où le lien la quitte : rien n'y est coupé (la garde du tronçon ouvert).
    for (const x of [20, 59, 62, 65, 99]) {
      expect(covers(cut.rings, at(x, 2.6))).toBe(true);
      expect(covers(cut.rings, at(x, -2.6))).toBe(true);
    }
    // Ce qui part : la place (300 m²) et le passage moins son entrée (4 × 11 m).
    expect(joined.areaM2 - cut.areaM2).toBeGreaterThan(300 + 4 * 10);
    expect(joined.areaM2 - cut.areaM2).toBeLessThan(300 + 4 * 12);
    expect(cut.method).toBe(
      'cadastre-minus-bdtopo-buildings/raster-0.25m/opening-1.25m/closed-links-cut-3m',
    );
  });

  it('une placette que le lien traverse se recoud entière : même aire au mètre carré près, mêmes points', () => {
    const parcels = [publicLand(LANE, PLACETTE)];
    const without = measured({ parcels });
    const crossed = measured({
      parcels,
      links: { closed: [[at(77, 0), at(77, 40)]], open: [OPEN_AXIS] },
    });
    expect(Math.abs(without.areaM2 - crossed.areaM2)).toBeLessThanOrEqual(1);
    for (const p of [at(77, 10), at(77, 14.5), at(71, 14), at(84, 5), at(75, 4)])
      expect(covers(crossed.rings, p)).toBe(true);
  });

  it('sans lien fermé dans la zone : le même contour au sommet près, seule la méthode dit que les tronçons ont été lus', () => {
    const without = measured();
    const read = measured({ links: { closed: [[at(-190, -190), at(-180, -190)]], open: [OPEN_AXIS] } });
    expect(read.rings).toEqual(without.rings);
    expect(read.areaM2).toBe(without.areaM2);
    expect(without.method).toBe('cadastre-minus-bdtopo-buildings/raster-0.25m/opening-1.25m');
    expect(read.method).toBe(`${without.method}/closed-links-cut-3m`);
  });

  it('un sentier qui traverse la voie ne la coupe pas — la garde du tronçon ouvert ; sans elle, la voie serait tranchée', () => {
    // L'arrêt à x = 40 : la zone descend jusqu'à x = 8, et la voie de 8 à 17 ne rejoint l'arrêt qu'à travers la bande du sentier.
    const crossing = [at(20, -40), at(20, 40)];
    const guarded = measured({ links: { closed: [crossing], open: [OPEN_AXIS] } });
    expect(covers(guarded.rings, at(12, 0))).toBe(true);
    expect(covers(guarded.rings, at(20, 2.6))).toBe(true);
    const unguarded = measured({ links: { closed: [crossing], open: [] } });
    expect(covers(unguarded.rings, at(12, 0))).toBe(false);
  });
});

interface SèvremoineFixture {
  readonly axis: GeoPoint[];
  readonly stopAlongM: number;
  readonly stop: GeoPoint;
  readonly places: GeoPoint[];
  readonly parcels: (OpenSpaceParcel & { readonly idu: string })[];
  readonly buildings: GeoPoint[][];
}

const SEVREMOINE = JSON.parse(
  readFileSync(new URL('./fixtures/sevremoine-open-space.json', import.meta.url), 'utf8'),
) as SèvremoineFixture;

/** Le point de l'axe à l'abscisse `s` (depuis la bouche) et la gauche du conducteur, dans le repère de l'arrêt. */
function stationOf(s: number): {
  readonly p: readonly [number, number];
  readonly left: readonly [number, number];
} {
  const pts = SEVREMOINE.axis.map((q) => xyOf(q, SEVREMOINE.stop));
  let travelled = 0;
  for (let k = 1; k < pts.length; k += 1) {
    const [ax, ay] = pts[k - 1]!;
    const [bx, by] = pts[k]!;
    const length = Math.hypot(bx - ax, by - ay);
    if (travelled + length >= s || k === pts.length - 1) {
      const t = (s - travelled) / length;
      return {
        p: [ax + t * (bx - ax), ay + t * (by - ay)],
        left: [-(by - ay) / length, (bx - ax) / length],
      };
    }
    travelled += length;
  }
  throw new Error('axe vide');
}


/** Les tronçons BD TOPO lus sur l'emprise de la Sèvremoine, classés par le lecteur. */
interface SèvremoineLinks {
  readonly links: readonly {
    readonly id: string;
    readonly closed: boolean;
    readonly lines: GeoPoint[][];
  }[];
}

const SEVREMOINE_LINKS = JSON.parse(
  readFileSync(new URL('./fixtures/sevremoine-links.json', import.meta.url), 'utf8'),
) as SèvremoineLinks;

/** Le passage de 4 m vers l'Allée Voisine JC : « Route à 1 chaussée », accès VL « Physiquement impossible ». */
const PASSAGE_ID = 'TRONROUT0000000329102793';

function sevremoineSpace(links?: OpenSpaceLinks) {
  const result = computeOpenSpace({
    axis: SEVREMOINE.axis,
    fromAlongM: SEVREMOINE.stopAlongM,
    places: SEVREMOINE.places,
    radiusM: 32,
    readDisc: { centre: SEVREMOINE.stop, radiusM: 120 },
    parcels: SEVREMOINE.parcels,
    buildings: SEVREMOINE.buildings,
    ...(links === undefined ? {} : { links }),
  });
  if (!result.known) throw new Error(result.why);
  return result.value;
}

const toSèvremoineGeo = ([x, y]: readonly [number, number]): GeoPoint => {
  const k = M * Math.cos((SEVREMOINE.stop.lat * Math.PI) / 180);
  return { lat: SEVREMOINE.stop.lat + y / M, lon: SEVREMOINE.stop.lon + x / k };
};

/** Jusqu'où l'espace s'étend depuis l'axe, à l'abscisse `s`, d'un côté (+1 gauche, −1 droite). */
function reachOf(rings: readonly (readonly GeoPoint[])[], s: number, side: 1 | -1): number {
  const { p, left } = stationOf(s);
  let m = 0;
  while (
    m < 60 &&
    covers(
      rings,
      toSèvremoineGeo([p[0] + side * left[0] * (m + 0.05), p[1] + side * left[1] * (m + 0.05)]),
    )
  )
    m += 0.05;
  return m;
}

const SEVREMOINE_READINGS = [
  { name: 'sans les tronçons', links: undefined },
  {
    name: 'coupé aux liens fermés',
    links: {
      closed: SEVREMOINE_LINKS.links.filter((l) => l.closed).flatMap((l) => l.lines),
      open: SEVREMOINE_LINKS.links.filter((l) => !l.closed).flatMap((l) => l.lines),
    },
  },
] as const;

describe.each(SEVREMOINE_READINGS)('Sèvremoine (parcelles du 2026-09-25, bâti BD TOPO du run) — $name', ({ links }) => {
  const space = sevremoineSpace(links);
  const reach = (s: number, side: 1 | -1): number => reachOf(space.rings, s, side);

  it('la voie : une emprise publique de 6 à 7,5 m sur toute la longueur, là où la BD TOPO dit 3 m', () => {
    const widths = [80, 100, 110, 120, 130, 140, 150].map((s) => reach(s, 1) + reach(s, -1));
    for (const width of widths) {
      expect(width).toBeGreaterThan(6);
      expect(width).toBeLessThan(7.5);
    }
  });

  it('la placette, à gauche : de s ≈ 156 à ≈ 171 m (≈ 15 m le long de l’axe), ≈ 12 m au-delà de la voie', () => {
    for (const s of [157.5, 163, 166, 170]) expect(reach(s, 1)).toBeGreaterThan(14);
    expect(reach(155, 1)).toBeLessThan(4); // avant la placette : la voie seule
    // Au-delà de s ≈ 171, l'axe OSM file sur la voie privée (parcelle AH 427) : plus d'espace public.
    expect(covers(space.rings, toSèvremoineGeo(stationOf(172).p))).toBe(false);
    expect(covers(space.rings, toSèvremoineGeo(stationOf(190).p))).toBe(false);
  });

  it('un anneau d’un seul tenant, et rien derrière les façades de l’arrêt', () => {
    expect(space.rings).toHaveLength(1);
    // L'arrêt est posé sur la maison du n° 11 : une parcelle, jamais de l'espace public.
    expect(covers(space.rings, SEVREMOINE.stop)).toBe(false);
    // L'option 1 du moteur, dans la placette.
    expect(covers(space.rings, SEVREMOINE.places[0]!)).toBe(true);
  });

  it('le contour servi est simple et léger : aucune faute, moins de 250 sommets (1 382 sur les arêtes des cellules)', () => {
    expect(ringFaults(space.rings)).toBe(0);
    expect(space.rings[0]!.length).toBeLessThan(250);
  });

  it('la maille est celle annoncée', () => {
    expect(OPEN_SPACE_CELL_M).toBe(0.25);
  });
});

describe('Sèvremoine — ce que la coupe retire, et rien d’autre', () => {
  const joined = sevremoineSpace();
  const cut = sevremoineSpace(SEVREMOINE_READINGS[1].links);
  const local = (p: GeoPoint): [number, number] => [...xyOf(p, SEVREMOINE.stop)];
  const passage = SEVREMOINE_LINKS.links.find((l) => l.id === PASSAGE_ID)!.lines[0]!.map(local);
  const axis = SEVREMOINE.axis.map(local);
  const distanceTo = (line: readonly (readonly [number, number])[], [x, y]: readonly [number, number]): number => {
    let best = Infinity;
    for (let k = 1; k < line.length; k += 1) {
      const [ax, ay] = line[k - 1]!;
      const [bx, by] = line[k]!;
      const [dx, dy] = [bx - ax, by - ay];
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
      best = Math.min(best, Math.hypot(ax + t * dx - x, ay + t * dy - y));
    }
    return best;
  };
  /** La distance d'un point au contour servi : sous 0,4 m, c'est le jeu de la simplification (0,25 m). */
  const edgeDistance = (rings: readonly (readonly GeoPoint[])[], p: readonly [number, number]): number =>
    Math.min(...rings.map((ring) => distanceTo([...ring, ring[0]!].map(local), p)));

  it('la place de l’Allée Voisine JC (l’option 2 du moteur) n’est plus servie : 1 709 m² → 818 m²', () => {
    expect(covers(joined.rings, SEVREMOINE.places[1]!)).toBe(true);
    expect(covers(cut.rings, SEVREMOINE.places[1]!)).toBe(false);
    expect(joined.areaM2).toBe(1_709);
    expect(cut.areaM2).toBeGreaterThan(790);
    expect(cut.areaM2).toBeLessThan(850);
    expect(cut.rings[0]!.length).toBeLessThan(joined.rings[0]!.length);
  });

  it('la placette reste entière, bord nord-ouest compris, là où le tronçon la longe à un mètre du bord', () => {
    // De s = 158 à 162, la perpendiculaire file dans le passage : elle n'y mesure plus la placette.
    for (const s of [156, 157, 157.5, 163, 165, 166, 168, 170])
      expect(Math.abs(reachOf(cut.rings, s, 1) - reachOf(joined.rings, s, 1))).toBeLessThanOrEqual(0.3);
  });

  it('rien d’autre ne bouge : tout point retiré est dans la bande du passage, ou à plus de 18 m de l’axe (la place)', () => {
    let removed = 0;
    for (let x = -80; x <= 100; x += 1) {
      for (let y = -110; y <= 80; y += 1) {
        const p = toSèvremoineGeo([x, y]);
        if (!covers(joined.rings, p) || covers(cut.rings, p)) continue;
        if (edgeDistance(joined.rings, [x, y]) < 0.4 || edgeDistance(cut.rings, [x, y]) < 0.4) continue;
        removed += 1;
        const inPassageBand = distanceTo(passage, [x, y]) <= 3;
        const beyond = distanceTo(axis, [x, y]) > 18;
        expect({ x, y, inPassageBand, beyond }).toMatchObject(
          inPassageBand ? { inPassageBand: true } : { beyond: true },
        );
      }
    }
    expect(removed).toBeGreaterThan(800); // ~920 m² retirés, au mètre carré près
    // Et rien n'est gagné.
    for (let x = -80; x <= 100; x += 1) {
      for (let y = -110; y <= 80; y += 1) {
        const p = toSèvremoineGeo([x, y]);
        if (covers(cut.rings, p) && !covers(joined.rings, p))
          expect(Math.min(edgeDistance(joined.rings, [x, y]), edgeDistance(cut.rings, [x, y]))).toBeLessThan(0.4);
      }
    }
  });
});
