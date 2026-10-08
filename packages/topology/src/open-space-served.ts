/**
 * LE CŒUR COMMUN des deux lectures de l'espace public : celle du bout
 * de l'impasse (`open-space.ts`) et celle d'une vue du ciel
 * (`public-space.ts`). Une seule définition de « libre », de « relié » et du
 * contour servi (principe 23) ; chaque appelant ne pose que sa zone et ses graines.
 *
 * Sorti tel quel de `open-space.ts` (la maille, le masque des parcelles et du
 * bâti, le tampon d'une polyligne, la composante, les anneaux, l'aire), plus
 * UNE règle neuve :
 *
 * LA COUPE DES LIENS FERMÉS AUX VÉHICULES. À la Sèvremoine, l'espace de
 * l'impasse rejoignait, par un passage de 4 m sur 22 m que la BD TOPO dit
 * « physiquement impossible » aux véhicules légers, la grande place de l'Allée
 * Jean Voisine JC : la carte montrait au camion un espace où il n'entre que par
 * l'autre rue. Un lien fermé aux véhicules (le lecteur en décide :
 * `packages/adapters/src/bdtopo-road-links.ts`) retranche donc de l'espace libre
 * une bande de `CLOSED_LINK_CUT_M` de part et d'autre de son tracé, sauf à
 * moins de `OPEN_LINK_GUARD_M` d'un tronçon ouvert aux véhicules — la coupe ne
 * mord jamais sur la voie qu'un lien piéton quitte. Là où la voie S'ARRÊTE et
 * où un lien fermé la prolonge — un nœud qu'un seul tronçon ouvert partage avec
 * un lien fermé —, la garde s'arrête net au nœud : une cellule au-delà, plus
 * proche de lui que du corps de tout tronçon ouvert, n'est pas gardée. Sans
 * quoi, entre deux tronçons ouverts, un lien fermé de moins de
 * 2 × `OPEN_LINK_GUARD_M` (un bout de rue à potelets, un escalier court) serait
 * couvert d'un bout à l'autre par la garde, et la coupe serait nulle. Au
 * carrefour, où la voie continue, la garde reste arrondie : c'est la voie.
 * La composante se cherche
 * sans la bande ; puis la bande se RECOUD là où elle borde l'espace relié, sur
 * toute sa largeur (2 × `CLOSED_LINK_CUT_M`) : une place que le lien traverse,
 * ou longe à un mètre de son bord (la Sèvremoine : le tronçon part du bout de
 * l'impasse et file le long du bord de la placette), se referme entière ; un
 * passage que la bande couvre d'un bord à l'autre ne se recoud que sur 6 m
 * depuis son entrée — et ce qu'il reliait au-delà reste dehors. Le recousu ne
 * rend que des cellules de la bande : rien au-delà ne revient par lui.
 *
 * Sans lien fermé dans l'emprise, rien ne change au bit près : la coupe est nulle.
 */
import type { GeoPoint } from '@teneolog/domain';

import { signedArea, traceRings } from './open-space-contour.js';
import {
  erodeSquare,
  fillPolygon,
  grow,
  stampNearSegment,
  toGeo,
  toXY,
  visitNearSegment,
  type GridFrame,
  type XY,
} from './open-space-grid.js';
import { simplifyRings } from './open-space-simplify.js';

/** La maille : un quart de mètre, sous la précision du cadastre (métrique), au-dessus du coût (≈ 16 cellules / m²). */
export const OPEN_SPACE_CELL_M = 0.25;
/** Ce que dit `method` sur le fil : la source, la soustraction, la maille et l'ouverture. */
export const OPEN_SPACE_METHOD = 'cadastre-minus-bdtopo-buildings/raster-0.25m/opening-1.25m';
/** L'ouverture, en cellules : une bande de moins de 2 × 2 + 1 = 5 cellules (1,25 m) ne relie rien. */
const OPENING_CELLS = 2;
/** La simplification du contour : une cellule — l'escalier d'un bord en biais devient une pente. */
const SIMPLIFY_CELLS = 1;
/** Un plafond de garde (~16 Mo de grilles) : au-delà, la zone n'est ni celle d'une impasse ni celle d'une vue. */
export const MAX_CELLS = 4_000_000;
/** L'axe (OSM, ou la route du camion) et le cadastre se calent au mètre près : les graines couvrent 1,5 m. */
export const SEED_BAND_M = 1.5;

/**
 * La demi-largeur de la coupe d'un lien fermé : 3 m. Un passage piéton fait de
 * 1,5 à 5 m d'emprise (Sèvremoine : 4 m), et le tracé BD TOPO n'est pas au
 * milieu — sa précision planimétrique est métrique. 3 m de part et d'autre
 * couvrent un passage de 4 m décalé d'un mètre ; jusqu'à ~8,5 m d'emprise
 * centrée, ce que la bande laisse de chaque côté fait encore moins de
 * l'ouverture (1,25 m). Une place plus large n'est pas un passage : ce qui
 * reste de part et d'autre la relie, et la bande s'y recoud.
 */
const CLOSED_LINK_CUT_M = 3;
/**
 * La garde autour d'un tronçon ouvert : 3 m, la demi-chaussée d'une voie de
 * 6 m. Le lien piéton part d'un nœud de la voie (Sèvremoine : le bout de
 * l'impasse) ; sans garde, la bande trancherait la voie elle-même à ce nœud.
 */
const OPEN_LINK_GUARD_M = 3;
/**
 * Deux bouts de tronçons à moins de 0,5 m sont le même nœud : la BD TOPO les
 * pose au même point (Sèvremoine : 0,000 m aux deux bouts du passage).
 */
const SHARED_NODE_M = 0.5;
/** Le bout plat déborde d'un millimètre : l'arrondi du calcul ne le fait jamais reculer. */
const FLAT_END_SLACK_M = 0.001;
/** À égalité de distance (au dixième de millimètre carré près), le corps l'emporte : la cellule est gardée. */
const TIE_M2 = 1e-4;
/** Ce que `method` ajoute quand les tronçons ont été lus (la coupe posée, même nulle). */
const CLOSED_LINKS_METHOD = `closed-links-cut-${CLOSED_LINK_CUT_M}m`;

/** Une parcelle, telle que le lecteur du cadastre la rend : chaque polygone [extérieur, ...trous]. */
export interface OpenSpaceParcel {
  readonly polygons: readonly (readonly (readonly GeoPoint[])[])[];
}

/**
 * Les tronçons BD TOPO lus dans l'emprise, classés par le lecteur : ceux
 * qu'aucun véhicule ne prend coupent l'espace, les autres le gardent.
 * Absents : pas de coupe (lecture d', ou lecteur non monté).
 */
export interface OpenSpaceLinks {
  readonly closed: readonly (readonly GeoPoint[])[];
  readonly open: readonly (readonly GeoPoint[])[];
}

export interface OpenSpace {
  /** Les anneaux du contour, en lat/lon, à remplir en règle pair-impair (extérieurs et trous). */
  readonly rings: readonly (readonly GeoPoint[])[];
  /** L'aire de la composante, au compte des cellules, en m². */
  readonly areaM2: number;
  readonly method: string;
}

/** Pose `1` sur chaque cellule à au plus `radiusM` de la polyligne (un point seul : un disque). */
export function stampPolyline(
  mask: Uint8Array,
  frame: GridFrame,
  line: readonly GeoPoint[],
  radiusM: number,
): void {
  const xy = line.map((p) => toXY(frame, p));
  if (xy.length === 1) stampNearSegment(mask, frame, xy[0]!, xy[0]!, radiusM);
  for (let k = 1; k < xy.length; k += 1) stampNearSegment(mask, frame, xy[k - 1]!, xy[k]!, radiusM);
}

/** 1 sur toute cellule couverte par une parcelle ou un bâti. */
export function blockedMask(
  frame: GridFrame,
  parcels: readonly OpenSpaceParcel[],
  buildings: readonly (readonly GeoPoint[])[],
): Uint8Array {
  const blocked = new Uint8Array(frame.cols * frame.rows);
  for (const parcel of parcels) {
    for (const polygon of parcel.polygons)
      fillPolygon(
        blocked,
        frame,
        polygon.map((ring) => ring.map((p) => toXY(frame, p))),
      );
  }
  for (const ring of buildings) fillPolygon(blocked, frame, [ring.map((p) => toXY(frame, p))]);
  return blocked;
}

/** Un segment d'un tronçon ouvert, et son corps le long de lui : [lo, hi] (±∞ : un bout arrondi). */
interface GuardSegment {
  readonly a: XY;
  readonly b: XY;
  readonly lo: number;
  readonly hi: number;
}

const endsOf = (frame: GridFrame, lines: readonly (readonly GeoPoint[])[]): XY[] =>
  lines
    .filter((line) => line.length > 1)
    .flatMap((line) => [toXY(frame, line[0]!), toXY(frame, line[line.length - 1]!)]);

/**
 * Les segments des tronçons ouverts ; le corps d'un tronçon s'arrête à son bout
 * quand la voie s'arrête là et qu'un lien fermé la prolonge (un seul bout
 * ouvert au nœud, et un bout fermé).
 */
function guardSegments(frame: GridFrame, links: OpenSpaceLinks): GuardSegment[] {
  const closedEnds = endsOf(frame, links.closed);
  const openEnds = endsOf(frame, links.open);
  const near = (p: XY) => (q: XY) => Math.hypot(p.x - q.x, p.y - q.y) <= SHARED_NODE_M;
  const roadStopsAt = (p: XY): boolean =>
    closedEnds.some(near(p)) && openEnds.filter(near(p)).length === 1;
  return links.open.flatMap((line) => {
    const xy = line.map((p) => toXY(frame, p));
    if (xy.length < 2) return xy.map((p) => ({ a: p, b: p, lo: -Infinity, hi: Infinity }));
    const flatStart = roadStopsAt(xy[0]!);
    const flatEnd = roadStopsAt(xy[xy.length - 1]!);
    return xy.slice(1).map((b, k) => {
      const a = xy[k]!;
      const slack = FLAT_END_SLACK_M / Math.max(Math.hypot(b.x - a.x, b.y - a.y), FLAT_END_SLACK_M);
      return {
        a,
        b,
        lo: k === 0 && flatStart ? -slack : -Infinity,
        hi: k === xy.length - 2 && flatEnd ? 1 + slack : Infinity,
      };
    });
  });
}

/**
 * La garde des tronçons ouverts : les cellules dont le point ouvert le plus
 * proche, à au plus `OPEN_LINK_GUARD_M`, est sur le corps d'un tronçon — pas
 * au-delà du nœud où la voie s'arrête. Le coude d'un sommet voisin du nœud
 * (Sèvremoine : 2,75 m) ne rouvre donc pas la garde au-delà de lui.
 */
function guardMask(frame: GridFrame, links: OpenSpaceLinks): Uint8Array {
  const segments = guardSegments(frame, links);
  const body = new Float32Array(frame.cols * frame.rows).fill(Infinity);
  for (const { a, b, lo, hi } of segments)
    visitNearSegment(frame, a, b, OPEN_LINK_GUARD_M, (k, along, distSq) => {
      if (along >= lo && along <= hi && distSq < body[k]!) body[k] = distSq;
    });
  const guard = Uint8Array.from(body, (d) => (d < Infinity ? 1 : 0));
  for (const { a, b, lo, hi } of segments) {
    if (lo === -Infinity && hi === Infinity) continue;
    visitNearSegment(frame, a, b, OPEN_LINK_GUARD_M, (k, along, distSq) => {
      if ((along < lo || along > hi) && distSq < body[k]! - TIE_M2) guard[k] = 0;
    });
  }
  return guard;
}

/** La bande des liens fermés, moins la garde des tronçons ouverts ; null quand elle ne couvre rien. */
function cutMask(frame: GridFrame, links: OpenSpaceLinks): Uint8Array | null {
  const cut = new Uint8Array(frame.cols * frame.rows);
  for (const line of links.closed) stampPolyline(cut, frame, line, CLOSED_LINK_CUT_M);
  if (!cut.includes(1)) return null;
  const guard = guardMask(frame, links);
  for (let k = 0; k < cut.length; k += 1) if (guard[k] === 1) cut[k] = 0;
  return cut.includes(1) ? cut : null;
}

/**
 * La composante reliée aux graines : libre, ouverte à 1,25 m, en 4-connexité
 * depuis les graines, puis rendue à son bord (8-voisins, `OPENING_CELLS` pas)
 * — et, s'il y a une coupe, recousue là où elle borde. Null quand aucune
 * graine ne tombe dans l'espace ouvert.
 */
function servedComponent(
  frame: GridFrame,
  free: Uint8Array,
  seeds: Uint8Array,
  links: OpenSpaceLinks | undefined,
): Uint8Array | null {
  const cut = links === undefined ? null : cutMask(frame, links);
  const open = cut === null ? free : free.map((f, k) => (f === 1 && cut[k] !== 1 ? 1 : 0));
  const core = erodeSquare(open, frame.cols, frame.rows, OPENING_CELLS);
  const reached = grow(seeds, core, frame, { neighbours: 4, depth: Infinity });
  if (!reached.includes(1)) return null;
  const component = grow(reached, open, frame, { neighbours: 8, depth: OPENING_CELLS });
  if (cut === null) return component;
  const healable = component.map((c, k) => (c === 1 || (free[k] === 1 && cut[k] === 1) ? 1 : 0));
  // Le recousu : la largeur de la bande — une bande bordée d'un seul côté se referme entière.
  const heal = Math.ceil((2 * CLOSED_LINK_CUT_M) / frame.cellM);
  return grow(component, healable, frame, { neighbours: 8, depth: heal });
}

/**
 * Les anneaux de la composante, simplifiés à une cellule près sans se croiser,
 * en lat/lon ; les plus grands d'abord. Pas d'arrondi : le passage au lat/lon
 * est affine et garde le sens de chaque orientation, quand un arrondi au
 * centimètre pourrait faire se croiser deux côtés que quelques millimètres séparent.
 */
function ringsOf(component: Uint8Array, frame: GridFrame): GeoPoint[][] {
  const { cellM } = frame;
  return simplifyRings(traceRings(component, frame.cols, frame.rows), SIMPLIFY_CELLS)
    .map((ring) => ({ ring, area: Math.abs(signedArea(ring)) }))
    .sort((a, b) => b.area - a.area)
    .map(({ ring }) => ring.map((v) => toGeo(frame, { x: v.x * cellM, y: v.y * cellM })));
}

/**
 * L'espace public servi : la composante de `free` reliée aux `seeds` (coupée
 * aux liens fermés quand `links` est lu), son contour et son aire au compte des
 * cellules. Null quand aucune graine ne touche l'espace ouvert.
 */
export function servedSpace(
  frame: GridFrame,
  free: Uint8Array,
  seeds: Uint8Array,
  links: OpenSpaceLinks | undefined,
): OpenSpace | null {
  const component = servedComponent(frame, free, seeds, links);
  if (component === null) return null;
  const cells = component.reduce((sum, cell) => sum + cell, 0);
  return {
    rings: ringsOf(component, frame),
    areaM2: Math.round(cells * frame.cellM * frame.cellM),
    method: links === undefined ? OPEN_SPACE_METHOD : `${OPEN_SPACE_METHOD}/${CLOSED_LINKS_METHOD}`,
  };
}
