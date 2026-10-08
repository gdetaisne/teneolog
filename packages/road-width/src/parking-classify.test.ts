import { describe, expect, it } from 'vitest';
import { buildRoadAxis } from './geometry.js';
import {
  alongGapM,
  bboxAxisGeometry,
  classifyYoloParking,
  filterYoloBboxesWithinLateralHalfM,
  isCirculatingByLongitudinalProbe,
  isVehicleOnBdtopoCarriageway,
  PARKING_PAIR_GAP_M,
  type BboxAxisGeometry,
} from './parking-classify.js';
import type { YoloBbox } from './yolo.js';
import type { AsphaltModel } from './types.js';
import type { RoadAxis, TileGeoContext } from './geometry.js';

function geom(
  bbox: YoloBbox,
  side: 'left' | 'right',
  alongM: number,
  halfAlongM: number,
  lateralM: number,
  inner: number,
  outer: number,
): BboxAxisGeometry {
  return {
    bbox,
    side,
    alongM,
    lateralM,
    innerEdgeM: inner,
    outerEdgeM: outer,
    halfAlongM,
  };
}

describe('bboxAxisGeometry', () => {
  it('uses axisAt(alongM) for lateral side (not only axisAt(0))', () => {
    const tile: TileGeoContext = {
      latA: 46.14,
      lngA: -1.14,
      roadPolylines: [
        [
          { lat: 46.140, lng: -1.141 },
          { lat: 46.141, lng: -1.139 },
        ],
      ],
      buildingPolygons: [],
      vegetationPolygons: [],
      dx2Px: 0,
      dy2Px: 0,
      dx3Px: 0,
      dy3Px: 0,
    };
    const axis = buildRoadAxis(900, 500, 10, 45, tile, undefined);
    const bbox: YoloBbox = {
      x: 500,
      y: 300,
      w: 40,
      h: 18,
      angle: 0,
      conf: 0.32,
      class_name: 'small-vehicle',
    };
    const g = bboxAxisGeometry(bbox, axis, 10);
    expect(g.side).toMatch(/^(left|right)$/);
    expect(Number.isFinite(g.alongM)).toBe(true);
    expect(Number.isFinite(g.lateralM)).toBe(true);
  });
});

describe('alongGapM parking pair', () => {
  it('LR parking bilatéral: ~2.93 m edge gap is within PARKING_PAIR_GAP_M', () => {
    const a = geom({ x: 0, y: 0, w: 1, h: 1, angle: 0, conf: 0.32, class_name: 'small-vehicle' }, 'left', 1.42, 1.35, -1.51, -1.52, -5.93);
    const b = geom({ x: 0, y: 0, w: 1, h: 1, angle: 0, conf: 0.16, class_name: 'small-vehicle' }, 'left', 7.13, 1.42, -1.13, -1.52, -5.93);
    expect(alongGapM(a, b)).toBeCloseTo(2.93, 1);
    expect(alongGapM(a, b)).toBeLessThan(PARKING_PAIR_GAP_M);
  });

});

const asphaltModel: AsphaltModel = {
  medianColour: [100, 100, 100],
  rgbMin: [90, 90, 90],
  rgbMax: [110, 110, 110],
  lumaMin: 90,
  lumaMax: 110,
  maxSat: 10,
  sampleCount: 100,
};

function straightAxis(pxPerM: number): RoadAxis {
  return {
    anchor: { x: 100, y: 100 },
    spanM: 30,
    axisAt(tMeters: number) {
      return {
        cx: 100 + tMeters * pxPerM,
        cy: 100,
        tangentX: 1,
        tangentY: 0,
        perpX: 0,
        perpY: 1,
      };
    },
  };
}

function rgbaImage(W: number, H: number, rgb: [number, number, number]): Uint8ClampedArray {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    data[i * 4] = rgb[0];
    data[i * 4 + 1] = rgb[1];
    data[i * 4 + 2] = rgb[2];
    data[i * 4 + 3] = 255;
  }
  return data;
}

function bboxAt(
  alongM: number,
  lateralM: number,
  pxPerM: number,
  className: YoloBbox['class_name'] = 'small-vehicle',
): YoloBbox {
  return {
    x: 100 + alongM * pxPerM,
    y: 100 + lateralM * pxPerM,
    w: 20,
    h: 20,
    angle: 0,
    conf: 0.9,
    class_name: className,
  };
}

describe('classifyYoloParking pair probe', () => {
  it('keeps too-far pairs circulating when both longitudinal probes are clean asphalt', () => {
    const pxPerM = 10;
    const classifications = classifyYoloParking(
      [bboxAt(0, 5, pxPerM), bboxAt(10, 5, pxPerM)],
      straightAxis(pxPerM),
      pxPerM,
      0.1,
      {
        rgb: rgbaImage(240, 240, [100, 100, 100]),
        width: 240,
        height: 240,
        asphaltModel,
      },
    );

    expect(classifications).toHaveLength(2);
    expect(classifications.every(c => c.status === 'circulating')).toBe(true);
    expect(classifications[0]!.reason).toContain('pair_too_far_circulation_probe');
  });

  it('classifies too-far pairs as circulating when local ref matches uniform bright asphalt', () => {
    const pxPerM = 10;
    const classifications = classifyYoloParking(
      [bboxAt(0, 5, pxPerM), bboxAt(10, 5, pxPerM)],
      straightAxis(pxPerM),
      pxPerM,
      0.1,
      {
        rgb: rgbaImage(240, 240, [180, 180, 180]),
        width: 240,
        height: 240,
        asphaltModel,
      },
    );

    expect(classifications).toHaveLength(2);
    expect(classifications.every(c => c.status === 'circulating')).toBe(true);
    expect(classifications[0]!.reason).toContain('pair_too_far_circulation_probe');
  });
});

describe('isCirculatingByLongitudinalProbe local asphalt ref', () => {
  it('uses asphalt near the vehicle alongM, not a mismatched global model', () => {
    const pxPerM = 10;
    const axis = straightAxis(pxPerM);
    const rgb = rgbaImage(240, 240, [100, 100, 100]);
    const bbox = bboxAt(0, 0.5, pxPerM);
    const geom = bboxAxisGeometry(bbox, axis, pxPerM);

    const globalMismatch: typeof asphaltModel = {
      medianColour: [40, 40, 40],
      rgbMin: [30, 30, 30],
      rgbMax: [50, 50, 50],
      lumaMin: 20,
      lumaMax: 60,
      maxSat: 10,
      sampleCount: 100,
    };

    expect(
      isCirculatingByLongitudinalProbe(geom, axis, pxPerM, rgb, 240, 240, globalMismatch),
    ).toBe(true);
  });

  it('classifies a solo vehicle as circulating when probe strips are clean', () => {
    const pxPerM = 10;
    const classifications = classifyYoloParking(
      [bboxAt(0, 5, pxPerM)],
      straightAxis(pxPerM),
      pxPerM,
      0.1,
      {
        rgb: rgbaImage(240, 240, [100, 100, 100]),
        width: 240,
        height: 240,
        asphaltModel,
      },
    );

    expect(classifications).toHaveLength(1);
    expect(classifications[0]!.status).toBe('circulating');
    expect(classifications[0]!.reason).toBe('vehicle_circulation_probe');
  });
});

describe('isVehicleOnBdtopoCarriageway', () => {
  const lmLike = geom(
    { x: 0, y: 0, w: 1, h: 1, angle: 0, conf: 0.9, class_name: 'small-vehicle' },
    'right',
    0,
    1.2,
    0.33,
    -0.93,
    1.58,
  );

  it('LM-like solo car centred on 4 m BDTOPO axis is in-lane', () => {
    expect(isVehicleOnBdtopoCarriageway(lmLike, 4)).toBe(true);
  });

  it('kerb-parked centre outside BDTOPO carriageway band is not in-lane', () => {
    const kerb = geom(
      { x: 0, y: 0, w: 1, h: 1, angle: 0, conf: 0.9, class_name: 'small-vehicle' },
      'right',
      0,
      1.2,
      1.4,
      0.9,
      1.9,
    );
    expect(isVehicleOnBdtopoCarriageway(kerb, 4)).toBe(false);
  });

  it('vehicle footprint touching the BDTOPO axis is in-lane even when centre is offset', () => {
    const touchingAxis = geom(
      { x: 0, y: 0, w: 1, h: 1, angle: 0, conf: 0.9, class_name: 'small-vehicle' },
      'right',
      0,
      1.2,
      1.3,
      -0.05,
      2.65,
    );
    expect(isVehicleOnBdtopoCarriageway(touchingAxis, 4)).toBe(true);
  });
});

describe('classifyYoloParking BDTOPO carriageway', () => {
  it('solo vehicle on BDTOPO carriageway is circulating without probe', () => {
    const pxPerM = 10;
    const classifications = classifyYoloParking(
      [bboxAt(0, 0.33, pxPerM)],
      straightAxis(pxPerM),
      pxPerM,
      0.1,
      { bdtopoWidthM: 4 },
    );

    expect(classifications).toHaveLength(1);
    expect(classifications[0]!.status).toBe('circulating');
    expect(classifications[0]!.reason).toBe('vehicle_on_bdtopo_carriageway');
  });

  it('vehicle touching BDTOPO axis is circulating without probe', () => {
    const pxPerM = 10;
    const wideVehicleTouchingAxis = {
      ...bboxAt(0, 1.3, pxPerM),
      h: 28,
    };
    const classifications = classifyYoloParking(
      [wideVehicleTouchingAxis],
      straightAxis(pxPerM),
      pxPerM,
      0.1,
      { bdtopoWidthM: 4 },
    );

    expect(classifications).toHaveLength(1);
    expect(classifications[0]!.status).toBe('circulating');
    expect(classifications[0]!.reason).toBe('vehicle_on_bdtopo_carriageway');
  });

  it('solo vehicle on kerb strip stays circulating/ambiguous when probe and parking evidence are absent', () => {
    const pxPerM = 10;
    const classifications = classifyYoloParking(
      [bboxAt(0, 1.4, pxPerM)],
      straightAxis(pxPerM),
      pxPerM,
      0.1,
      { bdtopoWidthM: 4 },
    );

    expect(classifications).toHaveLength(1);
    expect(classifications[0]!.status).toBe('circulating');
    expect(classifications[0]!.reason).toBe('solo_vehicle_ambiguous_circulation_default');
  });

  it('solo vehicle on a BDTOPO parking polygon stays parked without probe', () => {
    const pxPerM = 10;
    const classifications = classifyYoloParking(
      [bboxAt(0, 1.4, pxPerM)],
      straightAxis(pxPerM),
      pxPerM,
      0.1,
      {
        bdtopoWidthM: 4,
        bdtopoParkingAt: () => true,
      },
    );

    expect(classifications).toHaveLength(1);
    expect(classifications[0]!.status).toBe('parked');
    expect(classifications[0]!.reason).toBe('parking_bdtopo');
  });

  it('in-lane vehicle is circulating even when same side has a parked row (≥3)', () => {
    const pxPerM = 10;
    const classifications = classifyYoloParking(
      [
        bboxAt(0, 0.33, pxPerM),
        bboxAt(2, 2.0, pxPerM),
        bboxAt(5, 2.0, pxPerM),
        bboxAt(8, 2.0, pxPerM),
      ],
      straightAxis(pxPerM),
      pxPerM,
      0.1,
      { bdtopoWidthM: 4 },
    );

    const inLane = classifications.find(c => Math.abs(c.geometry.lateralM - 0.33) < 0.05);
    expect(inLane?.status).toBe('circulating');
    expect(inLane?.reason).toBe('vehicle_on_bdtopo_carriageway');

    const kerbParked = classifications.filter(c => Math.abs(c.geometry.lateralM - 2.0) < 0.15);
    expect(kerbParked).toHaveLength(3);
    expect(kerbParked.every(c => c.status === 'parked')).toBe(true);
    expect(kerbParked[0]!.reason).toBe('parking_row_count');
  });

  it('in-lane large vehicle stays circulating even with kerb parked cars on the same side', () => {
    const pxPerM = 10;
    const classifications = classifyYoloParking(
      [
        bboxAt(0, 0.33, pxPerM, 'large-vehicle'),
        bboxAt(2, 2.0, pxPerM),
      ],
      straightAxis(pxPerM),
      pxPerM,
      0.1,
      { bdtopoWidthM: 4 },
    );

    const truck = classifications.find(c => c.bbox.class_name === 'large-vehicle');
    expect(truck?.status).toBe('circulating');
    expect(truck?.reason).toBe('large_vehicle_on_bdtopo_carriageway');
  });
});

describe('filterYoloBboxesWithinLateralHalfM', () => {
  it('drops boxes whose lateral footprint is outside the crop half-width', () => {
    const pxPerM = 10;
    const axis = straightAxis(pxPerM);
    const { kept, excluded } = filterYoloBboxesWithinLateralHalfM(
      [bboxAt(0, 1.0, pxPerM), bboxAt(0, 5.0, pxPerM)],
      axis,
      pxPerM,
      3,
    );
    expect(kept).toHaveLength(1);
    expect(excluded).toBe(1);
    expect(Math.abs(bboxAxisGeometry(kept[0]!, axis, pxPerM).lateralM - 1.0)).toBeLessThan(0.05);
  });

  it('keeps kerb parking whose centre is outside the crop but footprint overlaps it', () => {
    const pxPerM = 10;
    const axis = straightAxis(pxPerM);
    const overlappingKerb = {
      ...bboxAt(0, 3.4, pxPerM),
      h: 12, // 1.2 m projected lateral footprint: inner edge overlaps crop half 3 m.
    };

    const { kept, excluded } = filterYoloBboxesWithinLateralHalfM(
      [overlappingKerb, bboxAt(0, 5.0, pxPerM)],
      axis,
      pxPerM,
      3,
    );

    expect(kept).toHaveLength(1);
    expect(excluded).toBe(1);
    expect(Math.abs(bboxAxisGeometry(kept[0]!, axis, pxPerM).lateralM - 3.4)).toBeLessThan(0.05);
  });
});
