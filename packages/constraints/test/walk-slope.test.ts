/**
 * la pente du chemin à pied, par tronçons d'au moins 20 m (principe
 * 49 complété le 2026-09-29), sur le vrai cas : 3 route du Modèle, La Crèche,
 * de l'arrêt de repli Rue Voisine B à la porte, 268 m. Les altitudes sont
 * celles que l'IGN (RGE ALTI) a rendues le 2026-09-30 aux points tous les 5 m
 * de la ligne servie (`fixtures/la-creche-walk-ign.json`, avec la ligne elle-même).
 *
 * Ce que le responsable produit a vu sur la maquette et que l'écran doit pouvoir dire :
 * « descente de 17 m vers la porte, dont 80 m autour de 10 % ».
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import type { GeoPoint } from '@teneolog/domain';
import { haversineM, offsetPoint, polylineLengthM } from '@teneolog/topology';

import { walkSlopeProfile, walkStations, WALK_SLOPE_MIN_SEGMENT_M } from '../src/walk-slope.js';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/la-creche-walk-ign.json', import.meta.url), 'utf8'),
) as { path: GeoPoint[]; stations: { alongM: number; lat: number; lon: number; z: number }[] };

/** The hayon's rule as the wire injects it: 8 %, inclusive (`readTailLift`). */
const steepAt8 = (gradePct: number) => gradePct >= 8;

/** The walk the wire serves (`fallbackStop.walk.path`), stop first, door last. */
const LINE: GeoPoint[] = fixture.path;
const STATIONS = fixture.stations.map((s) => ({ alongM: s.alongM, at: { lat: s.lat, lon: s.lon } }));
const HEIGHTS = fixture.stations.map((s) => s.z);

describe('walkSlopeProfile — La Crèche, IGN RGE ALTI', () => {
  const profile = walkSlopeProfile(LINE, STATIONS, HEIGHTS, steepAt8);

  it('descend de 17 m vers la porte, sans remonter', () => {
    expect(profile).not.toBeNull();
    expect(profile!.netM).toBeCloseTo(-16.7, 1);
    expect(profile!.descentM).toBeCloseTo(16.7, 1);
    expect(profile!.ascentM).toBeLessThan(0.5);
    expect(profile!.lengthM).toBeCloseTo(268.5, 0);
  });

  it('un seul tronçon raide : ≈ 80 m autour de 10 %, sous les arbres, après l’entrée de l’impasse', () => {
    const steep = profile!.segments.filter((s) => s.steep);
    expect(steep).toHaveLength(1);
    const [s] = steep;
    expect(s!.toM - s!.fromM).toBeGreaterThanOrEqual(75);
    expect(s!.toM - s!.fromM).toBeLessThanOrEqual(90);
    expect(s!.gradePct).toBeLessThan(-9);
    expect(s!.gradePct).toBeGreaterThan(-11);
    // After Voisine B's 15 m and the mouth: the maquette's 30 → 110 m.
    expect(s!.fromM).toBeGreaterThanOrEqual(25);
    expect(s!.fromM).toBeLessThanOrEqual(35);
    expect(profile!.steepM).toBe(s!.toM - s!.fromM);
    expect(profile!.maxGradePct).toBeCloseTo(Math.abs(s!.gradePct), 6);
  });

  it('chaque tronçon fait au moins 20 m, ils se suivent sans trou de l’arrêt à la porte', () => {
    const segs = profile!.segments;
    expect(segs[0]!.fromM).toBe(0);
    expect(segs[segs.length - 1]!.toM).toBeCloseTo(268.5, 0);
    for (let i = 0; i < segs.length; i += 1) {
      expect(segs[i]!.toM - segs[i]!.fromM).toBeGreaterThanOrEqual(WALK_SLOPE_MIN_SEGMENT_M);
      if (i > 0) expect(segs[i]!.fromM).toBe(segs[i - 1]!.toM);
    }
  });

  it('la pente d’un tronçon est celle de ses deux bouts, et sa ligne est coupée dans la marche', () => {
    for (const s of profile!.segments) {
      expect(s.gradePct).toBeCloseTo((100 * (s.endElevationM - s.startElevationM)) / (s.toM - s.fromM), 9);
      expect(polylineLengthM(s.path)).toBeCloseTo(s.toM - s.fromM, 0);
    }
  });
});

describe('walkSlopeProfile — jamais un pic sur 5 m (principe 49)', () => {
  // A straight 100 m walk, flat but for one 5 m step of 0,8 m (16 %) in the middle.
  const start = { lat: 46.37, lon: -0.29 };
  const line = [start, offsetPoint(start, 90, 100)];
  const stations = walkStations(line);
  const heights = stations.map((s) => (s.alongM >= 50 ? 50.8 : 50));

  it('un seul pas raide ne fait pas un tronçon raide', () => {
    const profile = walkSlopeProfile(line, stations, heights, steepAt8);
    expect(profile!.segments.every((s) => !s.steep)).toBe(true);
    expect(profile!.steepM).toBe(0);
  });

  it('une vraie rampe de 20 m à 10 % en est un', () => {
    const ramp = stations.map((s) => 50 + Math.max(0, Math.min(20, s.alongM - 40)) * 0.1);
    const profile = walkSlopeProfile(line, stations, ramp, steepAt8);
    const steep = profile!.segments.filter((s) => s.steep);
    expect(steep).toHaveLength(1);
    expect(steep[0]!.gradePct).toBeGreaterThanOrEqual(8);
    expect(profile!.ascentM).toBeCloseTo(2, 6);
  });
});

describe('walkStations', () => {
  it('tous les 5 m depuis le camion, et la porte au bout', () => {
    const start = { lat: 46.37, lon: -0.29 };
    const line = [start, offsetPoint(start, 0, 12)];
    const st = walkStations(line);
    expect(st.map((s) => Math.round(s.alongM * 10) / 10)).toEqual([0, 5, 10, 12]);
    expect(haversineM(st[st.length - 1]!.at, line[1]!)).toBe(0);
  });

  it('pas de ligne, pas de station ; une marche de moins de 20 m est un seul tronçon', () => {
    expect(walkStations([])).toEqual([]);
    const start = { lat: 46.37, lon: -0.29 };
    const line = [start, offsetPoint(start, 0, 12)];
    const st = walkStations(line);
    const profile = walkSlopeProfile(line, st, [10, 10.5, 11, 11.2], steepAt8);
    expect(profile!.segments).toHaveLength(1);
    expect(profile!.segments[0]!.steep).toBe(true);
    expect(walkSlopeProfile(line, st, [10], steepAt8)).toBeNull();
  });
});
