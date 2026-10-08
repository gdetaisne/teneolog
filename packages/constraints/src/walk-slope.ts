/**
 * LA PENTE DU CHEMIN À PIED, de l'arrière du camion à la porte.
 *
 * Principe 49 (Décision produit) : « la pente doit justement dire si un
 * tire-palette peut ou pas faire son travail… c'est un warning, jamais
 * bloquant » ; complété le même jour : elle se lit sur l'IGN (RGE ALTI), à la
 * porte comme le long du chemin à pied, PAR TRONÇONS D'AU MOINS 20 M — jamais
 * un pic sur 5 m. À La Crèche, environ 10 % sur 80 m du chemin.
 *
 * Deux fonctions pures, et rien d'autre :
 *  - `walkStations` : les points où lire l'altitude, tous les 5 m le long de la
 *    ligne servie, et la porte ;
 *  - `walkSlopeProfile` : les tronçons. Chaque pas de 5 m est classé — raide
 *    en descente, raide en montée, ou non — par la pente de la fenêtre de 20 m
 *    qui l'entoure (un pic de 5 m ne fait pas une fenêtre raide) ; les pas de
 *    même classe se suivent en un tronçon ; un tronçon raide de moins de 20 m
 *    s'élargit à 20 m sur ses voisins (une rampe de 20 m à 10 % reste une rampe),
 *    tout autre tronçon trop court se fond dans son plus long voisin. La pente
 *    d'un tronçon est celle de ses deux bouts, SIGNÉE vers la porte : négative,
 *    on descend vers la porte ; et c'est elle que la règle juge, pour que la
 *    marque « raide » et le chiffre ne se contredisent jamais (U4).
 *
 * La règle qui dit « trop raide » n'est pas ici : c'est celle du hayon
 * (`readTailLift`, au seuil `equipment.tailLiftMaxSlopePct` de la policy),
 * injectée (`isSteep`) — une règle, une source (principe 23). Rien ne lit ce
 * profil pour un verdict : c'est un avertissement affiché.
 */
import type { GeoPoint } from '@teneolog/domain';
import { pointAlongPolyline, polylineLengthM, slicePolyline } from '@teneolog/topology';

/** Where heights are read, metres: the RGE ALTI's own grid (1 to 5 m). */
export const WALK_SLOPE_STATION_STEP_M = 5;
/** The shortest stretch a grade is said on (principe 49 : « jamais un pic sur 5 m »). */
export const WALK_SLOPE_MIN_SEGMENT_M = 20;

export interface WalkStation {
  /** Metres from the start of the walk (the truck), along it. */
  readonly alongM: number;
  readonly at: GeoPoint;
}

export interface WalkSlopeSegment {
  readonly fromM: number;
  readonly toM: number;
  readonly startElevationM: number;
  readonly endElevationM: number;
  /** Signed toward the door: negative when the walk goes down to it. */
  readonly gradePct: number;
  /** `isSteep(|gradePct|)`: the hayon's rule on this stretch. */
  readonly steep: boolean;
  /** The stretch of the walk, cut from the served line. */
  readonly path: readonly GeoPoint[];
}

export interface WalkSlopeProfile {
  readonly lengthM: number;
  /** Door minus truck, metres. */
  readonly netM: number;
  /** Metres gone down, then up, walking to the door, stretch by stretch. */
  readonly descentM: number;
  readonly ascentM: number;
  /** Metres of steep stretches. */
  readonly steepM: number;
  /** The steepest stretch's grade, unsigned. */
  readonly maxGradePct: number;
  readonly segments: readonly WalkSlopeSegment[];
}

/** Every `stepM` metres from the truck, and the door itself. Empty when the walk has no line. */
export function walkStations(path: readonly GeoPoint[], stepM = WALK_SLOPE_STATION_STEP_M): WalkStation[] {
  const lengthM = polylineLengthM(path);
  if (path.length < 2 || lengthM <= 0) return [];
  const out: WalkStation[] = [];
  for (let s = 0; s < lengthM - stepM / 10; s += stepM) out.push({ alongM: s, at: pointAlongPolyline(path, s) as GeoPoint });
  out.push({ alongM: lengthM, at: path[path.length - 1] as GeoPoint });
  return out;
}

/** Steep going down to the door, steep going up, or neither. */
type StepClass = 'down' | 'flat' | 'up';

interface Run {
  fromIndex: number;
  toIndex: number;
  cls: StepClass;
}

/**
 * The stretches of the walk. `elevationsM[i]` is the height at `stations[i]`.
 * Null when there is nothing to read (fewer than two stations, or heights
 * that do not match them).
 */
export function walkSlopeProfile(
  path: readonly GeoPoint[],
  stations: readonly WalkStation[],
  elevationsM: readonly number[],
  isSteep: (gradePct: number) => boolean,
  minSegmentM = WALK_SLOPE_MIN_SEGMENT_M,
): WalkSlopeProfile | null {
  if (stations.length < 2 || elevationsM.length !== stations.length) return null;
  const along = stations.map((s) => s.alongM);
  const classes = stepClasses(along, elevationsM, isSteep, minSegmentM);
  growShortSteep(classes, along, minSegmentM);
  const segments = absorbShort(runsOf(classes), along, minSegmentM).map((run) =>
    segmentOf(path, along, elevationsM, run, isSteep),
  );
  return summaryOf(along[along.length - 1] as number, segments, elevationsM);
}

/** Each 5 m step, classed by the grade of the `windowM` window centred on it (clamped inside the walk). */
function stepClasses(
  along: readonly number[],
  elevationsM: readonly number[],
  isSteep: (gradePct: number) => boolean,
  windowM: number,
): StepClass[] {
  const lengthM = along[along.length - 1] as number;
  const zAt = (s: number) => interpolate(along, elevationsM, s);
  const out: StepClass[] = [];
  for (let i = 0; i < along.length - 1; i += 1) {
    const mid = ((along[i] as number) + (along[i + 1] as number)) / 2;
    const lo = Math.max(0, Math.min(mid - windowM / 2, lengthM - windowM));
    const hi = Math.min(lengthM, lo + windowM);
    const grade = hi > lo ? (100 * (zAt(hi) - zAt(lo))) / (hi - lo) : 0;
    out.push(!isSteep(Math.abs(grade)) ? 'flat' : grade < 0 ? 'down' : 'up');
  }
  return out;
}

/**
 * A steep run shorter than `minSegmentM` takes the flat steps on either side,
 * one at a time, until it is long enough or has nothing flat left to take.
 */
function growShortSteep(classes: StepClass[], along: readonly number[], minSegmentM: number): void {
  for (let grown = true; grown; ) {
    grown = false;
    for (const run of runsOf(classes)) {
      if (run.cls === 'flat' || lengthOf(run, along) >= minSegmentM) continue;
      for (const k of [run.fromIndex - 1, run.toIndex]) {
        if (classes[k] === 'flat') {
          classes[k] = run.cls;
          grown = true;
        }
      }
      if (grown) break;
    }
  }
}

/** Consecutive steps of one class, one run; `toIndex` is the station that ends it. */
function runsOf(classes: readonly StepClass[]): Run[] {
  const out: Run[] = [];
  classes.forEach((cls, i) => {
    const last = out[out.length - 1];
    if (last !== undefined && last.cls === cls) last.toIndex = i + 1;
    else out.push({ fromIndex: i, toIndex: i + 1, cls });
  });
  return out;
}

function lengthOf(run: Run, along: readonly number[]): number {
  return (along[run.toIndex] as number) - (along[run.fromIndex] as number);
}

function segmentOf(
  path: readonly GeoPoint[],
  along: readonly number[],
  elevationsM: readonly number[],
  run: Run,
  isSteep: (gradePct: number) => boolean,
): WalkSlopeSegment {
  const fromM = along[run.fromIndex] as number;
  const toM = along[run.toIndex] as number;
  const startElevationM = elevationsM[run.fromIndex] as number;
  const endElevationM = elevationsM[run.toIndex] as number;
  const gradePct = toM > fromM ? (100 * (endElevationM - startElevationM)) / (toM - fromM) : 0;
  return {
    fromM,
    toM,
    startElevationM,
    endElevationM,
    gradePct,
    steep: isSteep(Math.abs(gradePct)),
    path: slicePolyline(path, fromM, toM),
  };
}

function summaryOf(
  lengthM: number,
  segments: readonly WalkSlopeSegment[],
  elevationsM: readonly number[],
): WalkSlopeProfile {
  let descentM = 0;
  let ascentM = 0;
  for (const seg of segments) {
    const delta = seg.endElevationM - seg.startElevationM;
    if (delta < 0) descentM -= delta;
    else ascentM += delta;
  }
  return {
    lengthM,
    netM: (elevationsM[elevationsM.length - 1] as number) - (elevationsM[0] as number),
    descentM,
    ascentM,
    steepM: segments.filter((s) => s.steep).reduce((sum, s) => sum + (s.toM - s.fromM), 0),
    maxGradePct: Math.max(...segments.map((s) => Math.abs(s.gradePct))),
    segments,
  };
}

/**
 * A run still shorter than `minSegmentM` is not a stretch: it goes to its
 * longer neighbour, whose class it takes. Shortest first, until every run is
 * long enough or only one is left.
 */
function absorbShort(runs: Run[], along: readonly number[], minSegmentM: number): Run[] {
  let current = runs;
  for (;;) {
    const short = current
      .map((run, i) => ({ run, i }))
      .filter(({ run }) => lengthOf(run, along) < minSegmentM)
      .sort((a, b) => lengthOf(a.run, along) - lengthOf(b.run, along))[0];
    if (short === undefined || current.length === 1) return current;
    const prev = current[short.i - 1];
    const next = current[short.i + 1];
    const into = prev === undefined || (next !== undefined && lengthOf(next, along) > lengthOf(prev, along)) ? next : prev;
    if (into === undefined) return current;
    into.fromIndex = Math.min(into.fromIndex, short.run.fromIndex);
    into.toIndex = Math.max(into.toIndex, short.run.toIndex);
    current = mergeRuns(current.filter((_, i) => i !== short.i));
  }
}

/** Neighbouring runs of one class, one run. */
function mergeRuns(runs: readonly Run[]): Run[] {
  const out: Run[] = [];
  for (const run of runs) {
    const last = out[out.length - 1];
    if (last !== undefined && last.cls === run.cls) last.toIndex = run.toIndex;
    else out.push({ ...run });
  }
  return out;
}

/** Linear between the two stations around `s`. */
function interpolate(along: readonly number[], values: readonly number[], s: number): number {
  let i = 1;
  while (i < along.length - 1 && (along[i] as number) < s) i += 1;
  const a = along[i - 1] as number;
  const b = along[i] as number;
  const t = b > a ? Math.max(0, Math.min(1, (s - a) / (b - a))) : 0;
  return (values[i - 1] as number) + t * ((values[i] as number) - (values[i - 1] as number));
}
