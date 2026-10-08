/**
 * le demi-tour dans l'espace réel (`turnaround-plan.ts`).
 *
 * Chaque cas échoue sans le code qu'il teste :
 *  - des espaces synthétiques (une voie qui débouche sur une place carrée, une
 *    voie seule) : ce que le modèle trouve, épinglé — il est déterministe ;
 * - la Sèvremoine, sur l'espace public servi 
 *    (`__fixtures__/sevremoine-turnaround.json`), avec et sans les deux voitures
 *    de la photo ;
 *  - un contre-examen INDÉPENDANT du chemin rendu : rejoué tous les 5 cm par
 *    un arc exact écrit ici (le rayon Rr / braquage, braquage partiel compris :
 * le chemin lissé ), la caisse testée contre les anneaux par un
 *    code écrit ici (pair-impair, côtés qui se coupent, sommet dedans) — pas
 *    par la grille ni les seaux du planificateur ;
 * - le chemin lissé : l'approche de la Sèvremoine sans zigzag, les
 *    mêmes temps, sens, fantômes et poses développées qu'avec le chemin brut ;
 *  - la table qui guide la recherche, contre une énumération indépendante des
 *    plus courts chemins de Dubins (mots C S C et C C C, en arcs exacts) ;
 *  - le déterminisme, les budgets, le semi qui ne recule pas, les entrées
 *    illisibles, le départ glissé, la vérification exacte qui refuse un chemin
 *    qui sort.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { truckFootprint } from './geometry.js';
import { advanceRearAxle, PL_19T_TRUCK, rearAxleMinTurnRadiusM } from './kinematics.js';
import { exitTable } from './turnaround-heuristic.js';
import { motionCtx, poseInSpace, sweepClear } from './turnaround-motion.js';
import {
  planTurnaround,
  planTurnaroundAsync,
  type TurnaroundMove,
  type TurnaroundPlanInput,
  type TurnaroundPlanResult,
} from './turnaround-plan.js';
import { pointInSpace, prepareSpace } from './turnaround-space.js';
import { verifyPath } from './turnaround-verify.js';
import type { Point, Pose, TruckSpec } from './types.js';

const FOURGON: TruckSpec = { id: 'vul-fourgon', label: 'Fourgon', lengthM: 6, widthM: 2.1, wheelbaseM: 3.7, turnRadiusM: 7, frontOverhangM: 0.9, rearOverhangM: 1.4 };
/** Le semi tel que le verdict et le fil le lisent (`toTruckSpec`) : d'un bloc, sellette → essieu 7,70 m, porte-à-faux du catalogue. */
const SEMI: TruckSpec = { id: 'semi-44t', label: 'Semi', lengthM: 16.5, widthM: 2.55, wheelbaseM: 7.7, turnRadiusM: 15, frontOverhangM: 1.4, rearOverhangM: 3 };

/** Une voie de largeur `w` le long de −x (de x = −L à 0) qui débouche sur une place carrée de côté `s`, centrée sur elle. */
function laneAndSquare(w: number, L: number, s: number): Point[][] {
  const h = w / 2;
  const q = s / 2;
  if (s <= 0) return [[{ x: -L, y: -h }, { x: 0, y: -h }, { x: 0, y: h }, { x: -L, y: h }]];
  return [[{ x: -L, y: -h }, { x: 0, y: -h }, { x: 0, y: -q }, { x: s, y: -q }, { x: s, y: q }, { x: 0, y: q }, { x: 0, y: h }, { x: -L, y: h }]];
}

/** Le camion arrêté dans la voie à 25 m de la place, cap vers elle ; il repart par l'axe de la voie. */
function synthetic(truck: TruckSpec, rings: Point[][], options: TurnaroundPlanInput['options'] = {}): TurnaroundPlanInput {
  const far = Math.max(...rings.flat().map((p) => p.x));
  const back = Math.min(...rings.flat().map((p) => p.x));
  return {
    truck,
    space: { rings },
    start: { x: -25, y: 0, headingRad: 0 },
    exit: { path: [{ x: far, y: 0 }, { x: back, y: 0 }] },
    // Le garde-fou d'horloge desserré : sous la charge des tests en parallèle, le résultat ne doit dépendre que du budget déterministe.
    options: { budgetMs: 60_000, ...options },
  };
}

interface Sèvremoine {
  readonly rings: Point[][];
  readonly start: Pose;
  readonly exitPath: Point[];
  readonly cars: Point[][];
}
const G = JSON.parse(readFileSync(new URL('./__fixtures__/sevremoine-turnaround.json', import.meta.url), 'utf8')) as Sèvremoine;

/** La Sèvremoine telle que le fil la pose : départ glissé d'au plus 1,5 m, portée de 32 m autour de l'axe. */
function sevremoine(truck: TruckSpec, extra: { cars?: boolean; reversingAllowed?: boolean } = {}): TurnaroundPlanInput {
  return {
    truck,
    space: { rings: extra.cars === true ? [...G.rings, ...G.cars] : G.rings },
    start: G.start,
    exit: { path: G.exitPath },
    options: { startShiftMaxM: 1.5, reachM: 32, reversingAllowed: extra.reversingAllowed ?? true, maxExpansions: 400_000, budgetMs: 30_000 },
  };
}

// ─── Le contre-examen indépendant ────────────────────────────────────────────

function insideRings(rings: readonly (readonly Point[])[], p: Point): boolean {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
      const a = ring[i]!;
      const b = ring[j]!;
      if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
  }
  return inside;
}

/** Les segments se touchent-ils ? Alignés, seulement s'ils se recouvrent (le nez de caisse dans le prolongement d'un bord n'y touche pas). */
function segmentsCross(a: Point, b: Point, c: Point, d: Point): boolean {
  const o = (p: Point, q: Point, r: Point): number => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  if (o(a, b, c) === 0 && o(a, b, d) === 0) {
    const along = (p: Point): number => (p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y);
    const [lo, hi] = [Math.min(along(c), along(d)), Math.max(along(c), along(d))];
    return hi >= 0 && lo <= along(b);
  }
  return o(a, b, c) * o(a, b, d) <= 0 && o(c, d, a) * o(c, d, b) <= 0;
}

/** La caisse est-elle dans l'espace ? Ses coins dedans, aucun côté qui coupe un bord, aucun sommet de bord en elle. */
function bodyInside(rings: readonly (readonly Point[])[], body: readonly Point[]): boolean {
  if (!body.every((p) => insideRings(rings, p))) return false;
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i += 1) {
      const c = ring[i]!;
      const d = ring[(i + 1) % ring.length]!;
      for (let k = 0; k < 4; k += 1) if (segmentsCross(body[k]!, body[(k + 1) % 4]!, c, d)) return false;
      if (insideRings([body], c)) return false;
    }
  }
  return true;
}

/**
 * L'arc exact de l'essieu arrière au braquage `steer` (une fraction du braquage maxi : le rayon vaut
 * Rr / steer), en forme close, écrit ici sans le code du paquet ; droit sous un nanoradian de virage.
 */
function arcAt(pose: Pose, steer: number, signedLengthM: number, rr: number): Pose {
  const turn = (steer * signedLengthM) / rr;
  const headingRad = pose.headingRad + turn;
  if (Math.abs(turn) < 1e-9) {
    return { x: pose.x + signedLengthM * Math.cos(pose.headingRad), y: pose.y + signedLengthM * Math.sin(pose.headingRad), headingRad };
  }
  const radius = rr / steer;
  return {
    x: pose.x + radius * (Math.sin(headingRad) - Math.sin(pose.headingRad)),
    y: pose.y - radius * (Math.cos(headingRad) - Math.cos(pose.headingRad)),
    headingRad,
  };
}

/** Rejoue le chemin rendu, tronçon par tronçon, tous les 5 cm, et rend les poses où la caisse sort ; jamais plus serré que Rr. */
function replayOutside(result: TurnaroundPlanResult, truck: TruckSpec, rings: readonly (readonly Point[])[]): Pose[] {
  const outside: Pose[] = [];
  for (const move of result.moves) {
    let pose = move.poses[0]!;
    for (const arc of move.arcs) {
      expect(Math.abs(arc.steer)).toBeLessThanOrEqual(1);
      const count = Math.ceil(arc.lengthM / 0.05);
      for (let i = 1; i <= count; i += 1) {
        const at = arcAt(pose, arc.steer, (move.dir * arc.lengthM * i) / count, result.minRearAxleRadiusM);
        if (!bodyInside(rings, truckFootprint(at, truck))) outside.push(at);
      }
      pose = arcAt(pose, arc.steer, move.dir * arc.lengthM, result.minRearAxleRadiusM);
    }
    const end = move.poses[move.poses.length - 1]!;
    expect(Math.hypot(pose.x - end.x, pose.y - end.y)).toBeLessThan(1e-6);
  }
  return outside;
}

/**
 * Référence indépendante de la table de la sortie : le plus court chemin EN AVANT, courbure ≤ 1/Rr,
 * de (d, φ) jusqu'à |d| ≤ lateralM et |φ| ≤ tol — par énumération fine (0,01 rad, 5 cm) des mots de
 * Dubins C S C et C C C (les plus courts chemins sont de ces formes), en arcs exacts, sans grille.
 */
function dubinsToExit(d0: number, phi0: number, r: number, lateralM: number, tol: number): number {
  const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));
  const arc = (d: number, phi: number, k: number, a: number): [number, number] => [d + k * r * (Math.cos(phi) - Math.cos(phi + k * a)), phi + k * a];
  const done = (d: number, phi: number): boolean => Math.abs(d) <= lateralM + 1e-9 && Math.abs(wrap(phi)) <= tol + 1e-9;
  /** Le plus petit angle, en tournant dans le sens k, qui ramène le cap dans la tolérance. */
  const toAlign = (phi: number, k: number): number => {
    const a = k > 0 ? wrap(-tol - phi) : wrap(phi - tol);
    return a < 0 ? a + 2 * Math.PI : a;
  };
  let best = Infinity;
  for (const k1 of [1, -1]) {
    for (let a1 = 0; a1 <= 2 * Math.PI && r * a1 < best; a1 += 0.01) {
      const [d1, p1] = arc(d0, phi0, k1, a1);
      if (done(d1, p1)) best = Math.min(best, r * a1);
      for (let s = 0; s <= 80 && r * a1 + s < best; s += 0.05) {
        const d2 = d1 + s * Math.sin(p1);
        if (done(d2, p1)) best = Math.min(best, r * a1 + s);
        for (const k3 of [1, -1]) {
          const a3 = toAlign(p1, k3);
          if (done(...arc(d2, p1, k3, a3))) best = Math.min(best, r * a1 + s + r * a3);
        }
      }
      for (let a2 = 0; a2 <= 2 * Math.PI && r * (a1 + a2) < best; a2 += 0.01) {
        const [d2, p2] = arc(d1, p1, -k1, a2);
        const a3 = toAlign(p2, k1);
        if (done(...arc(d2, p2, k1, a3))) best = Math.min(best, r * (a1 + a2 + a3));
      }
    }
  }
  return best;
}

const withoutClock = ({ elapsedMs: _elapsed, ...rest }: TurnaroundPlanResult): Omit<TurnaroundPlanResult, 'elapsedMs'> => rest;
const directions = (result: TurnaroundPlanResult): string => result.moves.map((m) => (m.dir === 1 ? 'F' : 'R')).join('');

// ─── Les espaces synthétiques ────────────────────────────────────────────────

describe('une voie de 6 m qui débouche sur une place carrée', () => {
  it('place de 17 m : le 19 t fait demi-tour en cinq temps (les guides disent trois ; le modèle en veut trois dès 18 m)', () => {
    const result = planTurnaround(synthetic(PL_19T_TRUCK, laneAndSquare(6, 40, 17)));
    expect(result.status).toBe('found');
    expect(result.temps).toBe(5);
    expect(directions(result)).toBe('FRFRF');
    expect(replayOutside(result, PL_19T_TRUCK, laneAndSquare(6, 40, 17))).toEqual([]);
    const wider = planTurnaround(synthetic(PL_19T_TRUCK, laneAndSquare(6, 40, 18)));
    expect(wider.temps).toBe(3);
  });

  it('place de 12 m : pas de demi-tour du 19 t en neuf temps au plus — une limite du modèle, dite, jamais un refus', () => {
    const result = planTurnaround(synthetic(PL_19T_TRUCK, laneAndSquare(6, 40, 12)));
    expect(result.status).toBe('not_found');
    expect(result.why).toBe('max_temps_reached');
    expect(result.moves).toEqual([]);
    // Le fourgon, lui, y tourne en trois.
    expect(planTurnaround(synthetic(FOURGON, laneAndSquare(6, 40, 12))).temps).toBe(3);
  });

  it('place de 26 m : un demi-tour en un temps, en avant', () => {
    const result = planTurnaround(synthetic(PL_19T_TRUCK, laneAndSquare(6, 40, 26)));
    expect(result.temps).toBe(1);
    expect(directions(result)).toBe('F');
  });
});

describe('une voie seule', () => {
  it('3 m : aucun demi-tour, tout le réseau atteignable parcouru', () => {
    const result = planTurnaround(synthetic(PL_19T_TRUCK, laneAndSquare(3, 60, 0)));
    expect(result).toMatchObject({ status: 'not_found', why: 'no_turn_in_space', temps: null });
    expect(result.expanded).toBeGreaterThan(0);
  });
});

// ─── La Sèvremoine ───────────────────────────────────────────────────────────

describe('7 Allée des Essais — l’espace public servi ', () => {
  const plain = planTurnaround(sevremoine(PL_19T_TRUCK));

  it('le 19 t : trois temps — en avant dans la placette, en arrière vers le bout de la voie, en avant vers la bouche', () => {
    expect(plain.status).toBe('found');
    expect(plain.temps).toBe(3);
    expect(directions(plain)).toBe('FRF');
    expect(plain.ghostPoses).toHaveLength(3);
    expect(plain.startShiftM).toBe(0);
    expect(plain.reasonCodes).toEqual(['radius_front_axle_reading', 'steering_instant', 'path_smoothed']);
    // L'arrivée : ~57 m jusqu'à la placette (l'arrêt est à s = 107,7 m, la placette à s ≈ 156–171 m).
    expect(plain.moves[0]!.lengthM).toBeGreaterThan(50);
    expect(plain.moves[0]!.lengthM).toBeLessThan(65);
  });

  it('le chemin ne sort jamais de l’espace : rejoué tous les 5 cm et testé par un code indépendant', () => {
    expect(replayOutside(plain, PL_19T_TRUCK, G.rings)).toEqual([]);
    expect(plain.minClearanceM).toBeGreaterThan(0);
  });

  it('avec les deux voitures de la photo : toujours trois temps — le chemin ne passe pas où elles sont', () => {
    const cars = planTurnaround(sevremoine(PL_19T_TRUCK, { cars: true }));
    expect(cars.temps).toBe(3);
    expect(replayOutside(cars, PL_19T_TRUCK, [...G.rings, ...G.cars])).toEqual([]);
  });

  it('sans marche arrière (le 19 t en semi-remorque de pensée) : rien — c’est bien la marche arrière qui fait les trois temps', () => {
    const forward = planTurnaround(sevremoine(PL_19T_TRUCK, { reversingAllowed: false }));
    expect(forward).toMatchObject({ status: 'not_found', why: 'no_turn_in_space' });
    expect(forward.reasonCodes).toContain('forward_only');
  });

  it('le semi, en avant seulement : pas de demi-tour en un temps dans la placette', () => {
    const semi = planTurnaround(sevremoine(SEMI, { reversingAllowed: false }));
    expect(semi).toMatchObject({ status: 'not_found', why: 'no_turn_in_space' });
  });

  it('le fourgon : trois temps aussi', () => {
    const vul = planTurnaround(sevremoine(FOURGON));
    expect(vul.temps).toBe(3);
    expect(replayOutside(vul, FOURGON, G.rings)).toEqual([]);
  });
});

// ─── Le chemin lissé ───────────────────────────────────────────────

/** Le plus grand virage du cap par demi-mètre de chemin, sur les `untilM` premiers mètres du mouvement, en degrés. */
function turnPerHalfMetreDeg(move: TurnaroundMove, untilM: number): number {
  let along = 0;
  let worst = 0;
  for (let i = 1; i < move.poses.length; i += 1) {
    const [a, b] = [move.poses[i - 1]!, move.poses[i]!];
    const step = Math.hypot(b.x - a.x, b.y - a.y);
    along += step;
    if (along > untilM) break;
    worst = Math.max(worst, ((Math.abs(b.headingRad - a.headingRad) * 180) / Math.PI) * (0.5 / step));
  }
  return worst;
}

/** Le plus grand saut du braquage d'un pas au suivant, en fraction du braquage maxi (2 : du plein droite au plein gauche). */
const steerJump = (move: TurnaroundMove): number =>
  move.arcs.reduce((worst, arc, i) => (i === 0 ? worst : Math.max(worst, Math.abs(arc.steer - move.arcs[i - 1]!.steer))), 0);

/** Ce que le cap fait d'aller-retour : la somme de ses virages moins le virage net, en degrés. */
function wiggleDeg(move: TurnaroundMove): number {
  let total = 0;
  for (let i = 1; i < move.poses.length; i += 1) total += Math.abs(move.poses[i]!.headingRad - move.poses[i - 1]!.headingRad);
  const net = Math.abs(move.poses[move.poses.length - 1]!.headingRad - move.poses[0]!.headingRad);
  return ((total - net) * 180) / Math.PI;
}

const unsmoothed = (input: TurnaroundPlanInput): TurnaroundPlanInput => ({ ...input, options: { ...input.options, smoothing: false } });

describe('le chemin lissé : le même demi-tour, sans les zigzags du braquage tout ou rien', () => {
  const input = sevremoine(PL_19T_TRUCK);
  const withEnvelope = { ...input, options: { ...input.options, withEnvelope: true } };
  const raw = planTurnaround(unsmoothed(withEnvelope));
  const smooth = planTurnaround(withEnvelope);
  const rr = rearAxleMinTurnRadiusM(PL_19T_TRUCK.turnRadiusM, PL_19T_TRUCK.wheelbaseM);
  /** Le braquage maxi tourne le cap de 0,5 / Rr par demi-mètre : 3,13° pour le 19 t. */
  const fullLockDeg = (0.5 / rr) * (180 / Math.PI);

  it('la Sèvremoine, 19 t : l’approche ne zigzague plus — sous la moitié du braquage maxi sur les 40 premiers mètres, et plus de saut du braquage', () => {
    const [before, after] = [raw.moves[0]!, smooth.moves[0]!];
    // Brut (Décision produit : « pas 100 % fluide ») : 19,8 m droit, 3,4 à gauche, 2,5 à droite, 13,4 droit,
    // 2,0 à gauche, 2,3 à droite, 15,5 à gauche — le braquage maxi dès l'approche, du plein droite au plein gauche
    // d'un pas à l'autre, ~60° d'aller-retour du cap.
    expect(before.arcs.map((a) => a.steer)).toEqual([0, 1, -1, 0, 1, -1, 1]);
    expect(before.smoothed).toBe(false);
    expect(turnPerHalfMetreDeg(before, 40)).toBeCloseTo(fullLockDeg, 2);
    expect(steerJump(before)).toBe(2);
    expect(wiggleDeg(before)).toBeGreaterThan(55);
    // Lissé : 1,42° au plus par demi-mètre, 0,13 du braquage maxi au plus d'un pas au suivant, ~14° d'aller-retour.
    expect(after.smoothed).toBe(true);
    expect(turnPerHalfMetreDeg(after, 40)).toBeLessThan(fullLockDeg / 2);
    expect(steerJump(after)).toBeLessThan(0.15);
    expect(wiggleDeg(after)).toBeLessThan(15);
    expect(smooth.reasonCodes).toContain('path_smoothed');
  });

  it('le chemin lissé reste dans l’espace (rejoué ici tous les 5 cm), au plus 0,5 m entre deux poses, sa caisse à plus de 2 cm du bord', () => {
    expect(replayOutside(smooth, PL_19T_TRUCK, G.rings)).toEqual([]);
    for (const move of smooth.moves) {
      for (let i = 1; i < move.poses.length; i += 1) {
        const [a, b] = [move.poses[i - 1]!, move.poses[i]!];
        expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeLessThanOrEqual(0.5 + 1e-9);
      }
    }
    expect(smooth.minClearanceM!).toBeGreaterThan(0.02);
  });

  it('l’enveloppe, son aire et les caisses sont celles du chemin servi, pas du chemin brut', () => {
    const served = smooth.moves.flatMap((move, k) => (k === 0 ? move.poses : move.poses.slice(1)));
    expect(smooth.bodyFootprints).toEqual(served.map((pose) => truckFootprint(pose, PL_19T_TRUCK)));
    expect(smooth.envelopeAreaM2).not.toBe(raw.envelopeAreaM2);
    expect(Math.abs(smooth.envelopeAreaM2! / unionAreaM2(smooth.bodyFootprints) - 1)).toBeLessThan(0.02);
  });

  it('la recherche ne change pas : mêmes temps, sens, fantômes, départ et poses développées, avec ou sans lissage', () => {
    const inputs: [string, TurnaroundPlanInput][] = [
      ['Sèvremoine 19 t', sevremoine(PL_19T_TRUCK)],
      ['Sèvremoine fourgon', sevremoine(FOURGON)],
      ['place de 17 m, cinq temps', synthetic(PL_19T_TRUCK, laneAndSquare(6, 40, 17))],
      ['place de 26 m, un temps', synthetic(PL_19T_TRUCK, laneAndSquare(6, 40, 26))],
      ['la variante compacte', synthetic(PL_19T_TRUCK, laneAndSquare(13, 60, 20), { maxTemps: 5, tempsCostM: 5 })],
    ];
    for (const [name, input] of inputs) {
      const [plain, served] = [planTurnaround(unsmoothed(input)), planTurnaround(input)];
      expect(served.status, name).toBe('found');
      expect(served.temps, name).toBe(plain.temps);
      expect(directions(served), name).toBe(directions(plain));
      expect(served.ghostPoses, name).toEqual(plain.ghostPoses);
      expect(served.ghostFootprints, name).toEqual(plain.ghostFootprints);
      expect(served.start, name).toEqual(plain.start);
      expect(served.expanded, name).toBe(plain.expanded);
      // Chaque mouvement commence et finit où la recherche le fait commencer et finir.
      served.moves.forEach((move, k) => {
        expect(move.poses[0], name).toEqual(plain.moves[k]!.poses[0]);
        expect(move.poses[move.poses.length - 1], name).toEqual(plain.moves[k]!.poses[plain.moves[k]!.poses.length - 1]);
      });
      // Un mouvement que le lissage n'a pas retenu est celui de la recherche, au bit près.
      served.moves.forEach((move, k) => {
        if (!move.smoothed) expect(move, name).toEqual(plain.moves[k]);
      });
    }
  });

  it('entre deux braquages maxi de sens contraires, rien à adoucir sans sortir du braquage maxi : le chemin de la recherche, au bit près', () => {
    // L'espace ouvert de 64 m : le demi-tour en un temps, plein gauche puis plein droite pour revenir dans l'axe.
    const input = synthetic(PL_19T_TRUCK, laneAndSquare(64, 60, 0), { withEnvelope: true });
    const [plain, served] = [planTurnaround(unsmoothed(input)), planTurnaround(input)];
    expect(plain.moves[0]!.arcs.map((a) => a.steer)).toEqual([1, -1]);
    expect(served.moves[0]!.smoothed).toBe(false);
    expect(withoutClock(served)).toEqual(withoutClock(plain));
  });
});

// ─── Le semi, le déterminisme, les budgets ───────────────────────────────────

describe('un grand espace ouvert : la table de la sortie guide la recherche', () => {
  it('64 m de large : le demi-tour en un temps, en quelques milliers de poses (sans la table : 418 000, le budget épuisé)', () => {
    const open = laneAndSquare(64, 60, 0);
    const result = planTurnaround(synthetic(PL_19T_TRUCK, open));
    expect(result).toMatchObject({ status: 'found', temps: 1 });
    expect(result.expanded).toBeLessThan(10_000);
    expect(replayOutside(result, PL_19T_TRUCK, open)).toEqual([]);
  });

  it('la table de la sortie : zéro sur le but, et à 5 % près du plus court chemin en avant (Dubins), du fourgon au semi', () => {
    const tol = (5 * Math.PI) / 180;
    // Rr du fourgon, du 19 t et du semi : la table d'avant tournait d'une case de 5° par pas de 0,5 m pour
    // tout Rr de 3,8 à 11,5 m (le 19 t y virait comme un camion de 5,7 m), et jamais pour le semi (table nulle).
    for (const rr of [5.94, 9.15, 12.87]) {
      const table = exitTable(rr, 2, tol);
      expect(table.lookup(0, 0)).toBe(0);
      expect(table.lookup(1.5, (3 * Math.PI) / 180)).toBe(0);
      for (const [d, phi] of [[0, Math.PI], [10, Math.PI], [0, Math.PI / 2], [5, Math.PI / 4], [-15, (2 * Math.PI) / 3]] as const) {
        const reference = dubinsToExit(d, phi, rr, 2, tol);
        expect(Math.abs(table.lookup(d, phi) / reference - 1), `Rr ${rr}, (${d} m, ${phi.toFixed(2)} rad)`).toBeLessThan(0.05);
      }
      // Un seul virage suffit : l'écart de cap à tourner, et rien de plus.
      expect(table.lookup(-rr, Math.PI / 2)).toBeCloseTo(rr * (Math.PI / 2 - tol), 0);
      // Au-delà de la table, la distance latérale s'ajoute.
      expect(table.lookup(60, 0)).toBeGreaterThanOrEqual(table.lookup(48, 0) + 12 - 1e-9);
    }
  });
});

describe('le semi ne recule pas', () => {
  it('sur une place de 36 m : un temps, en avant ; de 30 m : rien, alors que le 19 t y recule', () => {
    const big = planTurnaround(synthetic(SEMI, laneAndSquare(6, 40, 36), { reversingAllowed: false }));
    expect(big.temps).toBe(1);
    expect(big.moves.every((m) => m.dir === 1)).toBe(true);
    const small = planTurnaround(synthetic(SEMI, laneAndSquare(6, 40, 30), { reversingAllowed: false }));
    expect(small).toMatchObject({ status: 'not_found', why: 'no_turn_in_space' });
    expect(small.reasonCodes).toContain('forward_only');
  });

  it('sur une place de 50 m : un temps aussi, guidé par la table du semi', () => {
    // Plus de place, plus de poses : sans la table, ~630 000 poses. Avec une table nulle (Rr 12,9 m arrondi à
    // zéro case de cap par pas, la table d'avant le 2026-09-25), le budget s'épuisait.
    const open = laneAndSquare(6, 40, 50);
    const result = planTurnaround(synthetic(SEMI, open, { reversingAllowed: false }));
    expect(result).toMatchObject({ status: 'found', temps: 1 });
    expect(result.reasonCodes).toContain('forward_only');
    expect(result.expanded).toBeLessThan(100_000);
    expect(replayOutside(result, SEMI, open)).toEqual([]);
  });
});

// ─── Le prix d'un temps, et l'aire balayée (la variante compacte) ───

/** L'aire de l'union des caisses, comptée ici : un point tous les 5 cm, dans au moins une caisse — sans la grille du paquet. */
function unionAreaM2(footprints: readonly (readonly Point[])[]): number {
  const all = footprints.flat();
  const [x0, x1] = [Math.min(...all.map((p) => p.x)), Math.max(...all.map((p) => p.x))];
  const [y0, y1] = [Math.min(...all.map((p) => p.y)), Math.max(...all.map((p) => p.y))];
  const h = 0.05;
  let inside = 0;
  for (let y = y0 + h / 2; y < y1; y += h) {
    for (let x = x0 + h / 2; x < x1; x += h) if (footprints.some((fp) => insideRings([fp], { x, y }))) inside += 1;
  }
  return inside * h * h;
}

describe('un temps moins cher (`tempsCostM`) : la recherche échange des temps contre de la place', () => {
  // Une voie de 13 m (le 19 t y tourne en cinq temps) qui débouche, 25 m devant l'arrêt, sur une place de 20 m (trois temps).
  const rings = laneAndSquare(13, 60, 20);

  it('par défaut, le moins de temps : trois, en allant jusqu’à la place ; à 5 m le temps, cinq dans la voie, 24 % de place en moins', () => {
    const best = planTurnaround(synthetic(PL_19T_TRUCK, rings, { maxTemps: 5, withEnvelope: true }));
    expect(best).toMatchObject({ status: 'found', temps: 3 });
    expect(best.moves[0]!.lengthM).toBeGreaterThan(25);
    const compact = planTurnaround(synthetic(PL_19T_TRUCK, rings, { maxTemps: 5, withEnvelope: true, tempsCostM: 5 }));
    expect(compact).toMatchObject({ status: 'found', temps: 5 });
    expect(directions(compact)).toBe('FRFRF');
    expect(compact.moves[0]!.lengthM).toBeLessThan(10);
    expect(compact.envelopeAreaM2!).toBeLessThan(best.envelopeAreaM2! * 0.8);
    expect(replayOutside(compact, PL_19T_TRUCK, rings)).toEqual([]);
  });

  it('le prix par défaut est celui d’avant : la même entrée, avec ou sans `tempsCostM: 10 000`, rend le même résultat', () => {
    const input = synthetic(PL_19T_TRUCK, laneAndSquare(6, 40, 18), { withEnvelope: true });
    const explicit = { ...input, options: { ...input.options, tempsCostM: 10_000 } };
    expect(withoutClock(planTurnaround(explicit))).toEqual(withoutClock(planTurnaround(input)));
  });

  it('l’enveloppe est l’union raster des caisses, son aire celle de ses cases pleines — comptée ici sans la grille', () => {
    // Le trois temps du 19 t sur une place de 18 m : ~186 m² d'union ; le contour de `rasterFootprintEnvelope`,
    // qui ne repasse jamais par un sommet, n'en traçait que ~103 m² (le 2026-09-25) — le fil ne le lit plus.
    const result = planTurnaround(synthetic(PL_19T_TRUCK, laneAndSquare(6, 40, 18), { withEnvelope: true }));
    const reference = unionAreaM2(result.bodyFootprints);
    expect(Math.abs(result.envelopeAreaM2! / reference - 1)).toBeLessThan(0.02);
    const raster = result.envelopeRaster!;
    expect(raster.cells.reduce((n, c) => n + c, 0) * raster.cellM ** 2).toBeCloseTo(result.envelopeAreaM2!, 6);
    // Sans enveloppe demandée, ou sans chemin : pas d'aire.
    expect(planTurnaround(synthetic(PL_19T_TRUCK, laneAndSquare(6, 40, 18))).envelopeAreaM2).toBeNull();
    expect(planTurnaround(synthetic(PL_19T_TRUCK, laneAndSquare(6, 40, 12), { withEnvelope: true })).envelopeAreaM2).toBeNull();
  });
});

describe('rendu à la boucle d’événements (`planTurnaroundAsync`, relecture du 2026-09-25)', () => {
  /** Le plus grand trou entre deux tours d'un minuteur de 5 ms, et quand part un minuteur de 50 ms, pendant `work`. */
  async function loopWhile(work: () => Promise<unknown>): Promise<{ maxGapMs: number; fiftyFiredAtMs: number }> {
    let last = performance.now();
    let maxGapMs = 0;
    const ticker = setInterval(() => {
      const now = performance.now();
      maxGapMs = Math.max(maxGapMs, now - last);
      last = now;
    }, 5);
    const scheduled = performance.now();
    let fiftyFiredAtMs = Infinity;
    setTimeout(() => {
      fiftyFiredAtMs = performance.now() - scheduled;
    }, 50);
    await work();
    await new Promise((resolve) => setTimeout(resolve, 60));
    clearInterval(ticker);
    return { maxGapMs, fiftyFiredAtMs };
  }
  const yieldImmediate = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

  it('le même résultat que d’une traite, au bit près hors la durée', async () => {
    const input = synthetic(PL_19T_TRUCK, laneAndSquare(6, 40, 17), { withEnvelope: true, maxTemps: 5 });
    const sliced = await planTurnaroundAsync(input, { sliceMs: 2, yieldControl: yieldImmediate });
    expect(withoutClock(sliced)).toEqual(withoutClock(planTurnaround(input)));
    expect(sliced.temps).toBe(5);
  });

  it('pendant une recherche d’une seconde, un minuteur de 50 ms part avec moins de 100 ms de retard ; d’une traite, non', async () => {
    // Une voie de 12 m sur 120 m : le budget de 300 000 poses s'y épuise (~1 s sur le Mac de dev).
    const input = synthetic(PL_19T_TRUCK, laneAndSquare(12, 120, 0));
    let result: TurnaroundPlanResult | null = null;
    const sliced = await loopWhile(async () => {
      result = await planTurnaroundAsync(input, { sliceMs: 30, yieldControl: yieldImmediate });
    });
    expect(result!).toMatchObject({ status: 'not_found', why: 'budget_exhausted', expanded: 300_000 });
    expect(sliced.fiftyFiredAtMs).toBeLessThan(150);
    expect(sliced.maxGapMs).toBeLessThan(150);
    const blocking = await loopWhile(async () => planTurnaround(input));
    expect(blocking.fiftyFiredAtMs).toBeGreaterThan(400);
  }, 30_000);
});

describe('déterministe et borné', () => {
  it('la même entrée rend le même résultat, au bit près (hors la durée)', () => {
    const input = synthetic(PL_19T_TRUCK, laneAndSquare(6, 40, 18), { withEnvelope: true });
    expect(withoutClock(planTurnaround(input))).toEqual(withoutClock(planTurnaround(input)));
  });

  it('le budget d’expansions est tenu, et un budget épuisé est « pas trouvé », dit par son nom', () => {
    const result = planTurnaround(synthetic(PL_19T_TRUCK, laneAndSquare(6, 40, 17), { maxExpansions: 1_000 }));
    expect(result).toMatchObject({ status: 'not_found', why: 'budget_exhausted', expanded: 1_000 });
    expect(result.reasonCodes).toContain('budget_expansions');
  });

  it('le garde-fou d’horloge coupe aussitôt un budget nul', () => {
    const result = planTurnaround(synthetic(PL_19T_TRUCK, laneAndSquare(6, 40, 17), { budgetMs: 0 }));
    expect(result).toMatchObject({ status: 'not_found', why: 'budget_exhausted', expanded: 0 });
    expect(result.reasonCodes).toContain('budget_time');
  });
});

// ─── Les trous, le départ, la vérification ───────────────────────────────────

describe('un trou dans l’espace (une borne, une voiture)', () => {
  it('une borne de 20 cm tout entière dans le balayage d’un pas, loin de ses bords : le pas est refusé', () => {
    // L'avant du 19 t passe de x = −10,2 à −9,7 : la borne [−10,0 ; −9,8] tient dans l'enveloppe du pas
    // sans qu'aucun de ses bords ne l'approche à moins de 20 cm. Seul le test « un anneau entier dedans » la voit.
    const bollard = [{ x: -10.0, y: -0.1 }, { x: -9.8, y: -0.1 }, { x: -9.8, y: 0.1 }, { x: -10.0, y: 0.1 }];
    const ctxOf = (rings: Point[][]) => {
      const prepared = prepareSpace(rings);
      if (!prepared.ok) throw new Error(prepared.why);
      return motionCtx(prepared.space, PL_19T_TRUCK, 9.15, 0.02);
    };
    const from = { x: -17.5, y: 0, headingRad: 0 };
    const to = advanceRearAxle(from, 0, 0.5, 9.15);
    expect(sweepClear(ctxOf(laneAndSquare(6, 40, 0)), from, to, 0, 0.5)).toBe(true);
    expect(sweepClear(ctxOf([...laneAndSquare(6, 40, 0), bollard]), from, to, 0, 0.5)).toBe(false);
    // Et sous la caisse à l'arrêt : la pose de départ n'est pas dans l'espace.
    expect(poseInSpace(ctxOf([...laneAndSquare(6, 40, 0), bollard]), to)).toBe(false);
  });

  it('un poteau que la caisse balaie ENTRE deux poses, sans qu’aucune des deux ne le touche : le pas est refusé', () => {
    // 3 m au braquage maxi (19°) : au milieu du pas, le coin avant droit passe à plus d'un mètre des deux
    // caisses d'extrémité. Un test aux seules poses laisserait passer le poteau posé là.
    const from = { x: 0, y: 0, headingRad: 0 };
    const to = advanceRearAxle(from, 1, 3, 9.15);
    const corner = truckFootprint(advanceRearAxle(from, 1, 1.5, 9.15), PL_19T_TRUCK)[1]!;
    const post = [{ x: -0.2, y: 0 }, { x: -0.1, y: 0 }, { x: -0.1, y: 0.1 }, { x: -0.2, y: 0.1 }].map((p) => ({ x: corner.x + p.x, y: corner.y + p.y }));
    const square = [[{ x: -20, y: -20 }, { x: 40, y: -20 }, { x: 40, y: 40 }, { x: -20, y: 40 }]];
    const ctxOf = (rings: Point[][]) => {
      const prepared = prepareSpace(rings);
      if (!prepared.ok) throw new Error(prepared.why);
      return motionCtx(prepared.space, PL_19T_TRUCK, 9.15, 0.02);
    };
    const withPost = ctxOf([...square, post]);
    expect(poseInSpace(withPost, from)).toBe(true);
    expect(poseInSpace(withPost, to)).toBe(true);
    expect(sweepClear(withPost, from, to, 1, 3)).toBe(false);
    expect(sweepClear(ctxOf(square), from, to, 1, 3)).toBe(true);
  });

  it('la même borne au milieu d’une voie de 3,2 m : aucun chemin ne passe dessus', () => {
    const bollard = [{ x: -10.0, y: -0.1 }, { x: -9.8, y: -0.1 }, { x: -9.8, y: 0.1 }, { x: -10.0, y: 0.1 }];
    const open = laneAndSquare(3.2, 40, 30);
    expect(planTurnaround(synthetic(PL_19T_TRUCK, open)).temps).toBe(3);
    const blocked = planTurnaround(synthetic(PL_19T_TRUCK, [...open, bollard]));
    expect(blocked).toMatchObject({ status: 'not_found', why: 'no_turn_in_space' });
  });

  it('une borne de 30 cm sur l’axe de la place : aucune caisse ne passe dessus', () => {
    const bollard = [{ x: 7.85, y: -0.15 }, { x: 8.15, y: -0.15 }, { x: 8.15, y: 0.15 }, { x: 7.85, y: 0.15 }];
    const rings = [...laneAndSquare(6, 40, 26), bollard];
    const result = planTurnaround(synthetic(PL_19T_TRUCK, rings));
    expect(result.status).toBe('found');
    expect(replayOutside(result, PL_19T_TRUCK, rings)).toEqual([]);
  });
});

describe('le recul suit le chemin d’arrivée depuis l’arrêt, pas sa projection sur le chemin de sortie', () => {
  it('sans chemin d’arrivée, pas de recul : l’arrêt au bout reste hors de l’espace', () => {
    const lane = laneAndSquare(6, 80, 0);
    const input: TurnaroundPlanInput = {
      truck: PL_19T_TRUCK,
      space: { rings: lane },
      start: { x: -2, y: 0, headingRad: 0 },
      exit: { path: [{ x: 0, y: 0 }, { x: -80, y: 0 }] },
      options: { startBackMaxM: PL_19T_TRUCK.lengthM, budgetMs: 60_000 },
    };
    expect(planTurnaround(input)).toMatchObject({ status: 'not_found', why: 'start_outside_space' });
    const moved = planTurnaround({ ...input, arrival: { path: [{ x: -2, y: 0 }, { x: -80, y: 0 }] } });
    expect(moved.startBackM).toBe(5.5);
    expect(moved.start!.x).toBeCloseTo(-7.5, 6);
  });
});

describe('les aires interdites (`space.forbidden`) : à part des anneaux de l’espace, jamais en trous pair-impair', () => {
  it('une aire qui déborde de l’espace n’y ajoute rien : un départ au-delà du bout de la voie, dans le parc, est hors de l’espace', () => {
    // Seconde relecture du 2026-09-25 : en trou pair-impair, la part du parc hors de l'espace comptait une fois — « dedans ».
    const lane = laneAndSquare(8, 80, 0);
    const park = [{ x: -2, y: -30 }, { x: 60, y: -30 }, { x: 60, y: 30 }, { x: -2, y: 30 }];
    const beyond = { ...synthetic(FOURGON, lane), start: { x: 4, y: 0, headingRad: 0 }, exit: { path: [{ x: 12, y: 0 }, { x: -80, y: 0 }] } };
    expect(planTurnaround({ ...beyond, space: { rings: [...lane, park] } }).status).toBe('found');
    expect(planTurnaround({ ...beyond, space: { rings: lane, forbidden: [park] } })).toMatchObject({
      status: 'not_found',
      why: 'start_outside_space',
    });
  });

  it('deux aires qui se chevauchent restent interdites l’une et l’autre ; un point de l’espace hors d’elles reste dedans', () => {
    const prepared = prepareSpace(laneAndSquare(6, 40, 26), [
      [{ x: 1, y: -14 }, { x: 28, y: -14 }, { x: 28, y: 14 }, { x: 1, y: 14 }],
      [{ x: 8, y: -4 }, { x: 18, y: -4 }, { x: 18, y: 4 }, { x: 8, y: 4 }],
    ]);
    if (!prepared.ok) throw new Error(prepared.why);
    expect(pointInSpace(prepared.space, 13, 0)).toBe(false);
    expect(pointInSpace(prepared.space, 4, 10)).toBe(false);
    expect(pointInSpace(prepared.space, -20, 0)).toBe(true);
    expect(pointInSpace(prepared.space, 30, 0)).toBe(false);
  });

  it('une place piétonne sur la place de 26 m : plus de demi-tour en un temps dessus', () => {
    const square = laneAndSquare(6, 40, 26);
    expect(planTurnaround(synthetic(PL_19T_TRUCK, square)).temps).toBe(1);
    const covered = planTurnaround({
      ...synthetic(PL_19T_TRUCK, square, { maxTemps: 5 }),
      space: { rings: square, forbidden: [[{ x: 1, y: -14 }, { x: 28, y: -14 }, { x: 28, y: 14 }, { x: 1, y: 14 }]] },
    });
    expect(covered.status).toBe('not_found');
  });
});

describe('le départ', () => {
  it('posé hors de l’espace : dit, jamais levé ; glissé de côté quand la policy le permet', () => {
    const rings = laneAndSquare(6, 40, 26);
    const offAxis = { ...synthetic(PL_19T_TRUCK, rings), start: { x: -25, y: 2.2, headingRad: 0 } };
    expect(planTurnaround(offAxis)).toMatchObject({ status: 'not_found', why: 'start_outside_space' });
    const shifted = planTurnaround({ ...offAxis, options: { startShiftMaxM: 1.5 } });
    expect(shifted.status).toBe('found');
    expect(shifted.reasonCodes).toContain('start_shifted');
    // La caisse (2,5 m) tient quand l'essieu est à au plus 3 − 1,25 − 0,02 = 1,73 m de l'axe : 2,2 → 1,7, par pas de 5 cm.
    expect(shifted.startShiftM).toBeCloseTo(-0.5, 6);
  });
});

describe('l’arrêt au bout de l’impasse : la pose reculée le long du chemin de sortie (`startBackMaxM`)', () => {
  // Une voie de 6 m qui finit à x = 0, une placette de 18 × 16 m sur le côté nord, de x = −32 à −14.
  const rings = [[{ x: -80, y: -3 }, { x: 0, y: -3 }, { x: 0, y: 3 }, { x: -14, y: 3 }, { x: -14, y: 19 }, { x: -32, y: 19 }, { x: -32, y: 3 }, { x: -80, y: 3 }]];
  const atTip = (truck: TruckSpec, beforeTipM: number, startBackMaxM: number, reversingAllowed = true): TurnaroundPlanInput => ({
    truck,
    space: { rings },
    start: { x: -beforeTipM, y: 0, headingRad: 0 },
    exit: { path: [{ x: 0, y: 0 }, { x: -80, y: 0 }] },
    arrival: { path: [{ x: -beforeTipM, y: 0 }, { x: -80, y: 0 }] },
    options: { startShiftMaxM: 1.5, startBackMaxM, reversingAllowed, maxTemps: 5, budgetMs: 60_000 },
  });

  it('l’arrêt à 2 m du bout : sans recul, la caisse dépasse le bout (start_outside_space) ; reculée de 5,5 m, trois temps', () => {
    expect(planTurnaround(atTip(PL_19T_TRUCK, 2, 0))).toMatchObject({ status: 'not_found', why: 'start_outside_space' });
    const moved = planTurnaround(atTip(PL_19T_TRUCK, 2, PL_19T_TRUCK.lengthM));
    expect(moved).toMatchObject({ status: 'found', temps: 3, startBackM: 5.5 });
    expect(moved.reasonCodes).toContain('start_moved_back');
    // Empattement + porte-à-faux avant = 7,3 m au-delà de l'essieu : il faut reculer d'au moins 5,32 m, par pas de 25 cm.
    expect(moved.start!.x).toBeCloseTo(-7.5, 6);
    expect(moved.start!.headingRad).toBeCloseTo(0, 6);
    expect(replayOutside(moved, PL_19T_TRUCK, rings)).toEqual([]);
  });

  it('le semi y reçoit sa vraie raison (no_turn_in_space), plus celle de sa pose ; une pose qui tient ne recule pas', () => {
    const semi = planTurnaround(atTip(SEMI, 2, SEMI.lengthM, false));
    expect(semi).toMatchObject({ status: 'not_found', why: 'no_turn_in_space' });
    const room = planTurnaround(atTip(PL_19T_TRUCK, 8, PL_19T_TRUCK.lengthM));
    expect(room).toMatchObject({ status: 'found', temps: 3, startBackM: 0 });
    expect(room.reasonCodes).not.toContain('start_moved_back');
  });
});

describe('une impasse en « P », le chemin de sortie coupé au col (le fil le coupe : `exitPathOf`)', () => {
  // Une tige de 6 m (x de −60 à 0) qui débouche sur un pâté de 53 × 26 m autour d'un îlot (un trou) ;
  // le bout est, à 8 m entre l'îlot et le bord, trop serré pour que le 19 t fasse le tour.
  const outer = [[-60, -3], [-3, -3], [-3, -13], [50, -13], [50, 13], [-3, 13], [-3, 3], [-60, 3]].map(([x, y]) => ({ x: x!, y: y! }));
  const island = [[8, -7], [42, -7], [42, 7], [8, 7]].map(([x, y]) => ({ x: x!, y: y! }));
  const stem = [{ x: 0, y: 0 }, { x: -60, y: 0 }];
  const input = (start: Pose): TurnaroundPlanInput => ({
    truck: PL_19T_TRUCK,
    space: { rings: [outer, island] },
    start,
    exit: { path: stem },
    options: { maxTemps: 5, budgetMs: 60_000, reachM: 32 },
  });

  it('l’arrêt dans la tige : trois temps, fini dans la tige, vers la bouche', () => {
    const result = planTurnaround(input({ x: -20, y: 0, headingRad: 0 }));
    expect(result).toMatchObject({ status: 'found', temps: 3 });
    expect(directions(result)).toBe('FRF');
    const last = result.ghostPoses[result.ghostPoses.length - 1]!;
    expect(last.x).toBeLessThan(0);
    expect(Math.cos(last.headingRad)).toBeLessThan(-0.99);
  });

  it('l’arrêt sur la moitié retour de la boucle, déjà tourné vers le col : un temps, ~31 m en avant jusque dans la tige', () => {
    // Relecture du 2026-09-25 : une garde « cap final à plus de 90° du cap d'arrivée » le refusait (max_temps_reached
    // après 209 560 poses) ; elle est retirée, la coupe au col suffit.
    const result = planTurnaround(input({ x: 25, y: -10, headingRad: Math.PI }));
    expect(result).toMatchObject({ status: 'found', temps: 1 });
    expect(directions(result)).toBe('F');
    const last = result.ghostPoses[0]!;
    expect(last.x).toBeLessThan(0);
    expect(Math.cos(last.headingRad)).toBeLessThan(-0.99);
    expect(replayOutside(result, PL_19T_TRUCK, [outer, island])).toEqual([]);
  });
});

describe('une impasse coudée : le dernier tronçon tourne de 120° sur une placette de 22 m', () => {
  // La tige monte vers le nord (x = 0, de y = −60 à 0), puis l'axe tourne de 120° sur 10 m ; l'arrêt 7 m après le coude.
  const turn = Math.PI / 2 - (120 * Math.PI) / 180;
  const axis = [{ x: 0, y: -60 }, { x: 0, y: 0 }, { x: 10 * Math.cos(turn), y: 10 * Math.sin(turn) }];
  const rings = [[[-4, -60], [4, -60], [4, -11], [11, -11], [11, 11], [-11, 11], [-11, -11], [-4, -11]].map(([x, y]) => ({ x: x!, y: y! }))];
  const at7 = { x: 7 * Math.cos(turn), y: 7 * Math.sin(turn), headingRad: turn };

  it('trois temps pour le 19 t et le fourgon (la garde du cap les poussait à cinq)', () => {
    for (const truck of [PL_19T_TRUCK, FOURGON]) {
      const result = planTurnaround({
        truck,
        space: { rings },
        start: at7,
        exit: { path: [...axis].reverse() },
        arrival: { path: [at7, axis[1]!, axis[0]!] },
        options: { maxTemps: 5, budgetMs: 60_000, reachM: 32, startShiftMaxM: 1.5, startBackMaxM: truck.lengthM },
      });
      expect(result, truck.id).toMatchObject({ status: 'found', temps: 3 });
      expect(directions(result)).toBe('RF');
      expect(replayOutside(result, truck, rings)).toEqual([]);
    }
  });
});

describe('ce que le modèle ne sait pas lire', () => {
  it('un gabarit, un espace, un départ ou une sortie illisibles sont nommés, jamais levés', () => {
    const base = synthetic(PL_19T_TRUCK, laneAndSquare(6, 40, 26));
    expect(planTurnaround({ ...base, truck: { ...PL_19T_TRUCK, widthM: 0 } }).why).toBe('truck_dimensions_invalid');
    expect(planTurnaround({ ...base, truck: { ...PL_19T_TRUCK, turnRadiusM: 6 } }).why).toBe('turn_radius_not_above_wheelbase');
    expect(planTurnaround({ ...base, space: { rings: [] } }).why).toBe('space_empty');
    expect(planTurnaround({ ...base, space: { rings: [[{ x: 0, y: 0 }, { x: Number.NaN, y: 1 }, { x: 1, y: 1 }]] } }).why).toBe('space_invalid');
    expect(planTurnaround({ ...base, start: { x: 0, y: Number.NaN, headingRad: 0 } }).why).toBe('start_invalid');
    expect(planTurnaround({ ...base, exit: { path: [{ x: 0, y: 0 }] } }).why).toBe('exit_path_invalid');
  });
});

describe('la vérification exacte', () => {
  it('refuse un chemin qui traverse un bord, même si on le lui présente comme trouvé', () => {
    const prepared = prepareSpace(laneAndSquare(6, 40, 0));
    if (!prepared.ok) throw new Error(prepared.why);
    const ctx = motionCtx(prepared.space, PL_19T_TRUCK, 9.15, 0.02);
    const start = { x: -25, y: 0, headingRad: 0 };
    const into = advanceRearAxle(start, 1, 6, 9.15); // braquage maxi : la caisse sort d'une voie de 6 m
    const path = [
      { pose: start, dir: 1 as const, steer: 0 as const, lengthM: 0 },
      { pose: into, dir: 1 as const, steer: 1 as const, lengthM: 6 },
    ];
    expect(verifyPath(ctx, path, 0).ok).toBe(false);
    const straight = [path[0]!, { pose: advanceRearAxle(start, 0, 6, 9.15), dir: 1 as const, steer: 0 as const, lengthM: 6 }];
    expect(verifyPath(ctx, straight, 9).ok).toBe(true);
  });
});
