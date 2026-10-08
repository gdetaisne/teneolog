/**
 * LE CHAMP LE PLUS PROCHE, dans le Registre Parcellaire
 * Graphique (RPG) : les parcelles agricoles déclarées à la PAC, publiées par
 * l'IGN sur le WFS de la Géoplateforme, sans clé.
 *
 * Une seule question : y a-t-il un champ déclaré à moins de `radiusM` du point
 * de livraison, et à quelle distance est le plus proche ? C'est l'un des trois
 * faits de la règle « rural, route locale » (l'API (hors instantané));
 * aucune règle ici.
 *
 * La couche est `RPG.LATEST:parcelles_graphiques` — la dernière campagne publiée
 * (vérifié le 2026-09-28 : GetCapabilities liste RPG.2015 à RPG.2024 et
 * RPG.LATEST ; un GetFeature à 300 m de La Crèche répond en ~0,7 s depuis le
 * Mac). Toute parcelle compte, prairie permanente comprise : un pré est un champ.
 *
 * La lecture se fait par EMPRISE (le BBOX standard de WFS 2.0, en lat/lon), puis
 * la distance se mesure au polygone, comme pour le cadastre (`distanceToParcelM`) : 0 dedans,
 * au bord sinon. Pas de
 * `DWITHIN` en CQL — l'unité d'une distance sur une couche en degrés dépend du
 * serveur, et une emprise ne ment pas.
 *
 * Trois issues, jamais une quatrième qui se tairait (principe 14) : un champ à
 * telle distance ; `nearestM: null`, « lu, aucun champ dans le rayon » ; une
 * inconnue nommée (délai, panne, réponse illisible). Une lecture COUPÉE par
 * `limit` n'est pas une inconnue si un champ lu tombe déjà dans le rayon — il
 * existe, c'est tout ce que la règle demande — mais elle le dit (`truncated`),
 * et la distance publiée n'est alors qu'une borne haute.
 */
import type { GeoPoint } from '@teneolog/domain';

import { bboxAround, distanceToParcelM } from './cadastre-parcels.js';
import { CadastreFetchError, cadastreGet, featureUrl } from './cadastre-wfs.js';

export const RPG_LAYER = 'RPG.LATEST:parcelles_graphiques';

export interface RpgFieldsOptions {
  readonly radiusM: number;
  readonly timeoutMs: number;
  /** Au plus tant de parcelles lues ; au-delà, la lecture est dite coupée. */
  readonly limit: number;
}

export interface NearestField {
  /** Distance du point au champ le plus proche lu ; null : aucun dans le rayon. */
  readonly nearestM: number | null;
  /** Le code culture de ce champ (`code_cultu`), pour l'onglet. */
  readonly cultureCode: string | null;
  readonly fieldsRead: number;
  readonly radiusM: number;
  readonly truncated: boolean;
  readonly layer: string;
  readonly fetchMs: number;
}

export type RpgFieldsUnknown = 'timeout' | 'provider_error' | 'malformed' | 'truncated';

export type RpgFieldsReading =
  | { readonly known: true; readonly value: NearestField }
  | { readonly known: false; readonly why: RpgFieldsUnknown; readonly fetchMs: number | null };

export interface RpgFieldsPort {
  nearestField(centre: GeoPoint, options: RpgFieldsOptions): Promise<RpgFieldsReading>;
}

type Ring = readonly GeoPoint[];

function ringOf(coordinates: unknown): Ring | null {
  if (!Array.isArray(coordinates)) return null;
  const points: GeoPoint[] = [];
  for (const position of coordinates) {
    if (!Array.isArray(position)) continue;
    const [lon, lat] = position as unknown[];
    if (typeof lon === 'number' && typeof lat === 'number') points.push({ lat, lon });
  }
  return points.length >= 3 ? points : null;
}

/** Les polygones d'un Polygon ou d'un MultiPolygon GeoJSON : [extérieur, ...trous]. */
function polygonsOf(geometry: unknown): Ring[][] {
  const g = geometry as { readonly type?: unknown; readonly coordinates?: unknown } | null;
  if (g === null || typeof g !== 'object' || !Array.isArray(g.coordinates)) return [];
  const polygons: unknown[] = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
  return polygons
    .map((polygon) => (Array.isArray(polygon) ? polygon.map(ringOf).filter((r): r is Ring => r !== null) : []))
    .filter((rings) => rings.length > 0);
}

type Feature = { readonly geometry?: unknown; readonly properties?: unknown };

/** Le champ le plus proche parmi ceux lus, dans le rayon ; null quand aucun. */
function nearestOf(
  features: readonly Feature[],
  centre: GeoPoint,
  radiusM: number,
): { readonly distanceM: number; readonly cultureCode: string | null } | null {
  let best: { distanceM: number; cultureCode: string | null } | null = null;
  for (const feature of features) {
    const polygons = polygonsOf(feature?.geometry);
    if (polygons.length === 0) continue;
    // La distance d'une parcelle au point : celle du cadastre, trous compris (une source, principe 23).
    const distanceM = distanceToParcelM(centre, { idu: 'rpg', polygons });
    if (distanceM > radiusM || (best !== null && distanceM >= best.distanceM)) continue;
    const code = (feature.properties as Record<string, unknown> | null)?.['code_cultu'];
    best = { distanceM, cultureCode: typeof code === 'string' ? code : null };
  }
  return best;
}

/** Du corps GeoJSON à la lecture publiée — testable sans réseau. */
export function readNearestField(
  body: string,
  centre: GeoPoint,
  options: Pick<RpgFieldsOptions, 'radiusM' | 'limit'>,
  fetchMs: number,
): RpgFieldsReading {
  let parsed: { readonly features?: unknown };
  try {
    parsed = JSON.parse(body) as typeof parsed;
  } catch {
    return { known: false, why: 'malformed', fetchMs };
  }
  if (!Array.isArray(parsed.features)) return { known: false, why: 'malformed', fetchMs };
  const truncated = parsed.features.length > options.limit;
  const read = parsed.features.slice(0, options.limit) as Feature[];
  const nearest = nearestOf(read, centre, options.radiusM);
  // Coupée et rien dans le rayon : un champ non lu pourrait y être — inconnu.
  if (truncated && nearest === null) return { known: false, why: 'truncated', fetchMs };
  return {
    known: true,
    value: {
      nearestM: nearest === null ? null : Math.round(nearest.distanceM * 10) / 10,
      cultureCode: nearest?.cultureCode ?? null,
      fieldsRead: read.length,
      radiusM: options.radiusM,
      truncated,
      layer: RPG_LAYER,
      fetchMs,
    },
  };
}

export class GeoplateformeRpgFields implements RpgFieldsPort {
  constructor(private readonly options: { readonly wfsUrl: string }) {}

  async nearestField(centre: GeoPoint, options: RpgFieldsOptions): Promise<RpgFieldsReading> {
    const started = Date.now();
    const bbox = bboxAround(centre, options.radiusM);
    const url = featureUrl(this.options.wfsUrl, RPG_LAYER, options.limit + 1, { bbox });
    url.searchParams.set('PROPERTYNAME', 'code_cultu,geom');
    try {
      const body = await cadastreGet(url, options.timeoutMs);
      return readNearestField(body, centre, options, Date.now() - started);
    } catch (error) {
      const why = error instanceof CadastreFetchError ? error.why : 'provider_error';
      return { known: false, why, fetchMs: Date.now() - started };
    }
  }
}
