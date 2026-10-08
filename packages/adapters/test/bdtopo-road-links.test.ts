/**
 * les tronçons BD TOPO d'une emprise (WFS Géoplateforme,
 * `BDTOPO_V3:troncon_de_route`) et ceux qu'aucun véhicule ne prend : la lecture
 * du GeoJSON, les refus qui empêchent un passage piéton manquant de laisser
 * l'espace public se prolonger, et le transport borné. Aucun réseau : `fetch`
 * est un script (`vi.stubGlobal`, comme `cadastre-parcels.test.ts`).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  GeoplateformeRoadLinks,
  openSpaceLinksOf,
  readRoadLinkCollection,
} from '../src/bdtopo-road-links.js';
import type { CadastreBbox } from '../src/cadastre-parcels.js';

afterEach(() => vi.unstubAllGlobals());

const BBOX: CadastreBbox = { south: 47.1246, west: -0.9466, north: 47.126, east: -0.9449 };

/** Un tronçon comme le WFS le rend (relevé du 2026-09-25, Sèvremoine) : [lon, lat, z]. */
function troncon(
  cleabs: unknown,
  properties: Record<string, unknown>,
  geometry: unknown = {
    type: 'LineString',
    coordinates: [
      [-0.9458384, 47.1253012, 95.1],
      [-0.9454154, 47.1255105, 94.2],
    ],
  },
): unknown {
  return {
    type: 'Feature',
    id: 'troncon_de_route.2046060',
    geometry,
    geometry_name: 'geometrie',
    properties: { cleabs, position_par_rapport_au_sol: '0', ...properties },
  };
}
const PASSAGE = troncon('TRONROUT0000000329102793', {
  nature: 'Route à 1 chaussée',
  acces_vehicule_leger: 'Physiquement impossible',
});
const LANE = troncon('TRONROUT0000000011773103', {
  nature: 'Route à 1 chaussée',
  acces_vehicule_leger: 'Libre',
});
const collection = (features: unknown[], extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    type: 'FeatureCollection',
    features,
    numberMatched: features.length,
    numberReturned: features.length,
    ...extra,
  });

describe('readRoadLinkCollection — les tronçons, et ceux qui sont fermés aux véhicules', () => {
  it('lon/lat → lat/lon ; accès VL « Physiquement impossible » → fermé, « Libre » → ouvert', () => {
    const read = readRoadLinkCollection(collection([PASSAGE, LANE]), 10);
    expect(read).toEqual({
      known: true,
      links: [
        {
          id: 'TRONROUT0000000329102793',
          nature: 'Route à 1 chaussée',
          lightVehicleAccess: 'Physiquement impossible',
          closedToVehicles: true,
          lines: [
            [
              { lat: 47.1253012, lon: -0.9458384 },
              { lat: 47.1255105, lon: -0.9454154 },
            ],
          ],
        },
        expect.objectContaining({ id: 'TRONROUT0000000011773103', closedToVehicles: false }),
      ],
    });
  });

  it('la nature qu’aucun véhicule ne prend (sentier, escalier, piste cyclable) ferme aussi ; « Restreint aux ayants droit » ne ferme pas', () => {
    const read = readRoadLinkCollection(
      collection([
        troncon('A', { nature: 'Sentier', acces_vehicule_leger: null }),
        troncon('B', { nature: 'Escalier', acces_vehicule_leger: null }),
        troncon('C', { nature: 'Piste cyclable', acces_vehicule_leger: null }),
        troncon('D', { nature: 'Route à 1 chaussée', acces_vehicule_leger: 'Restreint aux ayants droit' }),
        troncon('E', { nature: 'Chemin', acces_vehicule_leger: 'Libre' }),
      ]),
      10,
    );
    expect(read.known && read.links.map((l) => [l.id, l.closedToVehicles])).toEqual([
      ['A', true],
      ['B', true],
      ['C', true],
      ['D', false],
      ['E', false],
    ]);
  });

  it('une « Route empierrée » reste ouverte (le graphe du camion l’écarte, une voiture y roule) ; seul son accès la ferme', () => {
    const read = readRoadLinkCollection(
      collection([
        troncon('J', { nature: 'Route empierrée', acces_vehicule_leger: 'Libre' }),
        troncon('K', {
          nature: 'Route empierrée',
          acces_vehicule_leger: 'Restreint aux ayants droit',
        }),
        troncon('L', {
          nature: 'Route empierrée',
          acces_vehicule_leger: 'Physiquement impossible',
        }),
        troncon('M', { nature: 'Sentier', acces_vehicule_leger: 'Libre' }),
        troncon('N', { nature: 'Escalier', acces_vehicule_leger: 'Libre' }),
      ]),
      10,
    );
    expect(read.known && read.links.map((l) => [l.id, l.closedToVehicles])).toEqual([
      ['J', false],
      ['K', false],
      ['L', true],
      ['M', true],
      ['N', true],
    ]);
  });

  it('un tronçon hors sol (passerelle, tunnel) ne dit rien du sol : ni fermé ni ouvert', () => {
    const bridge = troncon('F', {
      nature: 'Sentier',
      acces_vehicule_leger: 'Physiquement impossible',
      position_par_rapport_au_sol: '1',
    });
    const read = readRoadLinkCollection(collection([bridge, LANE]), 10);
    expect(read.known && read.links.map((l) => l.id)).toEqual(['TRONROUT0000000011773103']);
  });

  it('une MultiLineString rend chacune de ses lignes', () => {
    const multi = troncon(
      'G',
      { nature: 'Sentier' },
      {
        type: 'MultiLineString',
        coordinates: [
          [
            [-0.9429, 47.12],
            [-0.9439, 47.121],
          ],
          [
            [-0.9449, 47.122],
            [-0.9459, 47.123],
          ],
        ],
      },
    );
    const read = readRoadLinkCollection(collection([multi]), 10);
    expect(read.known && read.links[0]!.lines).toHaveLength(2);
  });

  it('plus que la limite, ou numberMatched au-delà du rendu → truncated ; « unknown » de GeoServer ne coupe rien', () => {
    expect(readRoadLinkCollection(collection([PASSAGE, LANE]), 1)).toEqual({
      known: false,
      why: 'truncated',
    });
    expect(readRoadLinkCollection(collection([PASSAGE], { numberMatched: 5 }), 10)).toEqual({
      known: false,
      why: 'truncated',
    });
    expect(
      readRoadLinkCollection(collection([PASSAGE], { numberMatched: 'unknown' }), 10).known,
    ).toBe(true);
  });

  it('aucun tronçon → empty ; un corps illisible, un tronçon sans identifiant ou sans tracé → malformed (jamais lâché en silence)', () => {
    expect(readRoadLinkCollection(collection([]), 10)).toEqual({ known: false, why: 'empty' });
    expect(readRoadLinkCollection('<ows:ExceptionReport/>', 10)).toEqual({
      known: false,
      why: 'malformed',
    });
    expect(readRoadLinkCollection('{"type":"FeatureCollection"}', 10)).toEqual({
      known: false,
      why: 'malformed',
    });
    expect(readRoadLinkCollection(collection([PASSAGE, troncon('', {})]), 10)).toEqual({
      known: false,
      why: 'malformed',
    });
    const pointOnly = troncon('H', {}, { type: 'LineString', coordinates: [[-0.9429, 47.12]] });
    expect(readRoadLinkCollection(collection([LANE, pointOnly]), 10)).toEqual({
      known: false,
      why: 'malformed',
    });
    const polygon = troncon('I', {}, { type: 'Polygon', coordinates: [] });
    expect(readRoadLinkCollection(collection([polygon]), 10)).toEqual({
      known: false,
      why: 'malformed',
    });
  });
});

describe('openSpaceLinksOf — ce qui coupe l’espace public, ce qui le garde', () => {
  it('les tracés des fermés d’un côté, des ouverts de l’autre', () => {
    const read = readRoadLinkCollection(collection([PASSAGE, LANE]), 10);
    if (!read.known) throw new Error(read.why);
    const links = openSpaceLinksOf(read.links);
    expect(links.closed).toEqual(read.links[0]!.lines);
    expect(links.open).toEqual(read.links[1]!.lines);
  });
});

// ─── Le transport : un faux fetch ─────────────────────────────────────────────

function stubWfs(step: { readonly status?: number; readonly text?: string; readonly hang?: true }): {
  readonly urls: URL[];
} {
  const urls: URL[] = [];
  vi.stubGlobal('fetch', (input: URL, init?: { signal?: AbortSignal }) => {
    urls.push(new URL(String(input)));
    if (step.hang === true) {
      return new Promise((_resolve, reject) =>
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true }),
      );
    }
    const status = step.status ?? 200;
    return Promise.resolve({ ok: status < 300, status, text: async () => step.text ?? '' } as Response);
  });
  return { urls };
}

const OPTIONS = { timeoutMs: 40, limit: 10 };

describe('GeoplateformeRoadLinks — la requête et les échecs', () => {
  it('GetFeature WFS 2.0 sur BDTOPO_V3:troncon_de_route, BBOX en lat/lon (URN), COUNT = limite + 1, cinq champs seulement', async () => {
    const { urls } = stubWfs({ text: collection([PASSAGE, LANE]) });
    const reading = await new GeoplateformeRoadLinks({ wfsUrl: 'https://wfs.test/ows' }).linksInBbox(
      BBOX,
      OPTIONS,
    );
    expect(reading.known && reading.value.links.map((l) => l.closedToVehicles)).toEqual([true, false]);
    const [get] = urls;
    expect(get!.searchParams.get('TYPENAMES')).toBe('BDTOPO_V3:troncon_de_route');
    expect(get!.searchParams.get('BBOX')).toBe('47.1246,-0.9466,47.126,-0.9449,urn:ogc:def:crs:EPSG::4326');
    expect(get!.searchParams.get('COUNT')).toBe('11');
    expect(get!.searchParams.get('PROPERTYNAME')).toBe(
      'cleabs,nature,acces_vehicule_leger,position_par_rapport_au_sol,geometrie',
    );
  });

  it('WFS muet → timeout dans le budget ; HTTP 503 → provider_error ; corps vide → empty', async () => {
    const port = new GeoplateformeRoadLinks({ wfsUrl: 'https://wfs.test/ows' });
    stubWfs({ hang: true });
    const started = Date.now();
    expect(await port.linksInBbox(BBOX, OPTIONS)).toMatchObject({ known: false, why: 'timeout' });
    expect(Date.now() - started).toBeLessThan(500);
    stubWfs({ status: 503 });
    expect(await port.linksInBbox(BBOX, OPTIONS)).toMatchObject({ known: false, why: 'provider_error' });
    stubWfs({ text: collection([]) });
    expect(await port.linksInBbox(BBOX, OPTIONS)).toMatchObject({ known: false, why: 'empty' });
  });
});
