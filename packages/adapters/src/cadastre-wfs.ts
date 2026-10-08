/**
 * le transport du lecteur de parcelles (`cadastre-parcels.ts`) : les
 * URL WFS 2.0 de la Géoplateforme et un GET borné. Aucune règle ici.
 */

const USER_AGENT = 'teneolog-app/0.1 (+https://teneolog.com)';

/** Le WFS en panne ou hors délai : la cause, pour la lecture. */
export class CadastreFetchError extends Error {
  constructor(readonly why: 'timeout' | 'provider_error') {
    super(`cadastre ${why}`);
  }
}

/**
 * GET borné : le signal coupe la requête ET la lecture du corps ; le minuteur
 * rend la main même à un `fetch` qui ignorerait le signal.
 */
export async function cadastreGet(url: URL, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new CadastreFetchError('timeout'));
    }, timeoutMs);
  });
  const work = (async () => {
    const response = await fetch(url, {
      headers: { 'user-agent': USER_AGENT },
      signal: controller.signal,
    });
    if (!response.ok) throw new CadastreFetchError('provider_error');
    return response.text();
  })();
  work.catch(() => undefined); // la course perdue ne doit pas finir en rejet non géré
  try {
    return await Promise.race([work, deadline]);
  } catch (error) {
    if (error instanceof CadastreFetchError) throw error;
    throw new CadastreFetchError(controller.signal.aborted ? 'timeout' : 'provider_error');
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Ce que filtre un GetFeature : une emprise (lat/lon), ou un filtre FES 2.0. */
type FeatureSelection =
  | {
      readonly bbox: {
        readonly south: number;
        readonly west: number;
        readonly north: number;
        readonly east: number;
      };
    }
  | { readonly filter: string };

/** GetFeature WFS 2.0, en GeoJSON lon/lat, au plus `count` objets. */
export function featureUrl(
  wfsUrl: string,
  layer: string,
  count: number,
  selection: FeatureSelection,
): URL {
  const url = new URL(wfsUrl);
  url.searchParams.set('SERVICE', 'WFS');
  url.searchParams.set('VERSION', '2.0.0');
  url.searchParams.set('REQUEST', 'GetFeature');
  url.searchParams.set('TYPENAMES', layer);
  url.searchParams.set('SRSNAME', 'EPSG:4326');
  url.searchParams.set('OUTPUTFORMAT', 'application/json');
  url.searchParams.set('COUNT', String(count));
  if ('bbox' in selection) {
    const { south, west, north, east } = selection.bbox;
    // L'URN EPSG::4326 est en latitude, longitude (l'ordre des axes de l'EPSG).
    url.searchParams.set('BBOX', `${south},${west},${north},${east},urn:ogc:def:crs:EPSG::4326`);
  } else {
    url.searchParams.set('FILTER', selection.filter);
  }
  return url;
}

/**
 * Le filtre standard (FES 2.0, pas le `CQL_FILTER` propre à GeoServer) d'une
 * parcelle par son identifiant national. L'identifiant a été validé avant
 * (`PARCEL_IDU_PATTERN`) : il ne porte ni `<` ni `&`.
 */
export function idFilter(idu: string): string {
  return (
    '<fes:Filter xmlns:fes="http://www.opengis.net/fes/2.0"><fes:PropertyIsEqualTo>' +
    `<fes:ValueReference>idu</fes:ValueReference><fes:Literal>${idu}</fes:Literal>` +
    '</fes:PropertyIsEqualTo></fes:Filter>'
  );
}

/** Les capacités du WFS filtrées sur l'espace de noms de la couche : 171 ko au lieu des 5 Mo de tout le service. */
export function capabilitiesUrl(wfsUrl: string, layer: string): URL {
  const url = new URL(wfsUrl);
  url.searchParams.set('SERVICE', 'WFS');
  url.searchParams.set('VERSION', '2.0.0');
  url.searchParams.set('REQUEST', 'GetCapabilities');
  url.searchParams.set('NAMESPACE', layer.split(':')[0] ?? layer);
  return url;
}
