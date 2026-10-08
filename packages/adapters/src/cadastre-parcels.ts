/**
 * LES PARCELLES DU CADASTRE : un lecteur général (une emprise, un
 * rayon autour d'un point, une parcelle par son identifiant), sans rien savoir
 * de l'impasse. L'espace public au bout de l'impasse se calcule AU-DESSUS, dans
 * une fonction pure (`@teneolog/topology`, `open-space.ts`) ; le portage
 * lit les mêmes parcelles — une source, principe 23.
 *
 * Pourquoi le cadastre : à la Sèvremoine (2026-09-25), un 19 t fait demi-tour en
 * trois temps dans une placette publique de ~12,5 × 14,9 m qu'AUCUNE donnée lue
 * ne porte — OSM y dessine 13 m de ligne, la BD TOPO l'ignore. Seul le cadastre
 * la montre : du domaine public, que ne couvre aucune parcelle.
 *
 * La source, vérifiée le 2026-09-25 : le WFS de la Géoplateforme IGN
 * (`https://data.geopf.fr/wfs/ows`), couche `CADASTRALPARCELS.PARCELLAIRE_EXPRESS:parcelle`
 * — le PCI vecteur de la DGFiP (« Parcellaire Express »), Licence Ouverte 2.0,
 * servi SANS CLÉ (guide cartes.gouv.fr « OGR » : usage « de l'ordre de 5 000
 * objets » par requête ; `CountDefault` 5 000 aux capacités). Choisi plutôt que
 * l'API Carto (`apicarto.ign.fr/api/cadastre`, qui relaie ce même WFS) — un
 * relais de moins — et plutôt que l'index `parcel` du géocodeur, qui rend sa
 * géométrie en chaîne à la Python (`truegeometry`, guillemets simples) et
 * répond 400 à un identifiant mal formé. Mesuré depuis le Mac le même jour :
 * 1,0–2,9 s pour une emprise de 240 × 240 m (106 à 219 parcelles, 74 à 143 ko ;
 * Sèvremoine, Paris 16e et 18e, Bordeaux), 0,8–1,8 s pour une parcelle par
 * identifiant. L'édition se lit aux capacités du WFS filtrées par espace de noms
 * (`<Abstract>Parcelles ; Édition 2026-06-01</Abstract>`, 171 ko, ~1,7 s) : une
 * édition nationale, trimestrielle — lue une fois et gardée en mémoire.
 *
 * Même discipline que les emprises du bâti (`bdtopo-building-rings.ts`) : le
 * délai part avec la requête, un minuteur est le filet ; un échec rend une
 * inconnue NOMMÉE, jamais une liste vide. Ici c'est plus grave qu'ailleurs :
 * une parcelle manquante se lirait « espace public » — l'erreur dans le sens
 * dangereux. D'où trois refus de plus :
 *  - `truncated` : plus de parcelles que la limite → pas de liste partielle ;
 *  - `empty` : aucune parcelle dans l'emprise — une commune au plan non
 *    vectorisé, ou un service qui répond à vide ; jamais « tout est public » ;
 *  - `malformed` : un corps illisible, une parcelle sans identifiant national,
 *    ou une parcelle dont l'ENVELOPPE ne coupe pas l'emprise demandée (élargie
 *    d'un dixième). Le filtre BBOX du WFS ne rend que des parcelles qui la
 *    coupent ; une parcelle ailleurs dit un ordre des axes inversé par le
 *    service. L'enveloppe, et pas un sommet : une emprise posée au milieu d'un
 *    champ, d'un entrepôt ou d'une zone d'activité n'a aucun sommet de parcelle
 *    à proximité, et la lecture est pourtant juste (relecture du 2026-09-25 :
 *    (47.13523, −0.93858) à 20 m, dans la parcelle agricole de 11 ha).
 */
import type { GeoPoint } from '@teneolog/domain';

import {
  cadastreGet,
  CadastreFetchError,
  capabilitiesUrl,
  featureUrl,
  idFilter,
} from './cadastre-wfs.js';

/** Le WFS public de la Géoplateforme (sans clé). */
export const GEOPLATEFORME_WFS_URL = 'https://data.geopf.fr/wfs/ows';

/** La couche des parcelles du PCI vecteur (Parcellaire Express). */
export const CADASTRE_PARCEL_LAYER = 'CADASTRALPARCELS.PARCELLAIRE_EXPRESS:parcelle';

/**
 * L'identifiant national d'une parcelle (`idu`), 14 caractères : département
 * (2, `2A`/`2B` en Corse), commune (3), préfixe (3), section (2), numéro (4) —
 * `49301000AH0127`. Un identifiant d'une autre forme n'est jamais envoyé.
 */
export const PARCEL_IDU_PATTERN = /^[0-9][0-9AB][0-9]{3}[0-9]{3}[0-9A-Z]{2}[0-9]{4}$/;

/** Une emprise en degrés WGS84. */
export interface CadastreBbox {
  readonly south: number;
  readonly west: number;
  readonly north: number;
  readonly east: number;
}

export interface CadastreParcel {
  /** L'identifiant national (`49301000AH0127`). */
  readonly idu: string;
  /** Chaque polygone : [anneau extérieur, ...trous], en lat/lon, sans le sommet de fermeture. */
  readonly polygons: readonly (readonly (readonly GeoPoint[])[])[];
}

/** Une parcelle lue autour d'un point : sa distance au point, 0 quand elle le contient. */
export interface CadastreParcelNear extends CadastreParcel {
  readonly distanceM: number;
}

export interface CadastreParcels<P extends CadastreParcel = CadastreParcel> {
  readonly parcels: readonly P[];
  /** L'édition du PCI (`YYYY-MM-DD`), null quand les capacités ne l'ont pas dite. */
  readonly vintage: string | null;
  readonly fetchMs: number;
}

export type CadastreUnknown = 'timeout' | 'provider_error' | 'truncated' | 'empty' | 'malformed';

export type CadastreParcelsReading<P extends CadastreParcel = CadastreParcel> =
  | { readonly known: true; readonly value: CadastreParcels<P> }
  | { readonly known: false; readonly why: CadastreUnknown; readonly fetchMs: number | null };

export type CadastreParcelReading =
  | {
      readonly known: true;
      readonly value: {
        readonly parcel: CadastreParcel;
        readonly vintage: string | null;
        readonly fetchMs: number;
      };
    }
  | {
      readonly known: false;
      readonly why: 'timeout' | 'provider_error' | 'malformed' | 'invalid_id' | 'not_found';
      readonly fetchMs: number | null;
    };

export interface CadastreParcelsOptions {
  /** Le budget de la lecture (pour la carte du demi-tour : policy `turnaroundMap.openSpace.timeoutMs`). */
  readonly timeoutMs: number;
  /** Au plus tant de parcelles ; au-delà, la lecture est `truncated`, jamais partielle. */
  readonly limit: number;
}

export interface CadastreParcelsPort {
  /** Toutes les parcelles qui touchent l'emprise, entières. */
  parcelsInBbox(
    bbox: CadastreBbox,
    options: CadastreParcelsOptions,
  ): Promise<CadastreParcelsReading>;
  /** Les parcelles à au plus `radiusM` du point, la plus proche d'abord (celle qui le contient à 0 m). */
  parcelsNear(
    centre: GeoPoint,
    radiusM: number,
    options: CadastreParcelsOptions,
  ): Promise<CadastreParcelsReading<CadastreParcelNear>>;
  /** Une parcelle par son identifiant national. */
  parcelById(
    idu: string,
    options: Pick<CadastreParcelsOptions, 'timeoutMs'>,
  ): Promise<CadastreParcelReading>;
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

/** Un anneau GeoJSON [lon, lat] → des points lat/lon, sans le sommet de fermeture ; null s'il est illisible. */
function ringOf(coordinates: unknown): GeoPoint[] | null {
  if (!Array.isArray(coordinates) || !coordinates.every(isPosition)) return null;
  const points = (coordinates as Position[]).map(([lon, lat]) => ({ lat, lon }));
  const first = points[0];
  const last = points[points.length - 1];
  if (
    first !== undefined &&
    last !== undefined &&
    points.length > 1 &&
    first.lat === last.lat &&
    first.lon === last.lon
  ) {
    points.pop();
  }
  return points.length >= 3 ? points : null;
}

function polygonOf(rings: unknown): GeoPoint[][] | null {
  if (!Array.isArray(rings) || rings.length === 0) return null;
  const read = rings.map(ringOf);
  return read.every((ring): ring is GeoPoint[] => ring !== null) ? read : null;
}

/** Les polygones d'une géométrie Polygon / MultiPolygon ; null dès qu'un anneau est illisible. */
function polygonsOf(geometry: unknown): GeoPoint[][][] | null {
  const { type, coordinates } = (geometry ?? {}) as {
    readonly type?: unknown;
    readonly coordinates?: unknown;
  };
  const raw =
    type === 'Polygon'
      ? [coordinates]
      : type === 'MultiPolygon' && Array.isArray(coordinates)
        ? coordinates
        : null;
  if (raw === null || raw.length === 0) return null;
  const polygons = raw.map(polygonOf);
  return polygons.every((p): p is GeoPoint[][] => p !== null) ? polygons : null;
}

/** Une parcelle GeoJSON → identifiant national et polygones ; null quand l'un des deux manque. */
function parcelOf(feature: unknown): CadastreParcel | null {
  const { properties, geometry } = (feature ?? {}) as {
    readonly properties?: unknown;
    readonly geometry?: unknown;
  };
  const idu = (properties as { readonly idu?: unknown } | null | undefined)?.idu;
  const polygons = polygonsOf(geometry);
  if (typeof idu !== 'string' || !PARCEL_IDU_PATTERN.test(idu) || polygons === null) return null;
  return { idu, polygons };
}

/** L'enveloppe d'une parcelle : ses latitudes et longitudes extrêmes, tous anneaux compris. */
function envelopeOf(parcel: CadastreParcel): CadastreBbox {
  const box = { south: Infinity, west: Infinity, north: -Infinity, east: -Infinity };
  for (const p of parcel.polygons.flat(2)) {
    box.south = Math.min(box.south, p.lat);
    box.north = Math.max(box.north, p.lat);
    box.west = Math.min(box.west, p.lon);
    box.east = Math.max(box.east, p.lon);
  }
  return box;
}

function intersects(a: CadastreBbox, b: CadastreBbox): boolean {
  return a.south <= b.north && b.south <= a.north && a.west <= b.east && b.west <= a.east;
}

/**
 * Vrai quand l'enveloppe de CHAQUE parcelle coupe l'emprise élargie d'un
 * dixième : le WFS ne rend que ce qui la coupe, et l'ordre des axes est le bon.
 */
function allCrossBbox(parcels: readonly CadastreParcel[], bbox: CadastreBbox): boolean {
  const padLat = (bbox.north - bbox.south) / 10;
  const padLon = (bbox.east - bbox.west) / 10;
  const box = {
    south: bbox.south - padLat,
    north: bbox.north + padLat,
    west: bbox.west - padLon,
    east: bbox.east + padLon,
  };
  return parcels.every((parcel) => intersects(envelopeOf(parcel), box));
}

export type ParcelCollectionReading =
  | { readonly known: true; readonly parcels: readonly CadastreParcel[] }
  | { readonly known: false; readonly why: 'truncated' | 'empty' | 'malformed' };

function featuresOf(
  body: string,
): { readonly features: readonly unknown[]; readonly matched: unknown } | null {
  try {
    const parsed = JSON.parse(body) as {
      readonly features?: unknown;
      readonly numberMatched?: unknown;
    };
    return Array.isArray(parsed.features)
      ? { features: parsed.features, matched: parsed.numberMatched }
      : null;
  } catch {
    return null;
  }
}

/**
 * Le corps GeoJSON d'un GetFeature → les parcelles, ou la raison de n'en rien
 * croire. Pur, testable sans réseau. Une parcelle illisible rend TOUTE la
 * lecture illisible : la lâcher en silence la ferait passer pour du public.
 * `bbox` null : pas de contrôle d'emprise (lecture par identifiant).
 */
export function readParcelCollection(
  body: string,
  bbox: CadastreBbox | null,
  limit: number,
): ParcelCollectionReading {
  const read = featuresOf(body);
  if (read === null) return { known: false, why: 'malformed' };
  const { features, matched } = read;
  if (features.length > limit || (typeof matched === 'number' && matched > features.length))
    return { known: false, why: 'truncated' };
  if (features.length === 0) return { known: false, why: 'empty' };
  const parcels = features.map(parcelOf);
  if (!parcels.every((p): p is CadastreParcel => p !== null))
    return { known: false, why: 'malformed' };
  return bbox === null || allCrossBbox(parcels, bbox)
    ? { known: true, parcels }
    : { known: false, why: 'malformed' };
}

/**
 * L'édition du PCI dans les capacités WFS : l'`Abstract` de la couche des
 * parcelles se termine par « Édition AAAA-MM-JJ ». Null quand elle n'y est pas.
 */
export function readCadastreVintage(capabilities: string): string | null {
  const at = capabilities.indexOf(`<Name>${CADASTRE_PARCEL_LAYER}</Name>`);
  if (at < 0) return null;
  const end = capabilities.indexOf('</FeatureType>', at);
  const block = capabilities.slice(at, end < 0 ? undefined : end);
  return block.match(/<Abstract>[^<]*?(\d{4}-\d{2}-\d{2})[^<]*<\/Abstract>/)?.[1] ?? null;
}

/** L'emprise d'un disque de `radiusM` autour de `centre`. */
export function bboxAround(centre: GeoPoint, radiusM: number): CadastreBbox {
  const dLat = radiusM / M_PER_DEG_LAT;
  const dLon = dLat / Math.cos((centre.lat * Math.PI) / 180);
  return {
    south: centre.lat - dLat,
    west: centre.lon - dLon,
    north: centre.lat + dLat,
    east: centre.lon + dLon,
  };
}

/** Mètres par degré de latitude — la sphère de `haversineM`. */
const M_PER_DEG_LAT = (6_371_008.8 * Math.PI) / 180;

/**
 * La distance d'un point à une parcelle, en mètres (repère local
 * équirectangulaire au point, assez juste à quelques centaines de mètres) :
 * 0 quand le point est dedans (règle pair-impair, trous compris).
 */
export function distanceToParcelM(centre: GeoPoint, parcel: CadastreParcel): number {
  const kLon = M_PER_DEG_LAT * Math.cos((centre.lat * Math.PI) / 180);
  const xy = (p: GeoPoint): readonly [number, number] => [
    (p.lon - centre.lon) * kLon,
    (p.lat - centre.lat) * M_PER_DEG_LAT,
  ];
  let best = Infinity;
  let inside = false;
  for (const ring of parcel.polygons.flat()) {
    for (let k = 0, prev = ring.length - 1; k < ring.length; prev = k, k += 1) {
      const [ax, ay] = xy(ring[prev]!);
      const [bx, by] = xy(ring[k]!);
      if (ay > 0 !== by > 0 && 0 < ax + ((0 - ay) * (bx - ax)) / (by - ay)) inside = !inside;
      best = Math.min(best, segmentToOriginM(ax, ay, bx, by));
    }
  }
  return inside ? 0 : best;
}

function segmentToOriginM(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lenSq));
  return Math.hypot(ax + t * dx, ay + t * dy);
}

/**
 * Une édition trimestrielle : relue au plus toutes les douze heures — constante
 * d'EXPLOITATION, pas une mesure. Un échec n'est jamais gardé.
 */
const VINTAGE_TTL_MS = 12 * 60 * 60 * 1000;

const failureOf = (error: unknown): 'timeout' | 'provider_error' =>
  error instanceof CadastreFetchError ? error.why : 'provider_error';

export class GeoplateformeCadastre implements CadastreParcelsPort {
  private vintage: { readonly value: string; readonly readAt: number } | null = null;

  constructor(private readonly options: { readonly wfsUrl: string }) {}

  async parcelsInBbox(
    bbox: CadastreBbox,
    options: CadastreParcelsOptions,
  ): Promise<CadastreParcelsReading> {
    const started = Date.now();
    const vintage = this.readVintage(options.timeoutMs);
    try {
      const body = await cadastreGet(
        featureUrl(this.options.wfsUrl, CADASTRE_PARCEL_LAYER, options.limit + 1, { bbox }),
        options.timeoutMs,
      );
      const read = readParcelCollection(body, bbox, options.limit);
      if (!read.known) return { known: false, why: read.why, fetchMs: Date.now() - started };
      return {
        known: true,
        value: { parcels: read.parcels, vintage: await vintage, fetchMs: Date.now() - started },
      };
    } catch (error) {
      return { known: false, why: failureOf(error), fetchMs: Date.now() - started };
    }
  }

  async parcelsNear(
    centre: GeoPoint,
    radiusM: number,
    options: CadastreParcelsOptions,
  ): Promise<CadastreParcelsReading<CadastreParcelNear>> {
    const reading = await this.parcelsInBbox(bboxAround(centre, radiusM), options);
    if (!reading.known) return reading;
    const parcels = reading.value.parcels
      .map((parcel) => ({ ...parcel, distanceM: distanceToParcelM(centre, parcel) }))
      .filter((parcel) => parcel.distanceM <= radiusM)
      .sort((a, b) => a.distanceM - b.distanceM);
    return { known: true, value: { ...reading.value, parcels } };
  }

  async parcelById(
    idu: string,
    options: Pick<CadastreParcelsOptions, 'timeoutMs'>,
  ): Promise<CadastreParcelReading> {
    if (!PARCEL_IDU_PATTERN.test(idu)) return { known: false, why: 'invalid_id', fetchMs: null };
    const started = Date.now();
    const vintage = this.readVintage(options.timeoutMs);
    try {
      const body = await cadastreGet(
        featureUrl(this.options.wfsUrl, CADASTRE_PARCEL_LAYER, 2, { filter: idFilter(idu) }),
        options.timeoutMs,
      );
      const read = readParcelCollection(body, null, 1);
      const parcel = read.known ? read.parcels[0] : undefined;
      // Aucune parcelle : l'identifiant n'existe pas (ou plus) ; une autre parcelle, ou deux : le service a mal répondu.
      if (!read.known && read.why === 'empty')
        return { known: false, why: 'not_found', fetchMs: Date.now() - started };
      if (parcel?.idu !== idu)
        return { known: false, why: 'malformed', fetchMs: Date.now() - started };
      return {
        known: true,
        value: { parcel, vintage: await vintage, fetchMs: Date.now() - started },
      };
    } catch (error) {
      return { known: false, why: failureOf(error), fetchMs: Date.now() - started };
    }
  }

  /** L'édition, en parallèle des parcelles et sous le même budget ; null sans elle — jamais un échec de la lecture. */
  private async readVintage(timeoutMs: number): Promise<string | null> {
    const cached = this.vintage;
    if (cached !== null && Date.now() - cached.readAt < VINTAGE_TTL_MS) return cached.value;
    try {
      const value = readCadastreVintage(
        await cadastreGet(capabilitiesUrl(this.options.wfsUrl, CADASTRE_PARCEL_LAYER), timeoutMs),
      );
      if (value !== null) this.vintage = { value, readAt: Date.now() };
      return value;
    } catch {
      return null;
    }
  }
}
