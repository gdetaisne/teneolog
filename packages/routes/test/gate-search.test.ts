/**
 * The grey layer of S3: every structuring way the gate search looked at.
 *
 * Two things are under test, and only two:
 *
 *  - the search does not change the choice. The gates are compared against a
 * VERBATIM COPY of the pre- selection (`referenceGates` below), not
 *    merely against the wrapper — `findStructuringGates` now delegates to
 *    `findStructuringGatesWithSearch`, so comparing the two would prove
 *    nothing. The reference runs on the hand-written fixtures AND on two
 *    thousand generated neighbourhoods, because the part that could silently
 *    drift is the tie-breaking inside a sort of thousands of vertices, and no
 *    fixture reaches that scale.
 *  - nothing is dropped. Every way of the neighbourhood has exactly one entry,
 *    carrying the stage it fell at, and a way rejected on azimuth names the
 *    gate that stood in its way.
 */
import { describe, expect, it } from 'vitest';
import type { ConsideredGateWay } from '@teneolog/domain';
import type { RoadWay } from '@teneolog/topology';
import { bearingDeg, haversineM, isDrivableWay } from '@teneolog/topology';

import {
  findStructuringGates,
  findStructuringGatesWithSearch,
  type Gate,
  type GateSearchInput,
} from '../src/gates.js';
// les fixtures et les deux mille voisinages vivent à côté, parce que
// le test d'or de la découverte silencieuse se joue sur les mêmes.
import { at, corpus, input, O, RANDOM, way } from './gate-corpus.js';

// ------------------------------------------------- the rule as it was, verbatim --

const STRUCTURING_HIGHWAY: ReadonlySet<string> = new Set([
  'motorway', 'motorway_link', 'trunk', 'trunk_link',
  'primary', 'primary_link', 'secondary', 'secondary_link',
  'tertiary', 'tertiary_link', 'unclassified',
]);

function refIsStructuring(w: RoadWay): boolean {
  const highway = w.tags['highway'];
  if (highway !== undefined && STRUCTURING_HIGHWAY.has(highway)) return true;
  return w.importance !== null && w.importance <= 4;
}

function refAngularDiffDeg(a: number, b: number): number {
  const d = Math.abs(((a - b) % 360) + 360) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * `findStructuringGates` as it stood at c4a5549, copied here on purpose.
 *
 * `haversineM` and `bearingDeg` are imported from the same module the engine
 * uses, so any drift this test reports is a drift of the SELECTION, never of
 * the geometry.
 */
function referenceGates(i: GateSearchInput): readonly Gate[] {
  const candidates: Gate[] = [];
  for (const w of i.neighbourhood.ways) {
    if (!isDrivableWay(w) || !refIsStructuring(w)) continue;
    for (const vertex of w.geometry) {
      const distanceM = haversineM(i.stop, vertex);
      if (distanceM < i.minDistanceM || distanceM > i.maxDistanceM) continue;
      candidates.push({
        at: vertex,
        wayId: w.id,
        azimuthDeg: bearingDeg(i.stop, vertex),
        distanceM,
      });
    }
  }
  if (candidates.length === 0 || i.gateCount === 0) return [];
  const minSeparationDeg = 360 / i.gateCount / 2;
  const sorted = [...candidates].sort(
    (a, b) => b.distanceM - a.distanceM || (a.wayId < b.wayId ? -1 : 1),
  );
  const chosen: Gate[] = [];
  for (const candidate of sorted) {
    if (chosen.length >= i.gateCount) break;
    const separated = chosen.every(
      (held) => refAngularDiffDeg(held.azimuthDeg, candidate.azimuthDeg) >= minSeparationDeg,
    );
    if (separated) chosen.push(candidate);
  }
  return chosen.sort((a, b) => a.azimuthDeg - b.azimuthDeg);
}

function angularDiffDeg(a: number, b: number): number {
  const d = Math.abs(((a - b) % 360) + 360) % 360;
  return d > 180 ? 360 - d : d;
}

// ---------------------------------------------------------------------- tests --

describe('findStructuringGatesWithSearch — le choix ne bouge pas', () => {
  for (const { name, input: i } of corpus()) {
    it(`témoin : ${name}`, () => {
      // Deep-equal against the rule as it stood before the instrumentation.
      expect(findStructuringGatesWithSearch(i).gates).toEqual(referenceGates(i));
      // And the wrapper stays a wrapper.
      expect(findStructuringGates(i)).toEqual(findStructuringGatesWithSearch(i).gates);
    });
  }

  it('témoin : 2 000 voisinages tirés au sort, mêmes ancres dans le même ordre', () => {
    let withGates = 0;
    for (const i of RANDOM) {
      const gates = findStructuringGatesWithSearch(i).gates;
      expect(gates).toEqual(referenceGates(i));
      if (gates.length > 0) withGates += 1;
    }
    // Le corpus doit mordre : un tirage qui ne retiendrait jamais rien
    // prouverait seulement que deux fonctions rendent [].
    expect(withGates).toBeGreaterThan(1_000);
  });
});

describe('findStructuringGatesWithSearch — rien ne se perd', () => {
  it('une ligne par voie du voisinage, quoi qu’il lui soit arrivé', () => {
    for (const i of [...corpus().map((c) => c.input), ...RANDOM]) {
      const { search } = findStructuringGatesWithSearch(i);
      expect(search.considered.length).toBe(i.neighbourhood.ways.length);
    }
  });

  it('les étapes partitionnent le voisinage : elles se resomment au nombre de voies', () => {
    for (const i of RANDOM) {
      const { search } = findStructuringGatesWithSearch(i);
      const byStage = new Map<ConsideredGateWay['stage'], number>();
      for (const w of search.considered) byStage.set(w.stage, (byStage.get(w.stage) ?? 0) + 1);
      const total = [...byStage.values()].reduce((a, b) => a + b, 0);
      expect(total).toBe(i.neighbourhood.ways.length);
    }
  });

  it('chaque ancre retenue a sa ligne « retained » et son rang', () => {
    for (const i of [...corpus().map((c) => c.input), ...RANDOM]) {
      const { gates, search } = findStructuringGatesWithSearch(i);

      // `retained` est la liste des ancres, dans l'ordre où elles sortent.
      expect(search.retained.map(({ rank: _rank, ...g }) => g)).toEqual(gates);
      // Les rangs sont une permutation de 1..n : un rang manquant ou doublé
      // voudrait dire qu'on a perdu un tour de la sélection.
      expect([...search.retained.map((g) => g.rank)].sort((a, b) => a - b)).toEqual(
        gates.map((_, k) => k + 1),
      );

      for (const gate of gates) {
        const row = search.considered.find(
          (w) => w.wayId === gate.wayId && w.outcome === 'retained',
        );
        expect(row, `ancre ${gate.wayId} sans ligne retenue`).toBeDefined();
        expect(row?.stage).toBe('retained');
        expect(row?.conflictsWith).toBeNull();
        expect(row?.bestCandidate).not.toBeNull();
      }
      // Et l'inverse : une ligne retenue sans ancre serait un mensonge.
      for (const row of search.considered.filter((w) => w.outcome === 'retained')) {
        expect(gates.some((g) => g.wayId === row.wayId)).toBe(true);
      }
    }
  });

  it('toute voie écartée sur l’azimut nomme une retenue trop proche de son meilleur sommet', () => {
    let conflicts = 0;
    for (const i of RANDOM) {
      const { search } = findStructuringGatesWithSearch(i);
      for (const row of search.considered) {
        if (row.stage !== 'azimuth_conflict') continue;
        conflicts += 1;
        expect(row.outcome).toBe('rejected');
        expect(row.bestCandidate).not.toBeNull();
        expect(row.conflictsWith).not.toBeNull();
        // `conflictsWith` nomme une VOIE, et une voie peut porter plusieurs
        // ancres (un boulevard de ceinture en place deux). L'engagement est
        // donc : l'une de ses ancres est bien trop proche du meilleur sommet.
        const blockers = search.retained.filter((g) => g.wayId === row.conflictsWith);
        expect(blockers.length, `bloqueur ${row.conflictsWith} introuvable`).toBeGreaterThan(0);
        const best = row.bestCandidate;
        if (best === null) continue;
        expect(
          blockers.some((g) => angularDiffDeg(g.azimuthDeg, best.azimuthDeg) < search.minSeparationDeg),
        ).toBe(true);
      }
    }
    expect(conflicts).toBeGreaterThan(100);
  });

  it('une voie filtrée sur sa classe n’est jamais mesurée, et le dit', () => {
    for (const i of RANDOM) {
      const { search } = findStructuringGatesWithSearch(i);
      for (const row of search.considered) {
        if (row.stage !== 'not_drivable' && row.stage !== 'not_structuring') continue;
        // Jamais mesurée n'est pas « à zéro mètre » : la distance reste inconnue.
        expect(row.nearestDistanceM).toBeNull();
        expect(row.farthestDistanceM).toBeNull();
        expect(row.inRangeVertexCount).toBe(0);
        expect(row.bestCandidate).toBeNull();
        expect(row.outcome).toBe('rejected');
      }
    }
  });

  it('une voie structurante sans sommet en portée garde les distances qui l’ont disqualifiée', () => {
    for (const i of RANDOM) {
      const { search } = findStructuringGatesWithSearch(i);
      for (const row of search.considered) {
        if (row.stage !== 'no_vertex_in_range') continue;
        expect(row.inRangeVertexCount).toBe(0);
        expect(row.bestCandidate).toBeNull();
        if (row.vertexCount === 0) continue;
        expect(row.nearestDistanceM).not.toBeNull();
        expect(row.farthestDistanceM).not.toBeNull();
        // Pas un seul sommet dans la bande : c'est ce que l'étape affirme.
        for (const vertex of row.geometry) {
          const d = haversineM(i.stop, vertex);
          expect(d < i.minDistanceM || d > i.maxDistanceM).toBe(true);
        }
      }
    }
  });

  it('le meilleur sommet d’une voie est bien son sommet en portée le plus lointain', () => {
    for (const i of RANDOM) {
      const { search } = findStructuringGatesWithSearch(i);
      for (const row of search.considered) {
        if (row.bestCandidate === null) continue;
        const inRange = row.geometry
          .map((v) => haversineM(i.stop, v))
          .filter((d) => d >= i.minDistanceM && d <= i.maxDistanceM);
        expect(row.bestCandidate.distanceM).toBe(Math.max(...inRange));
      }
    }
  });

  it('la recherche porte les seuils avec lesquels elle a filtré', () => {
    const i = input([], { gateCount: 5, minDistanceM: 500, maxDistanceM: 2_000 });
    const { search } = findStructuringGatesWithSearch(i);
    expect(search.stop).toEqual(O);
    expect(search.searchRadiusM).toBe(2_000);
    expect(search.minDistanceM).toBe(500);
    expect(search.gateCount).toBe(5);
    expect(search.minSeparationDeg).toBe(36);
    expect(search.considered).toEqual([]);
    expect(search.retained).toEqual([]);
  });

  it('la géométrie est référencée, jamais recopiée', () => {
    const north = way('north', [at(O, 800, 0), at(O, 1_200, 0)], { tags: { highway: 'primary' } });
    const { search } = findStructuringGatesWithSearch(input([north]));
    expect(search.considered[0]?.geometry).toBe(north.geometry);
    expect(search.considered[0]?.vertexCount).toBe(2);
  });

  it('zéro ancre demandée : les voies en portée sont « plus de place », pas « rien en portée »', () => {
    const north = way('north', [at(O, 800, 0), at(O, 1_200, 0)], { tags: { highway: 'primary' } });
    const { gates, search } = findStructuringGatesWithSearch(input([north], { gateCount: 0 }));
    expect(gates).toEqual([]);
    expect(search.considered[0]?.stage).toBe('slots_full');
    expect(search.minSeparationDeg).toBe(0);
  });

  it('deux artères à 10° : la seconde est écartée en nommant la première', () => {
    const twinA = way('twin-a', [at(O, 1_400, 0), at(O, 1_800, 0)], { tags: { highway: 'primary' } });
    const twinB = way('twin-b', [at(O, 1_380, 240), at(O, 1_770, 310)], {
      tags: { highway: 'primary' },
    });
    const { gates, search } = findStructuringGatesWithSearch(input([twinA, twinB]));

    expect(gates).toHaveLength(1);
    const loser = search.considered.find((w) => w.outcome === 'rejected');
    expect(loser?.stage).toBe('azimuth_conflict');
    expect(loser?.conflictsWith).toBe(gates[0]?.wayId);
    expect(loser?.highway).toBe('primary');
    expect(loser?.inRangeVertexCount).toBeGreaterThan(0);
  });

  it('une voie non carrossable et une voie résidentielle ne tombent pas à la même étape', () => {
    const footway = way('foot', [at(O, 700, 0), at(O, 900, 0)], { tags: { highway: 'footway' } });
    const residential = way('res', [at(O, 900, 90), at(O, 1_100, 90)]);
    const { search } = findStructuringGatesWithSearch(input([footway, residential]));

    expect(search.considered.find((w) => w.wayId === 'foot')?.stage).toBe('not_drivable');
    expect(search.considered.find((w) => w.wayId === 'res')?.stage).toBe('not_structuring');
    // `isDrivableWay` est la même porte que celle du moteur : on le dit ici.
    expect(isDrivableWay(footway)).toBe(false);
    expect(isDrivableWay(residential)).toBe(true);
  });
});

// ------------------------------------------------- la portée jusqu'au cercle --

/**
 * une ancre qui n'atteint pas le cercle n'entre pas en concurrence.
 *
 * La découverte applique cette règle sur le bout de la jambe
 * ROUTÉE (principe 7, principe 28). Pour R0 l'ancre EST ce bout — le routeur
 * part d'elle et s'arrête à l'arrêt — donc la même règle se lit sur le sommet,
 * et le même nombre de policy (`gates.minReachM`) la porte.
 *
 * Ce que ces cas fixent : le seuil écarte, il ne fait pas disparaître. La voie
 * reste dans la couche grise avec ses distances, et `shortOfRing` la nomme avec
 * le meilleur sommet qu'elle pouvait offrir.
 */
describe('findStructuringGatesWithSearch — la portée jusqu’au cercle', () => {
  /** Une primaire à 600 m, une tertiaire à 1 900 m : la forme du défaut A. */
  const near = way('near', [at(O, 560, 0), at(O, 600, 0)], { tags: { highway: 'primary' } });
  const far = way('far', [at(O, 0, 1_850), at(O, 0, 1_950)], { tags: { highway: 'tertiary' } });

  it('une ancre à 600 m est écartée, comptée et nommée', () => {
    const { gates, search } = findStructuringGatesWithSearch(
      input([near, far], { minReachM: 1_800 }),
    );

    expect(gates.map((gate) => gate.wayId)).toEqual(['far']);
    expect(search.minReachM).toBe(1_800);
    expect(search.shortOfRing).toHaveLength(1);
    const [short] = search.shortOfRing;
    expect(short?.wayId).toBe('near');
    // Le meilleur sommet que la voie pouvait offrir : le plus lointain sous le
    // seuil, celui qui dit de combien il s'en est fallu.
    expect(short?.reachM).toBeGreaterThan(590);
    expect(short?.reachM).toBeLessThan(610);

    // Écartée n'est pas effacée : la voie garde sa ligne dans la couche grise.
    const row = search.considered.find((w) => w.wayId === 'near');
    expect(row?.stage).toBe('no_vertex_in_range');
    expect(row?.inRangeVertexCount).toBe(0);
    expect(row?.nearestDistanceM).not.toBeNull();
  });

  it('à seuil nul la même ancre est retenue : c’est bien le seuil qui décide', () => {
    const { gates, search } = findStructuringGatesWithSearch(input([near, far], { minReachM: 0 }));

    expect(gates.map((gate) => gate.wayId).sort()).toEqual(['far', 'near']);
    expect(search.shortOfRing).toEqual([]);
  });

  it('une voie qui porte quelque part n’est pas dite courte ailleurs', () => {
    // Deux sommets sur la même voie, l'un sous le seuil, l'autre au-delà : la
    // voie a fourni une ancre, donc elle n'est pas « trop près ».
    const both = way('both', [at(O, 900, 0), at(O, 1_900, 0)], { tags: { highway: 'primary' } });
    const { gates, search } = findStructuringGatesWithSearch(input([both], { minReachM: 1_800 }));

    expect(gates).toHaveLength(1);
    expect(gates[0]?.distanceM).toBeGreaterThan(1_800);
    expect(search.shortOfRing).toEqual([]);
  });


  it('le plancher SERVI est celui qui a été appliqué, pas le plus bas des deux', () => {
    // `/explain` écrit « les ancres se cherchent entre X et Y de l'arrêt » avec
    // `search.minDistanceM`. Servir 500 m quand rien ne peut se poser sous
    // 1 800 m dirait à l'opérateur un seuil que le moteur n'applique pas.
    const haut = findStructuringGatesWithSearch(input([near, far], { minReachM: 1_800 })).search;
    expect(haut.minDistanceM).toBe(1_800);
    expect(haut.minReachM).toBe(1_800);

    // Et quand c'est l'autre seuil qui mord, c'est lui qui est servi.
    const bas = findStructuringGatesWithSearch(input([near, far], { minReachM: 0 })).search;
    expect(bas.minDistanceM).toBe(500);
    expect(bas.minReachM).toBe(0);
  });
  it('à Thairé rien ne change : les cinq ancres sont à 1 945–1 992 m', () => {
    // Les cinq distances relevées au jury (Pas 1), posées sur cinq azimuts
    // séparés — c'est la seule chose que la portée regarde.
    const ways = [1_945, 1_958, 1_971, 1_984, 1_992].map((metres, i) => {
      const rad = (i * 72 * Math.PI) / 180;
      return way(
        `thaire-${i}`,
        [
          at(O, metres * Math.cos(rad), metres * Math.sin(rad)),
          at(O, (metres - 40) * Math.cos(rad), (metres - 40) * Math.sin(rad)),
        ],
        // Thairé : 83 tertiaires, 0 primaire (principe 15).
        { tags: { highway: 'tertiary' } },
      );
    });
    const avec = findStructuringGatesWithSearch(input(ways, { minReachM: 1_800 }));
    const sans = findStructuringGatesWithSearch(input(ways, { minReachM: 0 }));

    expect(avec.gates).toEqual(sans.gates);
    expect(avec.gates).toHaveLength(5);
    expect(avec.search.shortOfRing).toEqual([]);
  });
});
