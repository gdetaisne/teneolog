/** Per-branch timings inside `buildSpatialMasks` (wall vs sum of branches). */
export interface SpatialMasksTimingMs {
  readonly buildingMs: number;
  readonly vegRasterMs: number;
  readonly vegetationMassMs: number;
  readonly canopyMs: number;
  /** Wall-clock for the spatial-mask block (parallel ≈ max waves; sequential ≈ sum). */
  readonly wallMs: number;
  readonly parallelized: boolean;
}
