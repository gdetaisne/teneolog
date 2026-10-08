export * from './ports.js';
export * from './geometry.js';
export * from './highway-class.js';
export * from './attribution.js';
export * from './continuity.js';
export * from './dead-end.js';
export * from './turnaround.js';
export * from './street-selection.js';
export * from './handoff.js';
export * from './reach.js';
export * from './egress-candidates.js';
export * from './non-drivable-area.js';
export * from './fallback-stop.js';
export * from './free-point.js';
export * from './reversing.js';
export * from './impasse-geometry.js';
export * from './open-space.js';
export * from './public-space.js';
// le repère local de l'espace public, pour y poser la manœuvre avec la même projection.
export { frameOf, toGeo, toXY, type GeoBox, type GridFrame, type XY } from './open-space-grid.js';
// la simplification sans croisement, pour alléger l'enveloppe de la manœuvre servie.
export { simplifyRings } from './open-space-simplify.js';
// le contour d'une grille (anneaux extérieurs et trous), pour tracer l'enveloppe de la manœuvre servie.
export { traceRings } from './open-space-contour.js';
export * from './topology-assessment.js';
