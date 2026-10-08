/**
 * LES AIRES OÙ UN CAMION NE MANŒUVRE PAS, lues dans OSM : une place
 * piétonne, un parc, une pelouse. Le cadastre les compte dans le domaine public
 * (c'est vrai) et l'espace public servi les garde (son pointillé dit « pas tout
 * roulable ») ; le demi-tour, lui, ne s'y cherche pas. Le 2026-09-25, au 5 Rue
 * Témoin à Clichy, le planificateur faisait faire au 19 t un demi-tour en un
 * temps sur la place Voisine JC (OSM way 117624157 : highway=pedestrian,
 * area=yes, pavés, un arbre au milieu).
 *
 * LA LISTE DES ÉTIQUETTES, une fois (principe 23) : `NON_DRIVABLE_AREA_TAGS`,
 * dans `@teneolog/topology` depuis S1 la lit aussi, pour ne plus
 * proposer une place piétonne comme lieu de demi-tour.
 * `highway=pedestrian|footway` ne compte qu'en aire (`area=yes`, ou un
 * multipolygone) : fermé sans `area=yes`, c'est une boucle de rue piétonne,
 * pas une surface.
 *
 * Un multipolygone se lit par ses membres `outer`, raboutés bout à bout ; ses
 * `inner` ne sont pas rendus (une cour, un massif au milieu d'une place n'en
 * deviennent pas roulables) ; un membre qui ne se referme pas est laissé de
 * côté.
 */
import type { GeoPoint } from '@teneolog/domain';
import { NON_DRIVABLE_AREA_TAGS } from '@teneolog/topology';

import type { OverpassElement, OverpassElementGeom, OverpassPayload } from './overpass-mapping.js';

/** Une boîte de lecture, en degrés. */
export interface NonDrivableBox {
  readonly south: number;
  readonly west: number;
  readonly north: number;
  readonly east: number;
}

/** Les aires non roulables d'une boîte, un anneau par aire (le contour extérieur). */
export interface NonDrivableAreasPort {
  /** Rejette quand la lecture échoue : une panne n'est pas « aucune aire » (principe 14). */
  fetchNonDrivableAreas(box: NonDrivableBox): Promise<readonly (readonly GeoPoint[])[]>;
}

/** La requête Overpass : les chemins fermés et les multipolygones de la liste, dans la boîte. */
export function nonDrivableQuery(box: NonDrivableBox, timeoutS: number): string {
  const bbox = `(${box.south},${box.west},${box.north},${box.east})`;
  const lines = NON_DRIVABLE_AREA_TAGS.flatMap(({ key, values, areaOnly }) => {
    const tag = `["${key}"~"^(${values.join('|')})$"]`;
    return [`  way${tag}${areaOnly ? '["area"="yes"]' : ''}${bbox};`, `  relation${tag}["type"="multipolygon"]${bbox};`];
  });
  return `[out:json][timeout:${timeoutS}];\n(\n${lines.join('\n')}\n);\nout body geom;`;
}

const same = (a: OverpassElementGeom, b: OverpassElementGeom): boolean => a.lat === b.lat && a.lon === b.lon;

/** Un anneau fermé (au moins trois sommets distincts), sans répéter le premier sommet. */
function ringOf(points: readonly OverpassElementGeom[]): GeoPoint[] | null {
  if (points.length < 4 || !same(points[0]!, points[points.length - 1]!)) return null;
  return points.slice(0, -1).map((p) => ({ lat: p.lat, lon: p.lon }));
}

/** Les membres `outer` d'un multipolygone, raboutés bout à bout en anneaux fermés. */
function outerRings(element: OverpassElement): GeoPoint[][] {
  const open = (element.members ?? [])
    .filter((m) => m.type === 'way' && m.role === 'outer' && (m.geometry?.length ?? 0) >= 2)
    .map((m) => [...m.geometry!]);
  const rings: GeoPoint[][] = [];
  while (open.length > 0) {
    const chain = open.shift()!;
    for (let joined = true; joined && !same(chain[0]!, chain[chain.length - 1]!); ) {
      joined = false;
      const end = chain[chain.length - 1]!;
      const k = open.findIndex((m) => same(m[0]!, end) || same(m[m.length - 1]!, end));
      if (k < 0) break;
      const next = open.splice(k, 1)[0]!;
      chain.push(...(same(next[0]!, end) ? next : [...next].reverse()).slice(1));
      joined = true;
    }
    const ring = ringOf(chain);
    if (ring !== null) rings.push(ring);
  }
  return rings;
}

/** Les anneaux de la réponse : un chemin fermé, ou les contours extérieurs d'un multipolygone. */
export function mapNonDrivableAreas(payload: OverpassPayload): GeoPoint[][] {
  const rings: GeoPoint[][] = [];
  for (const element of payload.elements) {
    if (element.type === 'way') {
      const ring = ringOf(element.geometry ?? []);
      if (ring !== null) rings.push(ring);
    } else if (element.type === 'relation') {
      rings.push(...outerRings(element));
    }
  }
  return rings;
}
