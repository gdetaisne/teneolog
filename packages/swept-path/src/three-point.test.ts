/**
 * Le trois temps (`three-point.ts`), contrats §2 de
 * la note de conception interne.
 *
 * Ce qui est sous test : la cinématique (un arc est un arc), la cohérence entre
 * largeurs (une rue plus large ne coûte jamais un temps sans branche ; avec une
 * branche, ce n'est pas garanti, et c'est dit), la symétrie des côtés, la
 * différence des deux variantes, le test de couloir qui ne laisse pas la caisse
 * couper l'angle, le déterminisme, la largeur de branche inconnue jamais
 * inventée ni une branche inutilisée mesurée, les entrées illisibles dites par
 * leur nom, et le temps de calcul. La fermeture (d) et le balayage continu (k)
 * sont dans `three-point-closure.test.ts`, avec leur couloir de référence
 * exact. La cohérence avec le requis du « un temps » (`turnaroundRequirementM`,
 * une seule source) est dans `packages/projection/test/three-point-coherence.test.ts`,
 * là où les deux paquets se voient.
 */
import { describe, expect, it } from 'vitest';

import { add, leftNormal, scale, truckFootprint } from './geometry.js';
import {
  advanceRearAxle,
  PL_19T_TRUCK,
  rearAxleMinTurnRadiusM,
  steadyStateOfftrackingM,
} from './kinematics.js';
import { bodyFitsCorridor, canonicalCorridor } from './three-point-corridor.js';
import { simulateThreePointTurn, type ThreePointTurnInput, type ThreePointTurnResult } from './three-point.js';
import type { Point, Pose } from './types.js';

const T = PL_19T_TRUCK;
const RR = Math.sqrt(11 * 11 - 6.1 * 6.1);

function simulate(overrides: Partial<ThreePointTurnInput>): ThreePointTurnResult {
  return simulateThreePointTurn({
    truck: T,
    streetWidthM: 5,
    side: 'right',
    variant: 'no_branch',
    branch: null,
    ...overrides,
  });
}

function tempsOrInfinity(result: ThreePointTurnResult): number {
  return result.temps ?? Number.POSITIVE_INFINITY;
}

/** Wrapped heading gap, degrees. */
function headingGapDeg(a: number, b: number): number {
  const gap = (((b - a) % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI) - Math.PI;
  return Math.abs((gap * 180) / Math.PI);
}

describe('(a) un arc au braquage maxi est un arc — `advanceRearAxle`, `rearAxleMinTurnRadiusM`', () => {
  it('Rr = √(R² − L²) = 9,15 m pour le 19 t, et le déport de toujours n’a pas bougé d’un bit', () => {
    expect(rearAxleMinTurnRadiusM(T.turnRadiusM, T.wheelbaseM)).toBeCloseTo(9.154, 3);
    for (const [r, l] of [[11, 6.1], [12.5, 3.9], [7, 3.2], [9, 5]] as const) {
      expect(steadyStateOfftrackingM(r, l)).toBe(r - Math.sqrt(r * r - l * l));
    }
    expect(steadyStateOfftrackingM(5, 6)).toBe(5);
    expect(steadyStateOfftrackingM(0, 6)).toBe(0);
    expect(steadyStateOfftrackingM(11, 0)).toBe(0);
  });

  it('un arc de longueur s tourne le cap de s/Rr et garde l’essieu arrière sur le cercle de rayon Rr', () => {
    const start: Pose = { x: 3, y: -2, headingRad: 0.4 };
    for (const steer of [1, -1] as const) {
      // Le centre, pris à la main : à Rr sur la droite du conducteur pour +1 (repère y vers le bas).
      const right = leftNormal({ x: Math.cos(start.headingRad), y: Math.sin(start.headingRad) });
      const centre = add(start, scale(right, steer * RR));
      for (const s of [0.5, 4, 12, 25]) {
        const forward = advanceRearAxle(start, steer, s, RR);
        expect(forward.headingRad - start.headingRad).toBeCloseTo((steer * s) / RR, 9);
        expect(Math.hypot(forward.x - centre.x, forward.y - centre.y)).toBeCloseTo(RR, 2);
        const backward = advanceRearAxle(start, steer, -s, RR);
        expect(backward.headingRad - start.headingRad).toBeCloseTo((-steer * s) / RR, 9);
        expect(Math.hypot(backward.x - centre.x, backward.y - centre.y)).toBeCloseTo(RR, 2);
      }
    }
  });

  it('+1 braque vers la droite du conducteur : en avant, l’essieu part vers y > 0 depuis le cap 0', () => {
    const moved = advanceRearAxle({ x: 0, y: 0, headingRad: 0 }, 1, 2, RR);
    expect(moved.y).toBeGreaterThan(0);
    expect(moved.headingRad).toBeGreaterThan(0);
    const straight = advanceRearAxle({ x: 1, y: 1, headingRad: Math.PI / 2 }, 0, 3, RR);
    expect(straight.x).toBeCloseTo(1, 12);
    expect(straight.y).toBeCloseTo(4, 12);
  });

  it('la caisse du trois temps est le rectangle de toujours, au bit près', () => {
    const pose: Pose = { x: 1.7, y: -0.3, headingRad: 2.1 };
    const forward = { x: Math.cos(pose.headingRad), y: Math.sin(pose.headingRad) };
    const side = leftNormal(forward);
    const front = add(pose, scale(forward, T.wheelbaseM + T.frontOverhangM));
    const rear = add(pose, scale(forward, -T.rearOverhangM));
    expect(truckFootprint(pose, T)).toEqual([
      add(front, scale(side, T.widthM / 2)),
      add(front, scale(side, -T.widthM / 2)),
      add(rear, scale(side, -T.widthM / 2)),
      add(rear, scale(side, T.widthM / 2)),
    ]);
  });
});

describe('(c) une rue plus large ne coûte jamais un temps sans branche — avec une branche, ce n’est pas garanti', () => {
  it('sans branche, de 10 à 26 m tous les 10 cm (vérifié aussi au centimètre de 3 à 26 m, hors test)', () => {
    let previous = Number.POSITIVE_INFINITY;
    for (let w = 10; w <= 26 + 1e-9; w += 0.1) {
      const temps = tempsOrInfinity(simulate({ streetWidthM: w }));
      expect(temps, `${w.toFixed(1)} m`).toBeLessThanOrEqual(previous);
      previous = temps;
    }
  });

  // Une limite du modèle, pas du terrain : chaque mouvement s'arrête au premier contact, et quelques
  // centimètres de plus déplacent ce contact. Mesuré au pas de 5 cm à 90° (2026-09-24) : 16 hausses
  // sur 33 182 cas, dont 9 jusqu'à « pas de solution ». Épinglé pour que la prose se relise le jour
  // où le modèle change — pas pour le figer.
  it('branche à 90°, en arrière, rue de 8,20 m : 5 temps avec 4,50 m de branche, aucun avec 4,55 m', () => {
    const at = (widthM: number) =>
      simulate({ variant: 'reverse_into_branch', streetWidthM: 8.2, branch: { angleDeg: 90, widthM } });
    expect(at(4.5).temps).toBe(5);
    expect(at(4.55).status).toBe('not_found');
  });

  // Les repères du contrat §2 (« en avant, trois temps dès 7,15 m de branche pour une rue de 5 à
  // 10 m ») : sous 5 m de rue, il en faut plus. Mesurés au pas de 5 cm.
  it('branche à 90°, en avant : trois temps dès 7,15 m de branche de 5 à 10 m de rue, 8,15 m à 4,5 m, 9,50 m à 4 m', () => {
    const temps = (streetWidthM: number, widthM: number) =>
      simulate({ variant: 'forward_into_branch', streetWidthM, branch: { angleDeg: 90, widthM } }).temps;
    for (const [streetWidthM, threshold] of [[4, 9.5], [4.5, 8.15], [5, 7.15], [10, 7.15]] as const) {
      expect(temps(streetWidthM, threshold), `rue ${streetWidthM}`).toBe(3);
      expect(temps(streetWidthM, threshold - 0.05), `rue ${streetWidthM}`).not.toBe(3);
    }
    expect(simulate({ variant: 'forward_into_branch', streetWidthM: 5, branch: { angleDeg: 90, widthM: 7.15 } }).branchDepthM).toBeCloseTo(12.85, 2);
  });
});

describe('(e) gauche et droite sont le miroir l’un de l’autre', () => {
  const variants: Array<Pick<ThreePointTurnInput, 'variant' | 'streetWidthM' | 'branch'>> = [
    { variant: 'no_branch', streetWidthM: 12, branch: null },
    { variant: 'forward_into_branch', streetWidthM: 5, branch: { angleDeg: 90, widthM: 8 } },
    { variant: 'reverse_into_branch', streetWidthM: 10, branch: { angleDeg: 75, widthM: null } },
  ];
  for (const geometry of variants) {
    it(geometry.variant, () => {
      const right = simulate({ ...geometry, side: 'right' });
      const left = simulate({ ...geometry, side: 'left' });
      expect(right.status).toBe('found');
      expect(left.temps).toBe(right.temps);
      expect(left.branchDepthM).toBe(right.branchDepthM);
      expect(left.branchWidthNeededM).toBe(right.branchWidthNeededM);
      right.ghostPoses.forEach((pose, i) => {
        const mirrored = left.ghostPoses[i]!;
        expect(mirrored.x).toBe(pose.x);
        expect(mirrored.y).toBe(-pose.y);
        expect(headingGapDeg(mirrored.headingRad, -pose.headingRad)).toBeLessThan(1e-9);
      });
      expect(left.bodyFootprints).toHaveLength(right.bodyFootprints.length);
      const key = (p: Point) => `${p.x.toFixed(9)},${p.y.toFixed(9)}`;
      right.bodyFootprints.forEach((footprint, i) => {
        const expected = footprint.map((p) => key({ x: p.x, y: -p.y })).sort();
        expect(left.bodyFootprints[i]!.map(key).sort()).toEqual(expected);
      });
    });
  }

  it('« left » est y < 0 : le nez entre dans une branche de gauche vers le haut du repère', () => {
    const left = simulate({ variant: 'forward_into_branch', side: 'left', branch: { angleDeg: 90, widthM: 8 } });
    expect(left.ghostPoses[0]!.y).toBeLessThan(-2.5);
    expect(left.ghostPoses[0]!.headingRad).toBeCloseTo(-Math.PI / 2, 9);
  });
});

describe('(f) l’avant et l’arrière dans la branche ne sont pas le même trois temps', () => {
  it('rue de 5 m, branche à 90° de largeur inconnue : même nombre, autre caisse, autre besoin', () => {
    const branch = { angleDeg: 90, widthM: null };
    const forward = simulate({ variant: 'forward_into_branch', branch });
    const reverse = simulate({ variant: 'reverse_into_branch', branch });
    expect(forward.temps).toBe(3);
    expect(reverse.temps).toBe(3);
    // L'avant finit son temps 1 le nez dans la branche (cap +90°) ; l'arrière finit son temps 2
    // l'arrière dans la branche, le nez dehors (cap −90°).
    expect(forward.ghostPoses[0]!.headingRad).toBeCloseTo(Math.PI / 2, 9);
    expect(reverse.ghostPoses[1]!.headingRad).toBeCloseTo(-Math.PI / 2, 9);
    expect(Math.abs(forward.branchDepthM! - reverse.branchDepthM!)).toBeGreaterThan(1);
    expect(Math.abs(forward.branchWidthNeededM! - reverse.branchWidthNeededM!)).toBeGreaterThan(1);
  });

  it('rue de 5 m, branche à 90° de 8 m : l’avant ressort en trois temps, l’arrière pas en neuf', () => {
    const branch = { angleDeg: 90, widthM: 8 };
    expect(simulate({ variant: 'forward_into_branch', branch }).temps).toBe(3);
    const reverse = simulate({ variant: 'reverse_into_branch', branch });
    expect(reverse.status).toBe('not_found');
    expect(reverse.reasonCodes).toContain('max_temps_reached');
  });
});

describe('(g) cinq temps, nommé', () => {
  // Largeurs mesurées au centimètre avec ce modèle (2026-09-24) : un temps dès 23,27 m, trois dès
  // 13,71 m, cinq dès 11,84 m, sept dès 11,05 m, neuf dès 10,61 m. Elles bougent si le modèle bouge :
  // alors ce test se relit, il ne se recale pas en silence.
  it('une rue de 12 m sans branche : le 19 t fait demi-tour en cinq temps (trois dès 13,71 m)', () => {
    const result = simulate({ streetWidthM: 12 });
    expect(result.temps).toBe(5);
    expect(result.ghostPoses).toHaveLength(5);
    expect(simulate({ streetWidthM: 11.83 }).temps).toBe(7);
    expect(simulate({ streetWidthM: 11.84 }).temps).toBe(5);
    expect(simulate({ streetWidthM: 13.7 }).temps).toBe(5);
    expect(simulate({ streetWidthM: 13.71 }).temps).toBe(3);
  });
});

describe('(h) le couloir ne laisse pas la caisse couper l’angle de la branche', () => {
  // Rue de 5 m, branche à droite (y > 0) à 90°, de 6 m : sommets rentrants en (±3 ; 2,5).
  const corridor = canonicalCorridor(5, { angleDeg: 90, widthM: 6 });
  const inUnion = (p: Point) => Math.abs(p.y) <= 2.5 || (p.y >= 0 && Math.abs(p.x) <= 3);

  it('tous coins dedans, l’angle rentrant DANS la caisse : refusé', () => {
    // Caisse posée en travers de l'angle (3 ; 2,5) : l'arrière dans la rue, l'avant dans la branche.
    const pose: Pose = { x: 6.2, y: 1.4, headingRad: (140 * Math.PI) / 180 };
    const corners = truckFootprint(pose, T);
    expect(corners.every(inUnion)).toBe(true);
    expect(pointInQuad({ x: 3, y: 2.5 }, corners)).toBe(true);
    expect(bodyFitsCorridor(corners, corridor, null)).toBe(false);
  });

  it('tous coins dedans, l’angle rentrant HORS de la caisse (elle passe derrière) : refusé aussi', () => {
    // Un rectangle en diagonale qui traverse le bâti (x > 3, y > 2,5) sans contenir l'angle : le test
    // « coins + sommets rentrants » le laisserait passer.
    const corners: Point[] = [
      { x: 1.5, y: 7.5 },
      { x: 2.2, y: 8.2 },
      { x: 8.2, y: 2.2 },
      { x: 7.5, y: 1.5 },
    ];
    expect(corners.every(inUnion)).toBe(true);
    const cornerOfBuilding = { x: 3, y: 2.5 };
    expect(pointInQuad(cornerOfBuilding, corners)).toBe(false);
    expect(pointInQuad({ x: 5, y: 5 }, corners)).toBe(true); // (5 ; 5) est dans le bâti
    expect(bodyFitsCorridor(corners, corridor, null)).toBe(false);
  });

  it('et une caisse vraiment dans la branche passe, à marge nulle', () => {
    const inBranch = truckFootprint({ x: 3 - 1.25, y: 3, headingRad: Math.PI / 2 }, T);
    expect(bodyFitsCorridor(inBranch, corridor, null)).toBe(true);
    const oneMillimetreOut = truckFootprint({ x: 3 - 1.249, y: 3, headingRad: Math.PI / 2 }, T);
    expect(bodyFitsCorridor(oneMillimetreOut, corridor, null)).toBe(false);
  });
});

function pointInQuad(p: Point, quad: readonly Point[]): boolean {
  let sign = 0;
  for (let i = 0; i < quad.length; i += 1) {
    const a = quad[i]!;
    const b = quad[(i + 1) % quad.length]!;
    const cross = Math.sign((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x));
    if (sign === 0) sign = cross;
    else if (cross !== 0 && cross !== sign) return false;
  }
  return true;
}

describe('(i) déterminisme', () => {
  it('deux appels, entrecoupés d’un autre, rendent le même résultat au bit près', () => {
    const input: ThreePointTurnInput = {
      truck: T,
      streetWidthM: 12,
      side: 'left',
      variant: 'reverse_into_branch',
      branch: { angleDeg: 80, widthM: null },
      withEnvelope: true,
    };
    const first = simulateThreePointTurn(input);
    expect(first.status).toBe('found');
    simulate({ variant: 'forward_into_branch', branch: { angleDeg: 120, widthM: 9 } });
    expect(simulateThreePointTurn(input)).toEqual(first);
  });
});

describe('(j) une branche de largeur inconnue : jamais inventée, ce qu’il faut est rendu', () => {
  it('la largeur nécessaire est rendue et dite, et elle suffit', () => {
    const input = { variant: 'forward_into_branch', streetWidthM: 5, branch: { angleDeg: 90, widthM: null } } as const;
    const unknown = simulate(input);
    expect(unknown.status).toBe('found');
    expect(unknown.reasonCodes).toContain('branch_width_unknown');
    expect(unknown.branchWidthNeededM).toBeGreaterThan(T.widthM);
    // Une branche déclarée à cette largeur (au centimètre près) tient la même manœuvre — ici à 90°, et
    // sur toute une grille de rues, d'angles et des deux variantes, au 19 t et au fourgon : (l).
    const declared = simulate({ ...input, branch: { angleDeg: 90, widthM: unknown.branchWidthNeededM! + 0.01 } });
    expect(declared.temps).toBe(unknown.temps);
    expect(declared.branchWidthNeededM).toBeNull();
    expect(declared.reasonCodes).not.toContain('branch_width_unknown');
  });

  it('une largeur connue n’est pas redemandée ; sans branche, ni profondeur ni largeur', () => {
    const known = simulate({ variant: 'forward_into_branch', branch: { angleDeg: 90, widthM: 8 } });
    expect(known.branchWidthNeededM).toBeNull();
    expect(known.branchDepthM).toBeGreaterThan(0);
    const street = simulate({ streetWidthM: 14 });
    expect(street.branchDepthM).toBeNull();
    expect(street.branchWidthNeededM).toBeNull();
  });

  it('une branche que la caisse ne prend pas : ni profondeur ni largeur, pas « il en faut 0 m »', () => {
    // La rue seule suffit : le modèle tourne sans passer le bord de la rue.
    for (const input of [
      { variant: 'reverse_into_branch', streetWidthM: 16, branch: { angleDeg: 90, widthM: null } },
      { variant: 'forward_into_branch', streetWidthM: 20, branch: { angleDeg: 90, widthM: null } },
    ] as const) {
      const result = simulate(input);
      expect(result.status).toBe('found');
      expect(result.branchDepthM).toBeNull();
      expect(result.branchWidthNeededM).toBeNull();
      expect(result.reasonCodes).toContain('branch_width_unknown');
      for (const footprint of result.bodyFootprints) {
        for (const corner of footprint) expect(Math.abs(corner.y)).toBeLessThanOrEqual(input.streetWidthM / 2 + 1e-5);
      }
    }
  });
});

describe('ce que le résultat dit toujours', () => {
  it('la lecture de R est dite partout ; les angles francs et la largeur inconnue quand il y a lieu', () => {
    expect(simulate({ streetWidthM: 14 }).reasonCodes).toEqual(['radius_front_axle_reading']);
    expect(simulate({ variant: 'forward_into_branch', branch: { angleDeg: 90, widthM: 8 } }).reasonCodes).toEqual([
      'radius_front_axle_reading',
      'model_sharp_corners',
    ]);
    expect(simulate({ streetWidthM: 14 }).minRearAxleRadiusM).toBeCloseTo(9.154, 3);
  });

  it('ce que le modèle ne sait pas faire est dit par son nom, jamais levé', () => {
    const reason = (input: Partial<ThreePointTurnInput>) => simulate(input).reasonCodes.at(-1);
    expect(reason({ streetWidthM: 2 })).toBe('street_narrower_than_truck');
    expect(reason({ streetWidthM: Number.NaN })).toBe('street_width_invalid');
    expect(reason({ variant: 'forward_into_branch', branch: null })).toBe('branch_missing');
    expect(reason({ variant: 'reverse_into_branch', branch: { angleDeg: 175, widthM: 8 } })).toBe(
      'branch_angle_outside_model',
    );
    expect(reason({ truck: { ...T, wheelbaseM: 12 } })).toBe('turn_radius_not_above_wheelbase');
    expect(reason({ streetWidthM: 9 })).toBe('max_temps_reached');
    // Un gabarit ou une branche illisibles ne donnent pas un « trouvé » muet (la fonction est un contrat public).
    const unreadableTrucks = [
      { ...T, widthM: Number.NaN },
      { ...T, lengthM: 0 },
      { ...T, wheelbaseM: -6.1 },
      { ...T, turnRadiusM: Number.POSITIVE_INFINITY },
      { ...T, frontOverhangM: undefined as unknown as number },
      { ...T, rearOverhangM: -0.1 },
    ];
    for (const truck of unreadableTrucks) {
      expect(reason({ streetWidthM: 14, truck }), JSON.stringify(truck)).toBe('truck_dimensions_invalid');
      expect(simulate({ streetWidthM: 14, truck }).status).toBe('not_found');
    }
    expect(simulate({ streetWidthM: 14, truck: { ...T, frontOverhangM: 0 } }).status).toBe('found'); // un nez plat est un vrai camion
    for (const widthM of [0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(reason({ variant: 'forward_into_branch', branch: { angleDeg: 90, widthM } }), String(widthM)).toBe(
        'branch_width_invalid',
      );
    }
    for (const bad of [{ streetWidthM: 2 }, { streetWidthM: 9 }]) {
      const result = simulate(bad);
      expect(result.status).toBe('not_found');
      expect(result.temps).toBeNull();
      expect(result.ghostPoses).toEqual([]);
    }
  });

  it('l’enveloppe n’est calculée que sur demande', () => {
    expect(simulate({ streetWidthM: 14 }).envelopePolygon).toEqual([]);
    expect(simulate({ streetWidthM: 14, withEnvelope: true }).envelopePolygon.length).toBeGreaterThan(3);
  });
});

describe('le temps de calcul (il tourne à chaque déplacement de la poignée)', () => {
  it('reste loin de la borne lâche de 50 ms par appel, sans enveloppe', () => {
    const inputs: Array<Partial<ThreePointTurnInput>> = [];
    for (const streetWidthM of [4, 5, 6, 8, 10, 12, 15]) {
      inputs.push({ streetWidthM });
      for (const angleDeg of [45, 90, 135]) {
        for (const widthM of [8, null]) {
          inputs.push({ variant: 'forward_into_branch', streetWidthM, branch: { angleDeg, widthM } });
          inputs.push({ variant: 'reverse_into_branch', streetWidthM, branch: { angleDeg, widthM } });
        }
      }
    }
    inputs.forEach((input) => simulate(input)); // échauffement du JIT
    const started = performance.now();
    let worst = 0;
    for (const input of inputs) {
      const t0 = performance.now();
      simulate(input);
      worst = Math.max(worst, performance.now() - t0);
    }
    const mean = (performance.now() - started) / inputs.length;
    console.info(`three-point: ${inputs.length} appels, moyenne ${mean.toFixed(2)} ms, pire ${worst.toFixed(2)} ms`);
    expect(mean).toBeLessThan(50);
    expect(worst).toBeLessThan(50);
  });
});
