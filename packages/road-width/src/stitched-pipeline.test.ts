import { describe, expect, it } from 'vitest';
import {
  prepareStitchedPipeline,
  yoloBboxesIntersectAsphaltReferenceSamples,
} from './stitched-pipeline.js';
import { buildBearingFallbackAxis } from './geometry.js';
import type { TileGeoContext } from './geometry.js';
import type { YoloBbox } from './yolo.js';

function rgbaImage(width: number, height: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = 120;
    data[i * 4 + 1] = 120;
    data[i * 4 + 2] = 120;
    data[i * 4 + 3] = 255;
  }
  return data;
}

describe('prepareStitchedPipeline YOLO asphalt exclusion', () => {
  const tile: TileGeoContext = {
    latA: 48.8,
    lngA: 2.26,
    dx2Px: 0,
    dy2Px: 0,
    dx3Px: 0,
    dy3Px: 0,
    roadPolylines: [],
    buildingPolygons: [],
    vegetationPolygons: [],
    parkingPolygons: [],
  };
  const vehicle: YoloBbox = {
    x: 128,
    y: 128,
    w: 60,
    h: 24,
    angle: 0,
    conf: 0.9,
    class_name: 'large-vehicle',
  };

  it('keeps full YOLO vehicle masking when boxes are part of the D10 core input', () => {
    const { prep } = prepareStitchedPipeline({
      rgb: rgbaImage(256, 256),
      width: 256,
      height: 256,
      pxPerM: 10,
      bearingDeg: 90,
      gtWidthM: null,
      tile,
      yoloBboxes: [vehicle],
    });

    expect(prep.pipelineReasonCodes).toContain('pipeline_vehicle_mask_yolo:1');
    expect(prep.pipelineReasonCodes).toContain('pipeline_asphalt_reference_vehicle_masked');
    expect(prep.masks.vehicleMask.data.some((v) => v > 0)).toBe(true);
  });

  it('can mask YOLO vehicles only for asphalt reference during a rerun', () => {
    const { prep } = prepareStitchedPipeline({
      rgb: rgbaImage(256, 256),
      width: 256,
      height: 256,
      pxPerM: 10,
      bearingDeg: 90,
      gtWidthM: null,
      tile,
      yoloBboxes: [],
      asphaltReferenceYoloBboxes: [vehicle],
    });

    expect(prep.pipelineReasonCodes).toContain('pipeline_asphalt_reference_vehicle_masked');
    expect(prep.pipelineReasonCodes).not.toContain('pipeline_vehicle_mask_yolo:1');
    expect(prep.masks.vehicleMask.data.some((v) => v > 0)).toBe(false);
  });

  it('detects only YOLO boxes that intersect asphalt reference samples', () => {
    const roadAxis = buildBearingFallbackAxis(256, 256, 10, 90);
    const offStripVehicle: YoloBbox = {
      ...vehicle,
      y: 188,
    };

    expect(yoloBboxesIntersectAsphaltReferenceSamples({
      yoloBboxes: [vehicle],
      width: 256,
      height: 256,
      pxPerM: 10,
      roadAxis,
    })).toEqual([vehicle]);
    expect(yoloBboxesIntersectAsphaltReferenceSamples({
      yoloBboxes: [offStripVehicle],
      width: 256,
      height: 256,
      pxPerM: 10,
      roadAxis,
    })).toEqual([]);
  });
});
