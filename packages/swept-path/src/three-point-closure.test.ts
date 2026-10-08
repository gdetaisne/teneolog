/**
 * Le trois temps FINI, et DANS LE COULOIR d'un bout à l'autre (`three-point.ts`, contrat
 * §2 de la note de conception interne, relecture règle 6 du simulateur).
 *
 * (d) La fermeture : un nombre de temps montré à l'opérateur veut dire que la manœuvre est finie —
 *     le camion repart en avant, cap retourné à ±5°, la caisse entière dans la bande de la rue (plus
 *     rien dans la branche), et une longueur de camion tout droit devant elle aussi.
 * (k) Le balayage continu : les segments de la recherche sont rejoués tous les 5 mm d'essieu arrière,
 *     et chaque caisse est jugée contre un couloir de référence exact, coins de bâti compris. Avant
 *     la relecture, la caisse coupait le coin de bâti entre deux échantillons à 2° (jusqu'à 10 cm).
 *
 * Le couloir de référence est écrit ici, sans rien reprendre de `three-point-corridor.ts` : la caisse
 * est découpée par les deux demi-plans de chaque coin de bâti — là où le couloir découpe par le bord
 * de la rue puis lit la bande de la branche —, et l'on mesure de combien elle y entre.
 */
import { describe, expect, it } from 'vitest';

import { truckFootprint } from './geometry.js';
import { advanceRearAxle, PL_19T_TRUCK, rearAxleMinTurnRadiusM } from './kinematics.js';
import { canonicalCorridor } from './three-point-corridor.js';
import { planFor, searchThreePoint, type Attempt, type Segment } from './three-point-search.js';
import { simulateThreePointTurn, type ThreePointTurnInput } from './three-point.js';
import type { Point, Pose } from './types.js';

const T = PL_19T_TRUCK;
const RR = rearAxleMinTurnRadiusM(T.turnRadiusM, T.wheelbaseM);
/** Ce qu'on tolère d'entrée dans le bâti : 10 µm, dix fois la tolérance numérique du couloir. */
const INTRUSION_TOL_M = 1e-5;

type Geometry = Pick<ThreePointTurnInput, 'streetWidthM' | 'variant' | 'branch'>;

/** Sutherland–Hodgman : la part d'un polygone convexe où d ≥ 0. */
function clip(polygon: readonly Point[], d: (p: Point) => number): Point[] {
  const out: Point[] = [];
  polygon.forEach((p, i) => {
    const q = polygon[(i + 1) % polygon.length]!;
    const dp = d(p);
    const dq = d(q);
    if (dp >= 0) out.push(p);
    if (dp >= 0 !== dq >= 0) {
      const t = dp / (dp - dq);
      out.push({ x: p.x + t * (q.x - p.x), y: p.y + t * (q.y - p.y) });
    }
  });
  return out;
}

/**
 * Un coin de bâti W = {y ≥ h} ∩ {σ·(p·n) ≥ largeur/2} : de combien la caisse y entre, soit le max
 * sur caisse ∩ W de min(y − h, σ·p·n − largeur/2). Découpée par W, puis par f ≥ g et g ≥ f, où le min
 * est linéaire : son max est à un sommet.
 */
function wedgeIntrusionM(body: readonly Point[], h: number, n: Point, sigma: number, halfWidth: number): number {
  const f = (p: Point) => p.y - h;
  const g = (p: Point) => sigma * (p.x * n.x + p.y * n.y) - halfWidth;
  const inside = clip(clip(body, f), g);
  if (inside.length === 0) return 0;
  const whereG = clip(inside, (p) => f(p) - g(p)).map(g);
  const whereF = clip(inside, (p) => g(p) - f(p)).map(f);
  return Math.max(0, ...whereG, ...whereF);
}

/** De combien la caisse (repère canonique : branche du côté y > 0) sort du couloir, en mètres. */
function intrusionM(body: readonly Point[], geometry: Geometry): number {
  const h = geometry.streetWidthM / 2;
  const branch = geometry.variant === 'no_branch' ? null : geometry.branch;
  let depth = Math.max(0, ...body.map((p) => -h - p.y)); // le trottoir d'en face
  if (branch === null) return Math.max(depth, ...body.map((p) => p.y - h));
  if (branch.widthM === null) return depth; // largeur inconnue : rien de ce côté
  const a = (branch.angleDeg * Math.PI) / 180;
  const n = { x: -Math.sin(a), y: Math.cos(a) };
  for (const sigma of [1, -1]) depth = Math.max(depth, wedgeIntrusionM(body, h, n, sigma, branch.widthM / 2));
  return depth;
}

function canonical(points: readonly Point[], side: 'left' | 'right'): Point[] {
  return side === 'right' ? [...points] : points.map((p) => ({ x: p.x, y: -p.y }));
}

function inStreetBand(body: readonly Point[], streetWidthM: number): boolean {
  return body.every((p) => Math.abs(p.y) <= streetWidthM / 2 + INTRUSION_TOL_M);
}

function headingGapToPiDeg(headingRad: number): number {
  return (Math.acos(Math.max(-1, Math.min(1, -Math.cos(headingRad)))) * 180) / Math.PI;
}

/** The canonical search behind `simulateThreePointTurn` (right side), with its segments. */
function search(geometry: Geometry): Attempt | null {
  const branch = geometry.variant === 'no_branch' ? null : geometry.branch;
  const ctx = {
    truck: T,
    rr: RR,
    corridor: canonicalCorridor(geometry.streetWidthM, branch),
    unknownWidth: branch !== null && branch.widthM === null,
  };
  return searchThreePoint(ctx, planFor(geometry.variant, branch?.angleDeg ?? 180), 9);
}

function segmentEnd(segment: Segment): Pose {
  return advanceRearAxle(segment.start, segment.steer, segment.direction * segment.lengthM, RR);
}

/** The worst intrusion over the whole sweep, replayed every `stepM` of rear-axle travel. */
function worstIntrusionM(attempt: Attempt, geometry: Geometry, stepM: number): number {
  let worst = 0;
  for (const segment of attempt.segments) {
    const count = Math.max(1, Math.ceil(segment.lengthM / stepM));
    for (let i = 0; i <= count; i += 1) {
      const pose = advanceRearAxle(segment.start, segment.steer, (segment.direction * segment.lengthM * i) / count, RR);
      worst = Math.max(worst, intrusionM(truckFootprint(pose, T), geometry));
    }
  }
  return worst;
}

/**
 * The pose where the turn closes: the start of the drawn drive-away (a straight after a final
 * reverse), else the end of the last forward arc.
 */
function closingPose(attempt: Attempt): Pose {
  const last = attempt.segments.at(-1)!;
  return last.steer === 0 && attempt.segments.length > 1 ? last.start : segmentEnd(last);
}

/** Every claim of « le camion repart », checked on the replayed run. */
function expectLeaves(attempt: Attempt, geometry: Geometry, label: string): void {
  const close = closingPose(attempt);
  expect(headingGapToPiDeg(close.headingRad), label).toBeLessThanOrEqual(5 + 1e-9);
  expect(inStreetBand(truckFootprint(close, T), geometry.streetWidthM), `${label} : caisse dans la rue`).toBe(true);
  const ahead = advanceRearAxle(close, 0, T.lengthM, RR);
  expect(inStreetBand(truckFootprint(ahead, T), geometry.streetWidthM), `${label} : une longueur devant`).toBe(true);
  const last = attempt.segments.at(-1)!;
  if (last.steer === 0) expect(last.lengthM, `${label} : départ entier`).toBe(T.lengthM);
  expect(inStreetBand(truckFootprint(attempt.ghosts.at(-1)!, T), geometry.streetWidthM), label).toBe(true);
}

const label = (g: Geometry & { side?: string }) =>
  `${g.variant} ${g.side ?? 'right'}, rue ${g.streetWidthM} m, branche ${JSON.stringify(g.branch)}`;

describe('(d) la fermeture : le camion repart en sens inverse, dans la rue, sans sortir du couloir', () => {
  const cases: ThreePointTurnInput[] = [
    { truck: T, streetWidthM: 24, side: 'right', variant: 'no_branch', branch: null },
    { truck: T, streetWidthM: 12, side: 'left', variant: 'no_branch', branch: null },
    { truck: T, streetWidthM: 5, side: 'right', variant: 'forward_into_branch', branch: { angleDeg: 90, widthM: 8 } },
    { truck: T, streetWidthM: 5, side: 'left', variant: 'forward_into_branch', branch: { angleDeg: 90, widthM: 12 } },
    { truck: T, streetWidthM: 7, side: 'right', variant: 'reverse_into_branch', branch: { angleDeg: 90, widthM: 10 } },
    { truck: T, streetWidthM: 12, side: 'left', variant: 'reverse_into_branch', branch: { angleDeg: 80, widthM: null } },
    { truck: T, streetWidthM: 8, side: 'right', variant: 'forward_into_branch', branch: { angleDeg: 60, widthM: null } },
    { truck: T, streetWidthM: 9.25, side: 'left', variant: 'forward_into_branch', branch: { angleDeg: 70, widthM: 12 } },
  ];
  for (const input of cases) {
    it(label(input), () => {
      const result = simulateThreePointTurn(input);
      expect(result.status).toBe('found');
      expect(result.ghostPoses).toHaveLength(result.temps!);
      expect(result.ghostFootprints).toHaveLength(result.temps!);
      expect(result.temps! % 2).toBe(1);
      expect(headingGapToPiDeg(result.ghostPoses.at(-1)!.headingRad)).toBeLessThanOrEqual(5 + 1e-9);
      // La caisse entière, pas ses seuls coins : un coin de bâti se coupe entre deux coins.
      for (const footprint of [...result.ghostFootprints, ...result.bodyFootprints]) {
        expect(intrusionM(canonical(footprint, input.side), input)).toBeLessThanOrEqual(INTRUSION_TOL_M);
      }
      expect(inStreetBand(result.ghostFootprints.at(-1)!, input.streetWidthM), 'dernier fantôme dans la rue').toBe(true);
    });
  }
});

describe('(d) un demi-tour qui finit dans la branche n’est pas un demi-tour', () => {
  // Avant la relecture, trois temps « d'après le modèle » : le dernier fantôme au cap 180°, la caisse
  // entière dans la branche (y de 4,54 à 7,04 m, bord de la rue à 2,5 m), le nez à 47 cm du mur.
  it('19 t, rue de 5 m, branche à 110° de 12 m, en avant : plus de trois temps coincé', () => {
    const result = simulateThreePointTurn({
      truck: T,
      streetWidthM: 5,
      side: 'right',
      variant: 'forward_into_branch',
      branch: { angleDeg: 110, widthM: 12 },
    });
    expect(result.status).toBe('not_found');
    expect(result.reasonCodes).toContain('max_temps_reached');
  });

  // Largeur inconnue : la branche n'étant pas bornée, la caisse pouvait finir garée dans une « branche »
  // de 18 à 21 m de large inventée par le modèle. Ce n'était pas un demi-tour dans la rue.
  for (const input of [
    { streetWidthM: 6, side: 'right', variant: 'forward_into_branch', branch: { angleDeg: 110, widthM: null } },
    { streetWidthM: 8, side: 'left', variant: 'reverse_into_branch', branch: { angleDeg: 70, widthM: null } },
  ] as const) {
    it(`${label(input)} : pas de solution plutôt qu’un camion garé hors de la rue`, () => {
      const result = simulateThreePointTurn({ truck: T, ...input });
      expect(result.status).toBe('not_found');
      expect(result.reasonCodes).toContain('max_temps_reached');
    });
  }

  it('sur une grille, tout demi-tour trouvé finit dans la rue', () => {
    let found = 0;
    for (const variant of ['forward_into_branch', 'reverse_into_branch'] as const) {
      for (const streetWidthM of [4, 5, 6, 8, 10, 12]) {
        for (const angleDeg of [45, 70, 90, 110, 135]) {
          for (const widthM of [6, 9, 12, null]) {
            const input = { truck: T, streetWidthM, side: 'right', variant, branch: { angleDeg, widthM } } as const;
            const result = simulateThreePointTurn(input);
            if (result.status !== 'found') continue;
            found += 1;
            expect(inStreetBand(result.ghostFootprints.at(-1)!, streetWidthM), label(input)).toBe(true);
          }
        }
      }
    }
    expect(found).toBeGreaterThan(100);
  });
});

describe('(k) le balayage continu reste dans le couloir, coins de bâti compris', () => {
  // Les cas relevés à la relecture : la caisse coupait le coin de bâti entre deux échantillons.
  const named: Geometry[] = [
    { streetWidthM: 9.25, variant: 'forward_into_branch', branch: { angleDeg: 70, widthM: 12 } }, // 4,2 cm
    { streetWidthM: 10.75, variant: 'forward_into_branch', branch: { angleDeg: 70, widthM: 6 } }, // 10 cm
    { streetWidthM: 6, variant: 'forward_into_branch', branch: { angleDeg: 70, widthM: 8 } }, // 5,8 cm
    { streetWidthM: 10, variant: 'forward_into_branch', branch: { angleDeg: 60, widthM: 15 } }, // 3,7 cm
    { streetWidthM: 6, variant: 'reverse_into_branch', branch: { angleDeg: 105, widthM: 12 } }, // 3,5 cm
    // Seconde relecture : un mouvement qui repart de la pose de contact du précédent, le même coin
    // exactement sur le niveau et qui le franchit en partant — la racine à τ = −1e-15, repliée à 2π,
    // n'était pas vue. La caisse sortait du couloir de 0,93 mm (trottoir d'en face, 8,30 m ; coin de
    // bâti, 13,5 m) et de 1,38 mm (10,2 m), et le compte restait « trouvé ».
    { streetWidthM: 8.3, variant: 'reverse_into_branch', branch: { angleDeg: 70, widthM: 6 } }, // 3 → aucun
    { streetWidthM: 13.5, variant: 'forward_into_branch', branch: { angleDeg: 140, widthM: 12 } }, // 5 → aucun
    { streetWidthM: 10.2, variant: 'reverse_into_branch', branch: { angleDeg: 90, widthM: 3 } }, // 9, dans le couloir
  ];
  for (const geometry of named) {
    it(`${label(geometry)} : rejoué tous les 5 mm`, () => {
      const attempt = search(geometry);
      const served = simulateThreePointTurn({ truck: T, side: 'right', ...geometry });
      expect(attempt?.temps ?? null).toBe(served.temps);
      if (attempt === null) return; // pas de solution : rien n'est dessiné
      expect(served.ghostPoses.map((p) => [p.x, p.y])).toEqual(attempt.ghosts.map((p) => [p.x, p.y]));
      expect(worstIntrusionM(attempt, geometry, 0.005)).toBeLessThanOrEqual(INTRUSION_TOL_M);
      expectLeaves(attempt, geometry, label(geometry));
    });
  }

  it('sur une grille de rues, d’angles et de largeurs : rejoué tous les 2 cm', () => {
    let replayed = 0;
    for (const variant of ['forward_into_branch', 'reverse_into_branch'] as const) {
      for (const streetWidthM of [5, 6.5, 8, 8.3, 10.5]) {
        for (const angleDeg of [45, 70, 90, 110, 135]) {
          for (const widthM of [6, 8, 12, null]) {
            const geometry: Geometry = { streetWidthM, variant, branch: { angleDeg, widthM } };
            const attempt = search(geometry);
            if (attempt === null) continue;
            replayed += 1;
            expect(worstIntrusionM(attempt, geometry, 0.02), label(geometry)).toBeLessThanOrEqual(INTRUSION_TOL_M);
            expectLeaves(attempt, geometry, label(geometry));
          }
        }
      }
    }
    for (const streetWidthM of [10.7, 12, 14, 24]) {
      const geometry: Geometry = { streetWidthM, variant: 'no_branch', branch: null };
      const attempt = search(geometry)!;
      replayed += 1;
      expect(worstIntrusionM(attempt, geometry, 0.02), label(geometry)).toBeLessThanOrEqual(INTRUSION_TOL_M);
      expectLeaves(attempt, geometry, label(geometry));
    }
    expect(replayed).toBeGreaterThan(60);
  });

  it('le couloir de référence voit bien une caisse qui coupe le coin de bâti', () => {
    // Rue de 5 m, branche à 90° de 6 m : le coin de bâti de droite est {x ≥ 3, y ≥ 2,5}.
    const geometry: Geometry = { streetWidthM: 5, variant: 'forward_into_branch', branch: { angleDeg: 90, widthM: 6 } };
    const across = truckFootprint({ x: 6.2, y: 1.4, headingRad: (140 * Math.PI) / 180 }, T);
    expect(intrusionM(across, geometry)).toBeGreaterThan(0.1);
    const inBranch = truckFootprint({ x: 3 - 1.25, y: 3, headingRad: Math.PI / 2 }, T);
    expect(intrusionM(inBranch, geometry)).toBeLessThanOrEqual(INTRUSION_TOL_M);
    const oneMillimetreOut = truckFootprint({ x: 3 - 1.249, y: 3, headingRad: Math.PI / 2 }, T);
    expect(intrusionM(oneMillimetreOut, geometry)).toBeCloseTo(0.001, 6);
  });
});
