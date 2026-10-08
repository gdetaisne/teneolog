import type { BboxAxisGeometry } from './parking-classify.js';
import { latLngToCanvasPx, type LatLng, type SurfacePolygonGeo, type TileGeoContext } from './geometry.js';
import type { SurfacePolygon } from './polygon-mask.js';
import { canvasPointInSurfacePolygons } from './polygon-mask.js';

export function surfacePolygonsFromGeo(
  polys: readonly SurfacePolygonGeo[] | undefined,
): SurfacePolygon[] {
  if (!polys?.length) return [];
  return polys.map((p) => ({
    id: p.id,
    nature: p.nature,
    rings: p.rings,
  }));
}

/** Point-in-polygon for YOLO bbox centre (stitch canvas pixels). */
export function makeBdtopoParkingAt(
  tile: TileGeoContext,
  metrics: { tileACanvasX: number; tileACanvasY: number },
  pxPerM: number,
  parkingPolygons: readonly SurfacePolygonGeo[] | undefined,
): (geom: BboxAxisGeometry) => boolean {
  const polys = surfacePolygonsFromGeo(parkingPolygons);
  if (polys.length === 0) return () => false;

  const toPx = (p: LatLng) => latLngToCanvasPx(p, tile, metrics, pxPerM);

  return (geom) =>
    canvasPointInSurfacePolygons(geom.bbox.x, geom.bbox.y, polys, toPx);
}
