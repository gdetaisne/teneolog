/**
 * S1 — Turnaround measurement.
 *
 * One question: how large is the circle the vehicle can actually trace here?
 *
 * The defect this module exists to close is the engine's `circleDiameterM: null`
 * paired with `loop: true` — a turning circle whose presence was detected and
 * whose size was never measured, read downstream as "a turnaround exists". So
 * the only two answers here are a measured diameter and a typed refusal. There
 * is no third answer, and in particular there is no diameter this module
 * invents on its own: the two fallbacks are policy inputs, and a null policy
 * input means the refusal was chosen deliberately rather than defaulted into.
 *
 * Truck-agnostic. Nothing here knows what a turning radius is; whether the
 * measured circle is big enough is the projection stage's question (S5).
 */
import type { Fact, GeoPoint, Provenance, Turnaround } from '@teneolog/domain';

import { closestPointOnPolyline, haversineM, largestInscribedCircle } from './geometry.js';
import type { RoadNode, RoadWay, Surface } from './ports.js';

export type TurnaroundSource =
  | { readonly kind: 'turning_circle_node'; readonly node: RoadNode }
  | { readonly kind: 'loop_way'; readonly way: RoadWay }
  | { readonly kind: 'surface'; readonly surface: Surface }
  | { readonly kind: 'carriageway'; readonly way: RoadWay; readonly at: GeoPoint };

export interface TurnaroundMeasurementOptions {
  /** Assumed diameter of a turning circle node that states no dimension. Null = refuse to guess. */
  readonly defaultTurningCircleDiameterM: number | null;
  /** Carriageway width used when the way declares none. Null = refuse to guess. */
  readonly fallbackCarriagewayWidthM: number | null;
  /**
   * How far a loop way's two ends may sit apart and still count as a ring.
   *
   * A parameter rather than a constant because it decides whether a hooked
   * residential street is a turnaround or a dead-end, which is a calibration
   * question, not a geometric one.
   */
  readonly loopClosureToleranceM: number;
  /**
   * Acquisition time stamped onto the provenance, ISO 8601.
   *
   * Supplied rather than read from the clock: this stage is pure, so every
   * field case has to be reproducible as a fixture down to its provenance.
   */
  readonly observedAt: string;
}

/**
 * Confidence published per branch.
 *
 * Not a threshold — nothing in this module compares against these values. They
 * are the ranking the stage owes its consumers, so that a diameter taken from a
 * policy default can never be mistaken downstream for a measured polygon.
 */
const CONFIDENCE = {
  /** A surveyed polygon measured directly. */
  surfacePolygon: 0.8,
  /** A ring centreline: real geometry, but the free space is inferred from it. */
  loopRing: 0.7,
  /** A dimension the source stated and we did not check. */
  declared: 0.55,
  /** A policy assumption standing in for a measurement that does not exist. */
  policyDefault: 0.25,
} as const;

/**
 * OSM vocabulary. `RoadNode` carries no source field. A mapper names a
 * turnaround with `highway=turning_circle` or `highway=turning_loop` (Sèvremoine,
 * ). The diameter tag is the circle's companion; a loop node rarely has one.
 */
const TURNING_CIRCLE_TAG_SOURCE = 'osm-overpass' as const;

/** A node the mapper named as a place to turn — not the carriageway at the stop. */
export function isMappedTurnaroundNode(tags: Readonly<Record<string, string>>): boolean {
  const highway = tags['highway'];
  return highway === 'turning_circle' || highway === 'turning_loop';
}

/** Ordered most specific first: the namespaced tag wins over the bare one. */
const DIAMETER_TAG_KEYS: readonly string[] = ['turning_circle:diameter', 'diameter'];

/** `12`, `12.5`, `12 m`, `12m`. Anything else is a value we cannot read. */
const METRES_PATTERN = /^\s*(\d+(?:\.\d+)?)\s*m?\s*$/;

export function measureTurnaround(
  source: TurnaroundSource,
  options: TurnaroundMeasurementOptions,
): Fact<Turnaround> {
  switch (source.kind) {
    case 'turning_circle_node':
      return measureTurningCircleNode(source.node, options);
    case 'loop_way':
      return measureLoopWay(source.way, options);
    case 'surface':
      return measureSurface(source.surface, options);
    case 'carriageway':
      return measureCarriageway(source.way, source.at, options);
  }
}

/**
 * EC-17 — a `highway=turning_circle` node is a bare point. Unless the mapper
 * added a dimension there is nothing to measure, and the correct output is a
 * refusal: this is the address whose circle is too small for a 19 t, and any
 * invented diameter turns it into a false OK.
 */
function measureTurningCircleNode(
  node: RoadNode,
  options: TurnaroundMeasurementOptions,
): Fact<Turnaround> {
  const tagged = readTaggedDiameterM(node.tags);
  const surface = node.tags['highway'] === 'turning_loop' ? 'loop' : 'turning_circle';

  if (tagged !== null) {
    return {
      known: true,
      value: { usableDiameterM: tagged, centre: node.at, surface },
      provenance: provenanceOf(TURNING_CIRCLE_TAG_SOURCE, 'turning-circle-diameter-tag', options),
      reliability: {
        confidence: CONFIDENCE.declared,
        basis: 'declared',
        reasonCodes: ['turning_circle_diameter_tagged'],
      },
    };
  }

  const assumed = options.defaultTurningCircleDiameterM;
  if (assumed === null) {
    return {
      known: false,
      why: 'no_data',
      provenance: provenanceOf(
        TURNING_CIRCLE_TAG_SOURCE,
        'turning-circle-unmeasured',
        options,
      ),
    };
  }

  return {
    known: true,
    value: { usableDiameterM: assumed, centre: node.at, surface },
    provenance: provenanceOf(TURNING_CIRCLE_TAG_SOURCE, 'turning-circle-policy-default', options),
    reliability: {
      confidence: CONFIDENCE.policyDefault,
      basis: 'derived',
      reasonCodes: ['turning_circle_diameter_assumed'],
    },
  };
}

/**
 * EC-18 / BUG-037c — the exit loop a truck drives round and leaves forward.
 *
 * The vehicle travels on the ring, so the circle it can trace is the one that
 * fits inside the ring's own footprint: a wide loop gives a wide circle, and a
 * hairpin gives a narrow one even though both are closed.
 */
function measureLoopWay(way: RoadWay, options: TurnaroundMeasurementOptions): Fact<Turnaround> {
  const closure = ringClosure(way, options.loopClosureToleranceM);
  if (closure === null) {
    // LIG-01 — an open way is a street, not a turnaround. Refusing here is what
    // keeps "impasse sans possibilité de faire demi-tour" from acquiring one.
    return {
      known: false,
      why: 'not_applicable',
      provenance: provenanceOf(way.source, 'loop-ring-not-closed', options),
    };
  }

  const circle = largestInscribedCircle(way.geometry);
  if (circle === null) {
    return {
      known: false,
      why: 'no_data',
      provenance: provenanceOf(way.source, 'loop-ring-degenerate', options),
    };
  }

  return {
    known: true,
    value: { usableDiameterM: circle.diameterM, centre: circle.centre, surface: 'loop' },
    provenance: provenanceOf(way.source, 'loop-ring-inscribed-circle', options),
    reliability: {
      confidence: CONFIDENCE.loopRing,
      basis: 'measured',
      reasonCodes: ['loop_ring_inscribed', closure],
    },
  };
}

/**
 * TAF-01 — a mapped open area. The inscribed circle is deliberately not an area
 * test: a 500 m² parking strip that is long and thin clears every area gate and
 * still has nowhere to swing a rigid, and only the inscribed circle says so.
 *
 * Ownership is not consulted. A private yard is a different dimension of the
 * answer (`GroundOwnership`), never a reason to withhold a measurement.
 */
function measureSurface(surface: Surface, options: TurnaroundMeasurementOptions): Fact<Turnaround> {
  const circle = largestInscribedCircle(surface.polygon);
  if (circle === null) {
    // TAF-02 — a car park mapped as a bare node reaches us with no polygon.
    // There is nothing to measure, so it stays unknown rather than inheriting a
    // default that would let it pass for a measured surface.
    return {
      known: false,
      why: 'no_data',
      provenance: provenanceOf(surface.source, 'surface-no-measurable-polygon', options),
    };
  }

  return {
    known: true,
    value: { usableDiameterM: circle.diameterM, centre: circle.centre, surface: 'open_area' },
    provenance: provenanceOf(surface.source, 'surface-inscribed-circle', options),
    reliability: {
      confidence: CONFIDENCE.surfacePolygon,
      basis: 'measured',
      reasonCodes: ['open_area_inscribed'],
    },
  };
}

/**
 * BUG-074 / EC-01 — the reversal on the road itself. This is how an on-site
 * U-turn is expressed as a measurement instead of a boolean, so the projection
 * stage can compare it against a swept width and reject it for a 19 t while
 * accepting it for a van.
 *
 * Bounded by the carriageway, not by a circle: there is no polygon here, only
 * the width of the road the manoeuvre happens on.
 */
function measureCarriageway(
  way: RoadWay,
  at: GeoPoint,
  options: TurnaroundMeasurementOptions,
): Fact<Turnaround> {
  // The manoeuvre happens on the axis, so the centre is the reversal point
  // projected onto it; an empty geometry leaves the caller's point untouched.
  const centre = closestPointOnPolyline(way.geometry, at)?.point ?? at;

  const declared = way.declaredWidthM;
  if (declared !== null) {
    return {
      known: true,
      value: { usableDiameterM: declared, centre, surface: 'carriageway' },
      provenance: provenanceOf(way.source, 'carriageway-declared-width', options),
      reliability: {
        confidence: CONFIDENCE.declared,
        basis: 'declared',
        reasonCodes: ['carriageway_declared_width'],
      },
    };
  }

  const assumed = options.fallbackCarriagewayWidthM;
  if (assumed === null) {
    return {
      known: false,
      why: 'no_data',
      provenance: provenanceOf(way.source, 'carriageway-width-undeclared', options),
    };
  }

  return {
    known: true,
    value: { usableDiameterM: assumed, centre, surface: 'carriageway' },
    provenance: provenanceOf(way.source, 'carriageway-policy-default-width', options),
    reliability: {
      confidence: CONFIDENCE.policyDefault,
      basis: 'derived',
      reasonCodes: ['carriageway_width_assumed'],
    },
  };
}

/**
 * Why a way counts as a ring, or null when it does not.
 *
 * Node identity is the strong evidence and is checked first: a way whose first
 * and last node are the same node is closed no matter what its coordinates
 * round to. The geometric test is the fallback for sources that do not share
 * node ids across the seam.
 */
function ringClosure(
  way: RoadWay,
  toleranceM: number,
): 'ring_closed_by_node_identity' | 'ring_closed_by_geometry' | null {
  const firstId = way.nodeIds[0];
  const lastId = way.nodeIds[way.nodeIds.length - 1];
  if (
    way.nodeIds.length > 2 &&
    firstId !== undefined &&
    lastId !== undefined &&
    firstId === lastId
  ) {
    return 'ring_closed_by_node_identity';
  }

  // Three distinct positions are the minimum that can enclose anything.
  if (way.geometry.length < 3) return null;
  const firstPoint = way.geometry[0];
  const lastPoint = way.geometry[way.geometry.length - 1];
  if (firstPoint === undefined || lastPoint === undefined) return null;

  return haversineM(firstPoint, lastPoint) <= toleranceM ? 'ring_closed_by_geometry' : null;
}

/** The first readable diameter tag, in metres, or null when the source states none. */
function readTaggedDiameterM(tags: Readonly<Record<string, string>>): number | null {
  for (const key of DIAMETER_TAG_KEYS) {
    const raw = tags[key];
    if (raw === undefined) continue;
    const match = METRES_PATTERN.exec(raw);
    if (match === null) continue;
    const captured = match[1];
    if (captured === undefined) continue;
    const parsed = Number.parseFloat(captured);
    // A zero or unparseable dimension is not a smaller circle, it is no reading.
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function provenanceOf(
  source: Provenance['source'],
  method: string,
  options: TurnaroundMeasurementOptions,
): Provenance {
  return { source, method, fetchedAt: options.observedAt };
}
