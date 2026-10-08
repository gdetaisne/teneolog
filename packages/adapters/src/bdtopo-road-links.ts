/**
 * LES TRONÇONS BD TOPO D'UNE EMPRISE, et ceux qu'aucun véhicule ne
 * prend : ce qui coupe l'espace public (`@teneolog/topology`, `open-space-served.ts`).
 *
 * Le constat (2026-09-25, 7 Allée des Essais) : l'espace public du bout
 * de l'impasse rejoignait, par un passage de 4 m sur 22 m, la grande place de
 * l'Allée Voisine JC. La BD TOPO le dit : le tronçon TRONROUT0000000329102793
 * est une « Route à 1 chaussée » dont l'accès aux véhicules légers est
 * « Physiquement impossible ». Ce champ, `acces_vehicule_leger`, n'est PAS dans
 * la copie PostGIS de la BD TOPO (`bdtopo.roads` : nature, importance, largeur,
 * sens, restrictions, privé — relevé le 2026-09-25) ; il faudrait recharger les
 * 15 Go de `troncon_de_route.gpkg` pour l'y mettre. D'où la lecture au WFS de
 * la Géoplateforme, couche `BDTOPO_V3:troncon_de_route` — la même BD TOPO,
 * l'édition en ligne, sans clé, Licence Ouverte — par le transport des
 * parcelles (`cadastre-wfs.ts`), sur la même emprise, en parallèle d'elles.
 * Mesuré depuis le Mac le 2026-09-25 : 0,8–1,1 s et 16 ko pour 43 tronçons
 * (400 × 280 m, Sèvremoine), 1,8 s et 89 ko pour 223 tronçons (Paris 6e, 900 × 560 m)
 * — `PROPERTYNAME` réduit la réponse de 125 à 16 ko.
 *
 * Un tronçon est FERMÉ aux véhicules quand son accès VL est « Physiquement
 * impossible », ou quand sa nature est de celles qu'aucun véhicule à moteur ne
 * prend (`isClosedToAllVehiclesNature` : sentier, escalier, piste cyclable,
 * voie verte, chemin de halage — la liste dont celle du graphe du camion est
 * faite, principe 23). Une « Route empierrée » n'est pas fermée : le graphe du
 * camion l'écarte, une voiture y roule. « Restreint aux ayants droit » n'est
 * pas fermé non plus : un véhicule y passe. Un tronçon hors sol (`position_par_rapport_au_sol` ≠ 0 :
 * passerelle, tunnel) n'est rendu ni fermé ni ouvert : il ne dit rien du sol.
 *
 * Même discipline que les parcelles : un échec rend une inconnue NOMMÉE, jamais
 * une liste vide — un lien fermé manquant laisserait l'espace se prolonger par
 * un passage piéton, l'erreur dans le sens dangereux. `truncated` au-delà de la
 * limite ; `empty` quand l'emprise ne rend aucun tronçon (on ne la demande
 * jamais qu'autour d'une route) ; `malformed` pour un tronçon sans identifiant
 * ou sans géométrie lisible.
 */
import type { GeoPoint } from '@teneolog/domain';
import type { OpenSpaceLinks } from '@teneolog/topology';

import { isClosedToAllVehiclesNature } from './bdtopo-mapping.js';
import type { CadastreBbox } from './cadastre-parcels.js';
import { cadastreGet, CadastreFetchError, featureUrl } from './cadastre-wfs.js';

/** La couche des tronçons de route de la BD TOPO V3 sur le WFS de la Géoplateforme. */
export const BDTOPO_ROAD_LAYER = 'BDTOPO_V3:troncon_de_route';

/** Les seuls champs lus : l'identifiant, la nature, l'accès VL, la position et la géométrie. */
const PROPERTIES = 'cleabs,nature,acces_vehicule_leger,position_par_rapport_au_sol,geometrie';

/** La valeur d'`acces_vehicule_leger` qui ferme un tronçon. */
const CLOSED_ACCESS = 'Physiquement impossible';

export interface RoadLink {
  /** L'identifiant BD TOPO (`cleabs`, `TRONROUT…`). */
  readonly id: string;
  readonly nature: string | null;
  /** `acces_vehicule_leger` tel quel (`Libre`, `Physiquement impossible`, `Restreint aux ayants droit`…). */
  readonly lightVehicleAccess: string | null;
  readonly closedToVehicles: boolean;
  /** Le tracé, en lat/lon (un tronçon multiligne rend plusieurs lignes). */
  readonly lines: readonly (readonly GeoPoint[])[];
}

export type RoadLinksUnknown = 'timeout' | 'provider_error' | 'truncated' | 'empty' | 'malformed';

export type RoadLinksReading =
  | {
      readonly known: true;
      readonly value: { readonly links: readonly RoadLink[]; readonly fetchMs: number };
    }
  | { readonly known: false; readonly why: RoadLinksUnknown; readonly fetchMs: number | null };

export interface RoadLinksOptions {
  readonly timeoutMs: number;
  /** Au plus tant de tronçons ; au-delà, la lecture est `truncated`, jamais partielle. */
  readonly limit: number;
}

export interface RoadLinksPort {
  /** Tous les tronçons au sol qui touchent l'emprise. */
  linksInBbox(bbox: CadastreBbox, options: RoadLinksOptions): Promise<RoadLinksReading>;
}

type Position = readonly [number, number];

function isPosition(value: unknown): value is Position {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    Number.isFinite(value[0]) &&
    Number.isFinite(value[1])
  );
}

/** Une ligne GeoJSON [lon, lat, z] → des points lat/lon ; null si elle est illisible. */
function lineOf(coordinates: unknown): GeoPoint[] | null {
  if (!Array.isArray(coordinates) || coordinates.length < 2 || !coordinates.every(isPosition))
    return null;
  return (coordinates as Position[]).map(([lon, lat]) => ({ lat, lon }));
}

/** Les lignes d'une géométrie LineString / MultiLineString ; null dès qu'une est illisible. */
function linesOf(geometry: unknown): GeoPoint[][] | null {
  const { type, coordinates } = (geometry ?? {}) as {
    readonly type?: unknown;
    readonly coordinates?: unknown;
  };
  const raw =
    type === 'LineString'
      ? [coordinates]
      : type === 'MultiLineString' && Array.isArray(coordinates)
        ? coordinates
        : null;
  if (raw === null || raw.length === 0) return null;
  const lines = raw.map(lineOf);
  return lines.every((line): line is GeoPoint[] => line !== null) ? lines : null;
}

const textOf = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** Un tronçon GeoJSON → le lien, `'aerial'` quand il est hors sol, null quand il est illisible. */
function linkOf(feature: unknown): RoadLink | 'aerial' | null {
  const { properties, geometry } = (feature ?? {}) as {
    readonly properties?: Record<string, unknown> | null;
    readonly geometry?: unknown;
  };
  const id = textOf(properties?.['cleabs']);
  const lines = linesOf(geometry);
  if (id === null || id === '' || lines === null) return null;
  const position = textOf(properties?.['position_par_rapport_au_sol']);
  if (position !== null && position !== '0') return 'aerial';
  const nature = textOf(properties?.['nature']);
  const lightVehicleAccess = textOf(properties?.['acces_vehicule_leger']);
  return {
    id,
    nature,
    lightVehicleAccess,
    closedToVehicles: lightVehicleAccess === CLOSED_ACCESS || isClosedToAllVehiclesNature(nature),
    lines,
  };
}

export type RoadLinkCollectionReading =
  | { readonly known: true; readonly links: readonly RoadLink[] }
  | { readonly known: false; readonly why: 'truncated' | 'empty' | 'malformed' };

/**
 * Le corps GeoJSON d'un GetFeature → les tronçons au sol, ou la raison de n'en
 * rien croire. Pur, testable sans réseau. Un tronçon illisible rend TOUTE la
 * lecture illisible : le lâcher en silence pourrait taire un passage fermé.
 */
export function readRoadLinkCollection(body: string, limit: number): RoadLinkCollectionReading {
  let parsed: { readonly features?: unknown; readonly numberMatched?: unknown };
  try {
    parsed = JSON.parse(body) as typeof parsed;
  } catch {
    return { known: false, why: 'malformed' };
  }
  const { features, numberMatched } = parsed;
  if (!Array.isArray(features)) return { known: false, why: 'malformed' };
  if (
    features.length > limit ||
    (typeof numberMatched === 'number' && numberMatched > features.length)
  )
    return { known: false, why: 'truncated' };
  if (features.length === 0) return { known: false, why: 'empty' };
  const read = features.map(linkOf);
  if (read.includes(null)) return { known: false, why: 'malformed' };
  return { known: true, links: read.filter((link): link is RoadLink => link !== null && link !== 'aerial') };
}

/** Les tracés, partagés entre ceux qui coupent l'espace public et ceux qui le gardent. */
export function openSpaceLinksOf(links: readonly RoadLink[]): OpenSpaceLinks {
  return {
    closed: links.filter((link) => link.closedToVehicles).flatMap((link) => link.lines),
    open: links.filter((link) => !link.closedToVehicles).flatMap((link) => link.lines),
  };
}

export class GeoplateformeRoadLinks implements RoadLinksPort {
  constructor(private readonly options: { readonly wfsUrl: string }) {}

  async linksInBbox(bbox: CadastreBbox, options: RoadLinksOptions): Promise<RoadLinksReading> {
    const started = Date.now();
    const url = featureUrl(this.options.wfsUrl, BDTOPO_ROAD_LAYER, options.limit + 1, { bbox });
    url.searchParams.set('PROPERTYNAME', PROPERTIES);
    try {
      const read = readRoadLinkCollection(await cadastreGet(url, options.timeoutMs), options.limit);
      if (!read.known) return { known: false, why: read.why, fetchMs: Date.now() - started };
      return { known: true, value: { links: read.links, fetchMs: Date.now() - started } };
    } catch (error) {
      const why = error instanceof CadastreFetchError ? error.why : 'provider_error';
      return { known: false, why, fetchMs: Date.now() - started };
    }
  }
}
