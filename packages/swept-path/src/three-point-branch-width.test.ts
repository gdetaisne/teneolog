/**
 * La largeur de branche NÉCESSAIRE quand elle est inconnue (`three-point-branch-width.ts`,
 * contrat §2 de la note de conception interne) : ce que le modèle dit nécessaire lui suffit.
 *
 * (l) La lecture est exacte : sur un mouvement, la forme close rend le plus grand écart à l'axe de la
 *     branche de la part de la caisse au-delà du bord de la rue — ni moins (rien n'échappe entre deux
 *     poses), ni plus (aucun point compté hors de cette part). Avant la relecture, elle se lisait tous les
 *     2° de cap et ratait jusqu'à 0,6 m : déclarée un centimètre au-dessus de ce que le modèle disait
 *     nécessaire, la branche donnait plus de temps dans 72 cas sur 477 au 19 t, 48 sur 520 au fourgon.
 *
 * La part au-delà du bord est découpée ici, sans rien reprendre de `three-point-corridor.ts`, au niveau
 * y = h + 1 µm du couloir (sa tolérance, pas une marge).
 */
import { describe, expect, it } from 'vitest';

import { truckFootprint } from './geometry.js';
import { advanceRearAxle, PL_19T_TRUCK, rearAxleMinTurnRadiusM } from './kinematics.js';
import { sweptBranchHalfWidthM } from './three-point-branch-width.js';
import { canonicalCorridor } from './three-point-corridor.js';
import { planFor, searchThreePoint } from './three-point-search.js';
import { simulateThreePointTurn, type ThreePointVariant } from './three-point.js';
import type { Point, Pose, TruckSpec } from './types.js';

/** Le fourgon du catalogue (`config/policy.example.json`, `vul-fourgon`). */
const FOURGON: TruckSpec = {
  id: 'vul-fourgon',
  label: 'Fourgon',
  lengthM: 6,
  widthM: 2.1,
  wheelbaseM: 3.7,
  turnRadiusM: 7,
  frontOverhangM: 0.9,
  rearOverhangM: 1.4,
};
const EDGE_TOL_M = 1e-6;

/** Le plus grand |p·n| de la part de la caisse où y ≥ h + 1 µm : ses sommets, et les croisements de ses côtés. */
function beyondEdgeHalfWidthM(body: readonly Point[], h: number, angleDeg: number): number {
  const a = (angleDeg * Math.PI) / 180;
  const lateral = (x: number, y: number) => Math.abs(-x * Math.sin(a) + y * Math.cos(a));
  const edge = h + EDGE_TOL_M;
  let widest = 0;
  body.forEach((p, i) => {
    const q = body[(i + 1) % body.length]!;
    if (p.y >= edge) widest = Math.max(widest, lateral(p.x, p.y));
    if ((p.y - edge) * (q.y - edge) < 0) widest = Math.max(widest, lateral(p.x + ((edge - p.y) / (q.y - p.y)) * (q.x - p.x), edge));
  });
  return widest;
}

interface Move {
  readonly truck: TruckSpec;
  readonly streetWidthM: number;
  readonly angleDeg: number;
  readonly start: Pose;
  readonly steer: 1 | -1;
  readonly rotation: 1 | -1;
  readonly spanRad: number;
}

function exactHalfWidthM(move: Move): number {
  const rr = rearAxleMinTurnRadiusM(move.truck.turnRadiusM, move.truck.wheelbaseM);
  const corridor = canonicalCorridor(move.streetWidthM, { angleDeg: move.angleDeg, widthM: null });
  return sweptBranchHalfWidthM(corridor, move.truck, move.start, move.steer, move.rotation, rr, move.spanRad);
}

/** Le même mouvement rejoué, de `fromRad` à `toRad` de cap (bornés au mouvement), tous les `stepRad` : les écarts. */
function sampledHalfWidthsM(move: Move, fromRad: number, toRad: number, stepRad: number): number[] {
  const rr = rearAxleMinTurnRadiusM(move.truck.turnRadiusM, move.truck.wheelbaseM);
  const direction = move.steer * move.rotation;
  const from = Math.max(0, fromRad);
  const to = Math.min(move.spanRad, toRad);
  const count = Math.max(1, Math.ceil((to - from) / stepRad));
  return Array.from({ length: count + 1 }, (_, i) => {
    const pose = advanceRearAxle(move.start, move.steer, direction * (from + ((to - from) * i) / count) * rr, rr);
    return beyondEdgeHalfWidthM(truckFootprint(pose, move.truck), move.streetWidthM / 2, move.angleDeg);
  });
}

/**
 * Le plus grand écart du mouvement, cherché aux poses : tous les 0,01° de cap, puis tous les 0,00001°
 * autour de chaque maximum local à moins d'un millimètre du meilleur — le point qui file le long du
 * bord y avance de plus d'un dixième de millimètre par millième de degré.
 */
function replayedHalfWidthM(move: Move): number {
  const coarse = (0.01 * Math.PI) / 180;
  const fine = (0.00001 * Math.PI) / 180;
  const widths = sampledHalfWidthsM(move, 0, move.spanRad, coarse);
  const best = Math.max(...widths);
  let widest = best;
  widths.forEach((width, i) => {
    const peak = width >= (widths[i - 1] ?? 0) && width >= (widths[i + 1] ?? 0);
    if (!peak || width <= 0 || width < best - 1e-3) return;
    const at = (move.spanRad * i) / (widths.length - 1);
    widest = Math.max(widest, ...sampledHalfWidthsM(move, at - coarse, at + coarse, fine));
  });
  return widest;
}

/** Le balayage de la manœuvre servie (largeur inconnue), rejoué tous les 5 mm d'essieu arrière : sa plus grande largeur prise. */
function replayedWidthM(truck: TruckSpec, streetWidthM: number, variant: ThreePointVariant, angleDeg: number): number {
  const rr = rearAxleMinTurnRadiusM(truck.turnRadiusM, truck.wheelbaseM);
  const ctx = { truck, rr, corridor: canonicalCorridor(streetWidthM, { angleDeg, widthM: null }), unknownWidth: true };
  const attempt = searchThreePoint(ctx, planFor(variant, angleDeg), 9)!;
  let widest = 0;
  for (const segment of attempt.segments) {
    const count = Math.max(1, Math.ceil(segment.lengthM / 0.005));
    for (let i = 0; i <= count; i += 1) {
      const pose = advanceRearAxle(segment.start, segment.steer, (segment.direction * segment.lengthM * i) / count, rr);
      widest = Math.max(widest, beyondEdgeHalfWidthM(truckFootprint(pose, truck), streetWidthM / 2, angleDeg));
    }
  }
  return 2 * widest;
}

describe('(l) la largeur prise par un mouvement, en forme close', () => {
  it('égale le plus grand écart des poses rejouées, à 10 µm près, sur des mouvements quelconques', () => {
    let entering = 0;
    let seed = 7;
    const random = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    for (let i = 0; i < 200; i += 1) {
      const move: Move = {
        truck: i % 2 === 0 ? PL_19T_TRUCK : FOURGON,
        streetWidthM: 4 + 8 * random(),
        angleDeg: 20 + 140 * random(),
        start: { x: -6 + 12 * random(), y: -2 + 4 * random(), headingRad: -Math.PI + 2 * Math.PI * random() },
        steer: random() < 0.5 ? 1 : -1,
        rotation: random() < 0.5 ? 1 : -1,
        spanRad: Math.PI * random(),
      };
      const exact = exactHalfWidthM(move);
      const replayed = replayedHalfWidthM(move);
      if (replayed > 0) entering += 1;
      // Jamais sous une pose rejouée (rien n'échappe entre deux poses), jamais au-dessus (rien n'est inventé).
      expect(exact, `mouvement ${i}`).toBeGreaterThanOrEqual(replayed - 1e-9);
      expect(exact - replayed, `mouvement ${i}`).toBeLessThanOrEqual(1e-5);
    }
    expect(entering).toBeGreaterThan(60);
  });

  it('un grand côté qui glisse le long du bord entre deux poses à 2° : la largeur n’est plus ratée', () => {
    // Relecture de 19 t, rue de 5,25 m, branche à 80° de largeur inconnue, en avant. Servi
    // 9,62 m, alors que le balayage de la manœuvre servie, rejoué tous les 5 mm, en prenait 10,24 :
    // déclarée à 9,63 m, cinq temps.
    const input = { truck: PL_19T_TRUCK, streetWidthM: 5.25, side: 'right', variant: 'forward_into_branch' } as const;
    const unknown = simulateThreePointTurn({ ...input, branch: { angleDeg: 80, widthM: null } });
    expect(unknown.temps).toBe(3);
    const replayed = replayedWidthM(PL_19T_TRUCK, 5.25, 'forward_into_branch', 80);
    expect(unknown.branchWidthNeededM!).toBeGreaterThanOrEqual(replayed - 1e-6);
    const declared = simulateThreePointTurn({ ...input, branch: { angleDeg: 80, widthM: unknown.branchWidthNeededM! + 0.01 } });
    expect(declared.temps).toBe(3);
  });
});

describe('(l) ce que le modèle dit nécessaire lui suffit, sur une grille', () => {
  for (const truck of [PL_19T_TRUCK, FOURGON]) {
    it(`${truck.id} : rues de 3 à 15,5 m par 25 cm, branches de 20 à 160° par 10°, les deux variantes`, () => {
      const failures: string[] = [];
      let cases = 0;
      for (let step = 0; step <= 50; step += 1) {
        const streetWidthM = 3 + step * 0.25;
        if (streetWidthM < truck.widthM) continue;
        for (const variant of ['forward_into_branch', 'reverse_into_branch'] as const) {
          for (let angleDeg = 20; angleDeg <= 160; angleDeg += 10) {
            const input = { truck, streetWidthM, side: 'right', variant } as const;
            const unknown = simulateThreePointTurn({ ...input, branch: { angleDeg, widthM: null } });
            const needed = unknown.branchWidthNeededM;
            if (needed === null) continue;
            cases += 1;
            const where = `${variant}, rue ${streetWidthM} m, ${angleDeg}° : ${unknown.temps} temps, ${needed.toFixed(3)} m nécessaires`;
            const declared = simulateThreePointTurn({ ...input, branch: { angleDeg, widthM: needed + 0.01 } });
            if (declared.temps === null || declared.temps > unknown.temps!) failures.push(`${where} ; déclarée +1 cm : ${declared.temps}`);
            const replayed = replayedWidthM(truck, streetWidthM, variant, angleDeg);
            if (replayed > needed + 0.01) failures.push(`${where} ; balayage rejoué : ${replayed.toFixed(3)} m`);
          }
        }
      }
      expect(failures).toEqual([]);
      expect(cases).toBeGreaterThan(400);
    }, 60_000);
  }
});
