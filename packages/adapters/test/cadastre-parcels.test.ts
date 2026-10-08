/**
 * le lecteur de parcelles du cadastre (WFS Géoplateforme,
 * `CADASTRALPARCELS.PARCELLAIRE_EXPRESS:parcelle`) : la lecture du GeoJSON, les
 * refus qui empêchent une parcelle manquante de passer pour du public, l'édition
 * aux capacités, et le transport borné. Aucun réseau : `fetch` est un script
 * (`vi.stubGlobal`, comme `network-failures.test.ts`).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  bboxAround,
  distanceToParcelM,
  GeoplateformeCadastre,
  readCadastreVintage,
  readParcelCollection,
  type CadastreBbox,
  type CadastreParcel,
} from '../src/cadastre-parcels.js';

afterEach(() => vi.unstubAllGlobals());

const BBOX: CadastreBbox = { south: 47.1246, west: -0.9466, north: 47.126, east: -0.9449 };

/** Une parcelle comme le WFS la rend (relevé du 2026-09-25, raccourcie) : MultiPolygon [lon, lat], anneau fermé. */
function feature(
  idu: unknown,
  rings: readonly (readonly (readonly [number, number])[])[],
): unknown {
  return {
    type: 'Feature',
    id: 'parcelle.12978645',
    geometry: { type: 'MultiPolygon', coordinates: [rings] },
    geometry_name: 'geom',
    properties: {
      gid: 10292726,
      numero: '0127',
      section: 'AH',
      idu,
      contenance: 1066,
      code_insee: '49301',
    },
  };
}
const SQUARE: (readonly [number, number])[] = [
  [-0.9461, 47.125],
  [-0.9460, 47.125],
  [-0.9460, 47.1251],
  [-0.9461, 47.1251],
  [-0.9461, 47.125],
];
const HOLE: (readonly [number, number])[] = [
  [-0.94608, 47.12502],
  [-0.94602, 47.12502],
  [-0.94602, 47.12508],
  [-0.94608, 47.12502],
];
const collection = (features: unknown[], extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    type: 'FeatureCollection',
    features,
    numberMatched: features.length,
    numberReturned: features.length,
    ...extra,
  });

describe('readParcelCollection — les parcelles, ou la raison de n’en rien croire', () => {
  it('lon/lat → lat/lon, sans le sommet de fermeture ; les trous gardés ; l’identifiant national', () => {
    const read = readParcelCollection(
      collection([feature('49301000AH0127', [SQUARE, HOLE])]),
      BBOX,
      10,
    );
    expect(read.known).toBe(true);
    const parcel = read.known ? read.parcels[0]! : null;
    expect(parcel?.idu).toBe('49301000AH0127');
    expect(parcel?.polygons).toHaveLength(1);
    expect(parcel?.polygons[0]).toHaveLength(2);
    expect(parcel?.polygons[0]![0]).toEqual([
      { lat: 47.125, lon: -0.9461 },
      { lat: 47.125, lon: -0.9460 },
      { lat: 47.1251, lon: -0.9460 },
      { lat: 47.1251, lon: -0.9461 },
    ]);
  });

  it('plus que la limite, ou numberMatched au-delà du rendu → truncated, jamais une liste partielle', () => {
    const two = [feature('49301000AH0127', [SQUARE]), feature('49301000AH0128', [SQUARE])];
    expect(readParcelCollection(collection(two), BBOX, 1)).toEqual({
      known: false,
      why: 'truncated',
    });
    expect(readParcelCollection(collection(two, { numberMatched: 5 }), BBOX, 10)).toEqual({
      known: false,
      why: 'truncated',
    });
  });

  it('aucune parcelle → empty (un plan non vectorisé ne devient pas « tout est public »)', () => {
    expect(readParcelCollection(collection([]), BBOX, 10)).toEqual({ known: false, why: 'empty' });
  });

  it.each([
    ['un corps illisible', '<ExceptionReport/>'],
    ['sans features', JSON.stringify({ type: 'FeatureCollection' })],
    ['une parcelle sans idu', collection([feature(undefined, [SQUARE])])],
    ['un idu de 15 caractères', collection([feature('330063000CW0115', [SQUARE])])],
    [
      'un anneau dégénéré',
      collection([feature('49301000AH0127', [[SQUARE[0]!, SQUARE[1]!, SQUARE[0]!]])]),
    ],
    [
      'les axes inversés (lat, lon)',
      collection([feature('49301000AH0127', [SQUARE.map(([lon, lat]) => [lat, lon] as const)])]),
    ],
  ])('%s → malformed : une parcelle illisible rend toute la lecture illisible', (_label, body) => {
    expect(readParcelCollection(body, BBOX, 10)).toEqual({ known: false, why: 'malformed' });
  });

  it('les numberMatched non numériques de GeoServer (« unknown ») ne coupent rien', () => {
    const read = readParcelCollection(
      collection([feature('49301000AH0127', [SQUARE])], { numberMatched: 'unknown' }),
      BBOX,
      10,
    );
    expect(read.known).toBe(true);
  });
});

/** Un rectangle [lon, lat] fermé, du sud-ouest au nord-est. */
const box = (
  west: number,
  south: number,
  east: number,
  north: number,
): (readonly [number, number])[] => [
  [west, south],
  [east, south],
  [east, north],
  [west, north],
  [west, south],
];

describe('readParcelCollection — l’emprise : l’enveloppe de chaque parcelle, pas un sommet (relecture 2026-09-25)', () => {
  it('une parcelle qui ENGLOBE l’emprise (un champ, un entrepôt) : lue, pas malformed', () => {
    const field = box(-0.9529, 47.1, -0.9329, 47.15);
    const read = readParcelCollection(collection([feature('49301000WI0022', [field])]), BBOX, 10);
    expect(read.known && read.parcels.map((p) => p.idu)).toEqual(['49301000WI0022']);
  });

  it('deux parcelles à cheval sur l’emprise, sans aucun sommet dedans : lues', () => {
    const west = box(-0.9529, 47.1, -0.9457, 47.15);
    const east = box(-0.9457, 47.1, -0.9329, 47.15);
    const read = readParcelCollection(
      collection([feature('49301000WI0026', [west]), feature('49301000WI0075', [east])]),
      BBOX,
      10,
    );
    expect(read.known).toBe(true);
  });

  it('une seule parcelle hors de l’emprise parmi des parcelles justes : malformed (le WFS ne la rendrait pas)', () => {
    const inside = box(-0.9461, 47.125, -0.9460, 47.1251);
    const elsewhere = box(-0.9129, 47.2, -0.9119, 47.201);
    const body = collection([
      feature('49301000AH0127', [inside]),
      feature('49301000AH0128', [elsewhere]),
    ]);
    expect(readParcelCollection(body, BBOX, 10)).toEqual({ known: false, why: 'malformed' });
  });
});

describe('readCadastreVintage — l’édition aux capacités', () => {
  it('l’Abstract de la couche des parcelles, pas celui d’une autre couche', () => {
    const caps =
      '<FeatureType><Name>CADASTRALPARCELS.PARCELLAIRE_EXPRESS:batiment</Name><Title>PCI Vecteur : Bâtiments</Title><Abstract>Bâtiments ; Édition 2025-01-01</Abstract></FeatureType>' +
      '<FeatureType><Name>CADASTRALPARCELS.PARCELLAIRE_EXPRESS:parcelle</Name><Title>PCI Vecteur : Parcelles</Title><Abstract>Parcelles ; Édition 2026-06-01</Abstract></FeatureType>';
    expect(readCadastreVintage(caps)).toBe('2026-06-01');
  });

  it('sans la couche, ou sans date → null', () => {
    expect(readCadastreVintage('<WFS_Capabilities/>')).toBeNull();
    expect(
      readCadastreVintage(
        '<Name>CADASTRALPARCELS.PARCELLAIRE_EXPRESS:parcelle</Name><Abstract>Parcelles</Abstract>',
      ),
    ).toBeNull();
  });
});

describe('distanceToParcelM / bboxAround', () => {
  const parcel: CadastreParcel = {
    idu: '49301000AH0127',
    polygons: [[SQUARE.slice(0, 4).map(([lon, lat]) => ({ lat, lon }))]],
  };
  it('0 dedans ; la distance au bord dehors (≈ 11,1 m pour 1e-4° de latitude)', () => {
    expect(distanceToParcelM({ lat: 47.12505, lon: -0.94605 }, parcel)).toBe(0);
    expect(distanceToParcelM({ lat: 47.1252, lon: -0.94605 }, parcel)).toBeCloseTo(11.1, 1);
  });
  it('bboxAround : ±rayon en latitude et en longitude', () => {
    const box = bboxAround({ lat: 47, lon: -1 }, 111.19);
    expect(box.north - 47).toBeCloseTo(0.001, 5);
    expect(-1 - box.west).toBeCloseTo(0.001 / Math.cos((47 * Math.PI) / 180), 5);
  });
});

// ─── Le transport : un faux fetch qui répond selon la requête ────────────────

interface Route {
  readonly capabilities?: {
    readonly status?: number;
    readonly text?: string;
    readonly hang?: true;
  };
  readonly features?: { readonly status?: number; readonly text?: string; readonly hang?: true };
}

const CAPS =
  '<Name>CADASTRALPARCELS.PARCELLAIRE_EXPRESS:parcelle</Name><Abstract>Parcelles ; Édition 2026-06-01</Abstract>';

function stubWfs(route: Route): { readonly urls: URL[] } {
  const urls: URL[] = [];
  vi.stubGlobal('fetch', (input: URL, init?: { signal?: AbortSignal }) => {
    const url = new URL(String(input));
    urls.push(url);
    const step =
      url.searchParams.get('REQUEST') === 'GetCapabilities' ? route.capabilities : route.features;
    if (step === undefined) return Promise.reject(new Error('non scripté'));
    if (step.hang === true) {
      return new Promise((_resolve, reject) =>
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true }),
      );
    }
    const status = step.status ?? 200;
    return Promise.resolve({
      ok: status < 300,
      status,
      text: async () => step.text ?? '',
    } as Response);
  });
  return { urls };
}

const OPTIONS = { timeoutMs: 40, limit: 10 };
const BODY = collection([
  feature('49301000AH0127', [SQUARE]),
  feature('49301000AH0101', [SQUARE.map(([lon, lat]) => [lon + 0.001, lat] as const)]),
]);

describe('GeoplateformeCadastre — la requête, l’édition, les échecs', () => {
  it('parcelsInBbox : GetFeature WFS 2.0 sur la couche, BBOX en lat/lon (URN), COUNT = limite + 1 ; l’édition en plus', async () => {
    const { urls } = stubWfs({ capabilities: { text: CAPS }, features: { text: BODY } });
    const reading = await new GeoplateformeCadastre({
      wfsUrl: 'https://wfs.test/ows',
    }).parcelsInBbox(BBOX, OPTIONS);
    expect(reading.known && reading.value.parcels.map((p) => p.idu)).toEqual([
      '49301000AH0127',
      '49301000AH0101',
    ]);
    expect(reading.known && reading.value.vintage).toBe('2026-06-01');
    const get = urls.find((u) => u.searchParams.get('REQUEST') === 'GetFeature')!;
    expect(get.origin + get.pathname).toBe('https://wfs.test/ows');
    expect(get.searchParams.get('TYPENAMES')).toBe('CADASTRALPARCELS.PARCELLAIRE_EXPRESS:parcelle');
    expect(get.searchParams.get('BBOX')).toBe(
      '47.1246,-0.9466,47.126,-0.9449,urn:ogc:def:crs:EPSG::4326',
    );
    expect(get.searchParams.get('COUNT')).toBe('11');
    expect(get.searchParams.get('OUTPUTFORMAT')).toBe('application/json');
    const caps = urls.find((u) => u.searchParams.get('REQUEST') === 'GetCapabilities')!;
    expect(caps.searchParams.get('NAMESPACE')).toBe('CADASTRALPARCELS.PARCELLAIRE_EXPRESS');
  });

  it('l’édition est gardée : la seconde lecture ne redemande pas les capacités ; un échec des capacités → vintage null, parcelles lues', async () => {
    const { urls } = stubWfs({ capabilities: { text: CAPS }, features: { text: BODY } });
    const cadastre = new GeoplateformeCadastre({ wfsUrl: 'https://wfs.test/ows' });
    await cadastre.parcelsInBbox(BBOX, OPTIONS);
    await cadastre.parcelsInBbox(BBOX, OPTIONS);
    expect(urls.filter((u) => u.searchParams.get('REQUEST') === 'GetCapabilities')).toHaveLength(1);
    stubWfs({ capabilities: { status: 503 }, features: { text: BODY } });
    const reading = await new GeoplateformeCadastre({
      wfsUrl: 'https://wfs.test/ows',
    }).parcelsInBbox(BBOX, OPTIONS);
    expect(reading.known && reading.value.vintage).toBeNull();
  });

  it('WFS muet → timeout dans le budget ; HTTP 503 → provider_error ; corps vide de parcelles → empty', async () => {
    stubWfs({ capabilities: { hang: true }, features: { hang: true } });
    const started = Date.now();
    const mute = await new GeoplateformeCadastre({ wfsUrl: 'https://wfs.test/ows' }).parcelsInBbox(
      BBOX,
      OPTIONS,
    );
    expect(mute).toMatchObject({ known: false, why: 'timeout' });
    expect(Date.now() - started).toBeLessThan(500);
    stubWfs({ capabilities: { text: CAPS }, features: { status: 503 } });
    expect(
      await new GeoplateformeCadastre({ wfsUrl: 'https://wfs.test/ows' }).parcelsInBbox(
        BBOX,
        OPTIONS,
      ),
    ).toMatchObject({
      known: false,
      why: 'provider_error',
    });
    stubWfs({ capabilities: { text: CAPS }, features: { text: collection([]) } });
    expect(
      await new GeoplateformeCadastre({ wfsUrl: 'https://wfs.test/ows' }).parcelsInBbox(
        BBOX,
        OPTIONS,
      ),
    ).toMatchObject({
      known: false,
      why: 'empty',
    });
  });

  it('un fetch qui ne rend jamais la main ET ignore le signal : le filet coupe au budget, parcelles comme édition', async () => {
    const HUNG = Symbol('pendante');
    const within = <T>(promise: Promise<T>): Promise<T | typeof HUNG> =>
      Promise.race([
        promise,
        new Promise<typeof HUNG>((resolve) => setTimeout(() => resolve(HUNG), 500)),
      ]);
    // Aucune requête ne répond, et aucune n'écoute `init.signal`.
    vi.stubGlobal('fetch', () => new Promise(() => {}));
    const cadastre = new GeoplateformeCadastre({ wfsUrl: 'https://wfs.test/ows' });
    expect(await within(cadastre.parcelsInBbox(BBOX, OPTIONS))).toMatchObject({
      known: false,
      why: 'timeout',
    });
    expect(await within(cadastre.parcelById('49301000AH0127', { timeoutMs: 40 }))).toMatchObject({
      known: false,
      why: 'timeout',
    });
    // Les parcelles répondent, les capacités jamais : la lecture rend ses parcelles, sans édition, dans le budget.
    vi.stubGlobal('fetch', (input: URL) =>
      new URL(String(input)).searchParams.get('REQUEST') === 'GetCapabilities'
        ? new Promise(() => {})
        : Promise.resolve({ ok: true, status: 200, text: async () => BODY } as Response),
    );
    const read = await within(
      new GeoplateformeCadastre({ wfsUrl: 'https://wfs.test/ows' }).parcelsInBbox(BBOX, OPTIONS),
    );
    expect(read).toMatchObject({ known: true, value: { vintage: null } });
  });

  it('parcelsNear : l’emprise du disque, les parcelles dans le rayon, la plus proche d’abord (celle qui contient le point à 0 m)', async () => {
    // Deux parcelles que le WFS rendrait pour l'emprise du disque de 30 m (± 36 m élargie) :
    // la seconde la coupe, mais son bord ouest est à ~34 m du point.
    const beside = SQUARE.map(([lon, lat]) => [lon + 0.0005, lat] as const);
    const body = collection([
      feature('49301000AH0127', [SQUARE]),
      feature('49301000AH0101', [beside]),
    ]);
    stubWfs({ capabilities: { text: CAPS }, features: { text: body } });
    const inside = { lat: 47.12505, lon: -0.94605 };
    const reading = await new GeoplateformeCadastre({ wfsUrl: 'https://wfs.test/ows' }).parcelsNear(
      inside,
      30,
      OPTIONS,
    );
    // Dans l'emprise, hors du rayon : écartée.
    expect(reading.known && reading.value.parcels.map((p) => [p.idu, p.distanceM])).toEqual([
      ['49301000AH0127', 0],
    ]);
    const wider = await new GeoplateformeCadastre({ wfsUrl: 'https://wfs.test/ows' }).parcelsNear(
      inside,
      40,
      OPTIONS,
    );
    expect(wider.known && wider.value.parcels.map((p) => p.idu)).toEqual([
      '49301000AH0127',
      '49301000AH0101',
    ]);
  });

  it('parcelById : un filtre FES standard sur idu ; introuvable → not_found ; mal formé → invalid_id sans requête', async () => {
    const { urls } = stubWfs({
      capabilities: { text: CAPS },
      features: { text: collection([feature('49301000AH0127', [SQUARE])]) },
    });
    const cadastre = new GeoplateformeCadastre({ wfsUrl: 'https://wfs.test/ows' });
    const found = await cadastre.parcelById('49301000AH0127', { timeoutMs: 40 });
    expect(found.known && found.value.parcel.idu).toBe('49301000AH0127');
    const get = urls.find((u) => u.searchParams.get('REQUEST') === 'GetFeature')!;
    expect(get.searchParams.get('FILTER')).toContain(
      '<fes:ValueReference>idu</fes:ValueReference><fes:Literal>49301000AH0127</fes:Literal>',
    );
    expect(get.searchParams.get('BBOX')).toBeNull();
    const empty = stubWfs({ capabilities: { text: CAPS }, features: { text: collection([]) } });
    expect(await cadastre.parcelById('49301000AH9999', { timeoutMs: 40 })).toMatchObject({
      known: false,
      why: 'not_found',
    });
    const before = empty.urls.length;
    expect(before).toBeGreaterThan(0);
    expect(await cadastre.parcelById('330063000CW0115', { timeoutMs: 40 })).toEqual({
      known: false,
      why: 'invalid_id',
      fetchMs: null,
    });
    expect(empty.urls).toHaveLength(before);
  });
});
