/**
 * Le test d'or de S3 : la découverte ne touche rien.
 *
 * « En silence » est une promesse vérifiable, et c'est ce fichier qui la tient
 * du côté de S3 : sur les huit fixtures ET les deux mille voisinages tirés au
 * sort de `gate-corpus.ts` — les mêmes que le test d'or de la règle — les
 * ancres sont bit pour bit les mêmes avant et après que la découverte ait
 * tourné sur le même voisinage.
 *
 * Deux choses sont vérifiées, et la seconde est celle qui pouvait vraiment
 * mordre : la géométrie du voisinage est RÉFÉRENCÉE, jamais copiée (gate.ts le
 * dit, `discovery.ts` le refait), et une découverte qui trierait ou
 * normaliserait une polyligne en place corromprait la sélection sans qu'aucun
 * type ne s'en plaigne. Le voisinage est donc comparé à un clone pris avant.
 *
 * La moitié aval du test d'or — candidats, points, projection, conclusion —
 * vit dans `packages/pipeline/test/full-discovery.test.ts` : c'est là que ces
 * objets existent.
 */
import { describe, expect, it } from 'vitest';
import type { GeoPoint } from '@teneolog/domain';

import { discoverApproaches } from '../src/discovery.js';
import { findStructuringGatesWithSearch, type GateSearchInput } from '../src/gates.js';
import type { RoutedPath, RoutingPort } from '../src/ports.js';
import { corpus, RANDOM } from './gate-corpus.js';

/** Un routeur qui répond toujours, en trois points : de quoi ne rien prouver de plus. */
const straightRouter: RoutingPort = {
  route: async (from: GeoPoint, to: GeoPoint): Promise<readonly RoutedPath[]> => [
    {
      polyline: [from, { lat: (from.lat + to.lat) / 2, lon: (from.lon + to.lon) / 2 }, to],
      distanceM: 1_000,
      durationS: 120,
    },
  ],
};

async function discoverOver(i: GateSearchInput, rounds: readonly number[] = [4, 8, 24]): Promise<void> {
  await discoverApproaches(
    {
      stop: i.stop,
      neighbourhood: i.neighbourhood,
      rounds,
      radiusM: i.maxDistanceM,
      minDistanceM: i.minDistanceM,
      // ce cas vérifie que la découverte ne touche à RIEN; le seuil
      // de portée y est neutre pour que le silence reste le sujet.
      minReachM: 0,
      windowM: 1_000,
      alternatives: 1,
      maxConcurrent: 4,
      fetchedAt: '2026-09-11T10:00:00.000Z',
    },
    straightRouter,
  );
}

describe('la découverte ne déplace pas une ancre', () => {
  it('témoin : les huit fixtures, mêmes ancres avant et après', async () => {
    for (const { name, input: i } of corpus()) {
      const before = findStructuringGatesWithSearch(i);
      await discoverOver(i);
      const after = findStructuringGatesWithSearch(i);
      expect(after.gates, name).toEqual(before.gates);
      expect(after.search, name).toEqual(before.search);
      // Et la sélection, elle, ne produit jamais de découverte : c'est le
      // pipeline qui la greffe, après, sur un objet qu'il recompose.
      expect(before.search.discovery, name).toBeNull();
    }
  });

  /**
   * Deux tours et non trois sur les deux mille : le dédoublonnage compare
   * chaque jambe à toutes celles déjà gardées, donc son coût est quadratique
   * en rayons, et trente-six rayons sur deux mille mondes mettent une demi-
   * minute pour redémontrer ce que douze démontrent déjà. Ce qui est sous test
   * ici n'est pas le nombre de tours — c'est qu'aucun chemin de la découverte
   * n'écrit dans ce qu'il lit. Les trois tours tournent sur les fixtures
   * ci-dessus et dans `discovery.test.ts`.
   */
  it('témoin : les 2 000 voisinages, mêmes ancres avant et après', async () => {
    let withGates = 0;
    for (const i of RANDOM) {
      const before = findStructuringGatesWithSearch(i).gates;
      await discoverOver(i, [4, 8]);
      const after = findStructuringGatesWithSearch(i).gates;
      expect(after).toEqual(before);
      if (after.length > 0) withGates += 1;
    }
    // Le corpus doit mordre, comme dans `gate-search.test.ts`.
    expect(withGates).toBeGreaterThan(1_000);
  });

  it('le voisinage ressort intact : la géométrie est lue, jamais retouchée', async () => {
    for (const i of RANDOM.slice(0, 200)) {
      const clone = structuredClone(i.neighbourhood);
      await discoverOver(i);
      expect(i.neighbourhood).toEqual(clone);
    }
  });
});
