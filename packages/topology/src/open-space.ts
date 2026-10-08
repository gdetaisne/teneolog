/**
 * L'ESPACE PUBLIC AU BOUT DE L'IMPASSE : ce que ne couvre aucune
 * parcelle du cadastre, moins le bâti BD TOPO, relié à l'axe de l'impasse.
 * (la note de conception interne, `openSpace`.)
 *
 * Le constat qui l'a fait naître (2026-09-25, 7 Allée des Essais) : un
 * 19 t fait demi-tour en trois temps dans une placette publique qu'aucune
 * donnée lue ne porte — OSM y dessine 13 m de ligne, la BD TOPO l'ignore, et la
 * voie « de 3 m » a une emprise publique de ~6,5 m. Seul le cadastre la montre,
 * en creux : la voirie communale n'est pas cadastrée. Ce module lit ce creux.
 *
 * Ce que c'est : un FAIT servi, comme les emprises du bâti. Rien ne le lit pour
 * un verdict (principe 17) ; « non cadastré » n'est pas « roulable » — un
 * trottoir, un espace vert communal, un cours d'eau du domaine public le sont
 * aussi — et le cadastre peut être décalé d'un mètre ou deux sur la photo.
 *
 * Pourquoi ici (`@teneolog/topology`) et pas dans les adaptateurs : c'est une
 * mesure du lieu, pure, sans réseau, à côté de la mesure des surfaces de
 * demi-tour (`turnaround.ts`) ; les adaptateurs lisent les parcelles
 * (`@teneolog/adapters`, `cadastre-parcels.ts`) et ne savent rien de l'impasse.
 *
 * La méthode, sur une grille de `OPEN_SPACE_CELL_M` (0,25 m) :
 *  1. LA ZONE BORNÉE : le tampon de `radiusM` autour de l'axe, de l'arrêt au
 *     bout, plus un disque de `radiusM` autour de chaque lieu proposé par le
 *     moteur, le tout coupé au disque où le bâti a été lu (hors de lui, un bâti
 *     manquant se lirait « libre ») ;
 *  2. LIBRE = dans la zone, hors de toute parcelle, hors de tout bâti ;
 *  3. UNE OUVERTURE de `OPENING_CELLS` cellules : une bande de moins de
 *     ~1,25 m ne relie rien — ce sont les jours de numérisation entre deux
 *     parcelles voisines, qu'aucun véhicule n'emprunte ;
 *  4. LA COMPOSANTE (4-connexe) qui touche l'axe, depuis l'arrêt vers le bout,
 *     à `SEED_BAND_M` près (le calage métrique entre OSM et le cadastre) —
 *     coupée, quand les tronçons BD TOPO sont lus, aux liens fermés aux
 * véhicules (`open-space-served.ts`);
 *  5. son contour, simplifié à une cellule près SANS qu'aucun côté n'en croise
 *     un autre (`open-space-simplify.ts`) ; son aire, au compte des cellules.
 * Aucune dépendance de découpage de polygones : la grille ne craint pas les
 * défauts de topologie du cadastre (anneaux qui se touchent, parcelles qui se
 * chevauchent de quelques centimètres), et son coût est borné par `MAX_CELLS`.
 */
import type { GeoPoint } from '@teneolog/domain';

import { haversineM } from './geometry.js';
import { frameOf, metresInDegrees, toXY, type GeoBox, type GridFrame } from './open-space-grid.js';
import {
  blockedMask,
  MAX_CELLS,
  OPEN_SPACE_CELL_M,
  SEED_BAND_M,
  servedSpace,
  stampPolyline,
  type OpenSpace,
  type OpenSpaceLinks,
  type OpenSpaceParcel,
} from './open-space-served.js';

// la maille, la méthode, les types et la composante servie vivent dans
// `open-space-served.ts`, partagés avec la vue du ciel (`public-space.ts`).
export { OPEN_SPACE_CELL_M, OPEN_SPACE_METHOD } from './open-space-served.js';
export type { OpenSpace, OpenSpaceLinks, OpenSpaceParcel } from './open-space-served.js';
/**
 * L'axe OSM et le cadastre se calent au mètre près : la composante part des cellules libres à 1,5 m de l'axe.
 * Lu aussi par la manœuvre dans l'espace (l'API (hors instantané)) : jusqu'où la
 * pose de départ, posée sur l'axe, peut glisser de côté pour tenir dans l'espace — un seul calage.
 */
export { SEED_BAND_M as OPEN_SPACE_AXIS_CALAGE_M } from './open-space-served.js';

/** Où chercher : la zone bornée, avant toute donnée. */
export interface OpenSpaceArea {
  /** L'axe de l'impasse, de la bouche vers le bout (`ImpasseGeometry.axis`). */
  readonly axis: readonly GeoPoint[];
  /** L'abscisse de l'arrêt le long de `axis` (`ImpasseGeometry.stopAlongM`) : la zone part de là. */
  readonly fromAlongM: number;
  /** Les lieux proposés par le moteur (options de demi-tour) : chacun ajoute un disque. */
  readonly places: readonly GeoPoint[];
  /** Demi-largeur du tampon et rayon des disques (policy `turnaroundMap.openSpace.radiusM`). */
  readonly radiusM: number;
  /** Là où le bâti a été lu : la zone n'en sort jamais. */
  readonly readDisc: { readonly centre: GeoPoint; readonly radiusM: number };
}

export interface OpenSpaceInput extends OpenSpaceArea {
  /** TOUTES les parcelles qui touchent l'emprise (`openSpaceExtent`) — une parcelle manquante se lirait libre. */
  readonly parcels: readonly OpenSpaceParcel[];
  /** L'anneau extérieur de chaque bâti lu dans `readDisc`. */
  readonly buildings: readonly (readonly GeoPoint[])[];
  /** les tronçons BD TOPO de l'emprise, qui coupent aux liens fermés; absents, pas de coupe. */
  readonly links?: OpenSpaceLinks;
}

export type OpenSpaceResult =
  | { readonly known: true; readonly value: OpenSpace }
  | { readonly known: false; readonly why: 'no_axis' | 'area_too_large' | 'axis_on_parcels' };

/**
 * L'axe de l'impasse de l'abscisse `fromAlongM` jusqu'à son bout (un seul point quand l'arrêt est au bout).
 * Exporté pour le couloir où se comptent les maisons au-delà de l'arrêt est le même bout d'axe.
 */
export function corridorOf(axis: readonly GeoPoint[], fromAlongM: number): GeoPoint[] {
  let travelled = 0;
  for (let k = 1; k < axis.length; k += 1) {
    const a = axis[k - 1]!;
    const b = axis[k]!;
    const length = haversineM(a, b);
    if (travelled + length > fromAlongM) {
      const t = length === 0 ? 0 : Math.max(0, (fromAlongM - travelled) / length);
      return [
        { lat: a.lat + t * (b.lat - a.lat), lon: a.lon + t * (b.lon - a.lon) },
        ...axis.slice(k),
      ];
    }
    travelled += length;
  }
  return axis.length === 0 ? [] : [axis[axis.length - 1]!];
}

function boxAround(points: readonly GeoPoint[], radiusM: number): GeoBox {
  const lats = points.map((p) => p.lat);
  const lons = points.map((p) => p.lon);
  const { dLat, dLon } = metresInDegrees(radiusM, (Math.min(...lats) + Math.max(...lats)) / 2);
  return {
    south: Math.min(...lats) - dLat,
    west: Math.min(...lons) - dLon,
    north: Math.max(...lats) + dLat,
    east: Math.max(...lons) + dLon,
  };
}

/**
 * L'emprise de la zone bornée, en degrés — celle des parcelles à lire. Null
 * sans axe, ou quand la zone sort entièrement du disque lu.
 */
export function openSpaceExtent(area: OpenSpaceArea): GeoBox | null {
  const corridor = corridorOf(area.axis, area.fromAlongM);
  if (corridor.length === 0) return null;
  const reach = boxAround([...corridor, ...area.places], area.radiusM);
  const disc = boxAround([area.readDisc.centre], area.readDisc.radiusM);
  const box = {
    south: Math.max(reach.south, disc.south),
    west: Math.max(reach.west, disc.west),
    north: Math.min(reach.north, disc.north),
    east: Math.min(reach.east, disc.east),
  };
  return box.south < box.north && box.west < box.east ? box : null;
}

/** 1 sur la zone bornée : le tampon de l'axe, les disques des lieux, coupés au disque lu. */
function areaMask(
  frame: GridFrame,
  corridor: readonly GeoPoint[],
  area: OpenSpaceArea,
): Uint8Array {
  const mask = new Uint8Array(frame.cols * frame.rows);
  stampPolyline(mask, frame, corridor, area.radiusM);
  for (const place of area.places) stampPolyline(mask, frame, [place], area.radiusM);
  const centre = toXY(frame, area.readDisc.centre);
  const limit = area.readDisc.radiusM * area.readDisc.radiusM;
  for (let k = 0; k < mask.length; k += 1) {
    if (mask[k] !== 1) continue;
    const x = ((k % frame.cols) + 0.5) * frame.cellM - centre.x;
    const y = (Math.floor(k / frame.cols) + 0.5) * frame.cellM - centre.y;
    if (x * x + y * y > limit) mask[k] = 0;
  }
  return mask;
}

/**
 * L'espace public relié à l'axe, dans la zone bornée. Pur : les parcelles et
 * les bâtis viennent de l'appelant, lus sur `openSpaceExtent(input)`.
 */
export function computeOpenSpace(input: OpenSpaceInput): OpenSpaceResult {
  const corridor = corridorOf(input.axis, input.fromAlongM);
  const box = openSpaceExtent(input);
  if (corridor.length === 0 || box === null) return { known: false, why: 'no_axis' };
  const frame = frameOf(box, OPEN_SPACE_CELL_M);
  if (frame.cols * frame.rows > MAX_CELLS) return { known: false, why: 'area_too_large' };
  const blocked = blockedMask(frame, input.parcels, input.buildings);
  const free = areaMask(frame, corridor, input).map((inArea, k) =>
    inArea === 1 && blocked[k] !== 1 ? 1 : 0,
  );
  const seeds = new Uint8Array(free.length);
  stampPolyline(seeds, frame, corridor, SEED_BAND_M);
  const space = servedSpace(frame, free, seeds, input.links);
  return space === null ? { known: false, why: 'axis_on_parcels' } : { known: true, value: space };
}
