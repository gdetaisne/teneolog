/**
 * LA RELATION, PIÈCE PAR PIÈCE (principe 41).
 *
 * Une rue étroite est couverte par un virage quand elle passe par un des
 * segments que le virage NOMME — la chaussée où il se fait, sa rue de sortie
 * (la largeur qu'il publie), sa rue d'entrée lue à la même distance en amont —
 * et qu'elle est TOUT ENTIÈRE sur les voies de ces segments (la rue de
 * livraison comptant pour une voie, telle que S0 l'a fondue). Elle est sur la
 * rue de livraison quand TOUS ses segments y sont. Et son ref est celui que la
 * collecte lui a donné, dédoublonnage compris.
 *
 * L'équerre de `exit-arm.test.ts`, agrandie : 100 m est, un virage, 100 m nord,
 * puis 200 m nord encore — assez pour poser une rue étroite hors des bras.
 */
import { describe, expect, it } from 'vitest';
import type { CriticalPoint, Fact, GeoPoint, RouteCandidate, RouteSegmentConstraint, Width } from '@teneolog/domain';

import { makePointRef } from '../src/point-ref.js';
import { narrowRefsOnTurnArms, narrowRefsOnWays } from '../src/narrow-cover.js';

const O: GeoPoint = { lat: 46.0, lon: -1.0 };
const M = 111_320;
const at = (northM: number, eastM: number): GeoPoint => ({
  lat: O.lat + northM / M,
  lon: O.lon + eastM / (M * Math.cos((O.lat * Math.PI) / 180)),
});

function width(freeM: number): Fact<Width> {
  return {
    known: true,
    value: { freeM, structuralM: freeM, measuredAt: O, offsetFromAnchorM: 0 },
    provenance: { source: 'bdtopo-postgis', method: 'declared-width-narrowest', fetchedAt: 'x' },
    reliability: { confidence: 0.55, basis: 'declared', reasonCodes: [] },
  };
}

const segment = (id: string, from: GeoPoint, to: GeoPoint, freeM: number): RouteSegmentConstraint =>
  ({ segmentId: id, from, to, position: 'approach', highway: 'residential', lengthM: 0, legal: {}, width: width(freeM) }) as unknown as RouteSegmentConstraint;

const APEX = at(0, 100);
const LINE = [at(0, 0), at(0, 50), APEX, at(50, 100), at(100, 100), at(200, 100), at(300, 100)];
const PARAMS = { bearingOffsetM: 10, narrowMaxFreeM: 5, dedupeWithinM: 15 };
const TURN = { ref: makePointRef('TURN', APEX), at: APEX, arcLengthM: 20 };

function leg(segments: readonly RouteSegmentConstraint[], polyline: readonly GeoPoint[] = LINE): RouteCandidate {
  return { id: 'equerre@0:in', direction: 'in', polyline, segments, egressOf: null } as unknown as RouteCandidate;
}

/** Ce que la collecte a relevé : les rues étroites de la jambe, à leur départ. */
const narrowAt = (from: GeoPoint, ref = makePointRef('NARROW', from)): CriticalPoint =>
  ({ ref, type: 'NARROW', at: from, geometry: { known: false, why: 'no_data' }, evidence: [] }) as unknown as CriticalPoint;

describe('narrowRefsOnTurnArms — les bras que le virage nomme', () => {
  it('la rue d’entrée étroite est couverte ; la large de sortie ne donne rien', () => {
    const candidate = leg([segment('entree', at(0, 0), APEX, 3.0), segment('sortie', APEX, at(300, 100), 5.5)]);
    const collected = [narrowAt(at(0, 0))];
    expect(narrowRefsOnTurnArms(candidate, [TURN], collected, PARAMS).get(TURN.ref)).toEqual([collected[0]!.ref]);
  });

  it('la rue de sortie étroite est couverte', () => {
    const candidate = leg([segment('entree', at(0, 0), APEX, 5.5), segment('sortie', APEX, at(100, 100), 3.0)]);
    const collected = [narrowAt(APEX)];
    expect(narrowRefsOnTurnArms(candidate, [TURN], collected, PARAMS).get(TURN.ref)).toEqual([collected[0]!.ref]);
  });

  it('LIMITE — une rue étroite plus loin sur la jambe, après une rue large, n’est pas un bras', () => {
    const candidate = leg([
      segment('entree', at(0, 0), APEX, 5.5),
      segment('sortie', APEX, at(100, 100), 5.5),
      segment('plus-loin', at(200, 100), at(300, 100), 3.0),
    ]);
    const collected = [narrowAt(at(200, 100))];
    expect(narrowRefsOnTurnArms(candidate, [TURN], collected, PARAMS).size).toBe(0);
  });

  /**
   * La relecture du 2026-09-28 : la collecte FUSIONNE les segments étroits qui se
   * suivent, quelle que soit leur voie — une seule question peut donc courir sur
   * plusieurs rues. Qu'un de ses segments soit un bras ne suffit pas : la rue
   * étroite est couverte quand elle est TOUT ENTIÈRE sur les voies que le
   * virage nomme. Les polylignes sont plus fines ici que l'équerre, pour que la
   * lecture du bras (20 m de part et d'autre de l'apex) tombe DANS le segment du
   * bras et pas sur la jointure.
   */
  it('LIMITE — côté sortie : 40 m de rue de sortie puis 600 m d’une autre ruelle, fusionnés, ne sont pas un bras', () => {
    const line = [at(0, 0), at(0, 50), at(0, 90), APEX, at(10, 100), at(30, 100), at(40, 100), at(340, 100), at(640, 100)];
    const candidate = leg(
      [
        segment('entree', at(0, 0), APEX, 5.5),
        segment('sortie', APEX, at(40, 100), 3.0),
        segment('autre-ruelle', at(40, 100), at(640, 100), 2.6),
      ],
      line,
    );
    const collected = [narrowAt(APEX)];
    expect(narrowRefsOnTurnArms(candidate, [TURN], collected, PARAMS).size).toBe(0);
  });

  it('LIMITE — côté entrée : 600 m d’une ruelle puis 30 m de rue d’entrée, fusionnés, ne sont pas un bras', () => {
    const line = [at(0, -600), at(0, 0), at(0, 60), at(0, 70), at(0, 90), APEX, at(50, 100), at(100, 100)];
    const candidate = leg(
      [
        segment('ruelle', at(0, -600), at(0, 60), 2.6),
        segment('entree', at(0, 60), APEX, 3.0),
        segment('sortie', APEX, at(100, 100), 5.5),
      ],
      line,
    );
    const collected = [narrowAt(at(0, -600))];
    expect(narrowRefsOnTurnArms(candidate, [TURN], collected, PARAMS).size).toBe(0);
  });

  it('la rue de sortie coupée en deux voies que S0 a fondues en une chaussée (la rue de livraison) reste un bras', () => {
    // La Sèvremoine : BD TOPO coupe l'Allée en TRONROUT0000000356360087 et
    // TRONROUT0000000011773098 au carrefour latéral, 90 m après le virage.
    const line = [at(0, 0), at(0, 50), at(0, 90), APEX, at(10, 100), at(30, 100), at(90, 100), at(160, 100)];
    const candidate = leg(
      [
        segment('entree', at(0, 0), APEX, 5.5),
        segment('allee-nord', APEX, at(90, 100), 3.0),
        segment('allee-sud', at(90, 100), at(160, 100), 3.0),
      ],
      line,
    );
    const collected = [narrowAt(APEX)];
    const street = new Set(['allee-sud', 'allee-nord']);
    expect(narrowRefsOnTurnArms(candidate, [TURN], collected, PARAMS, street).get(TURN.ref)).toEqual([collected[0]!.ref]);
    // Sans la rue de livraison, rien ne dit que la seconde voie est la même rue.
    expect(narrowRefsOnTurnArms(candidate, [TURN], collected, PARAMS).size).toBe(0);
    // Et une rue de livraison qui ne passe pas par le bras n'y amène rien.
    expect(narrowRefsOnTurnArms(candidate, [TURN], collected, PARAMS, new Set(['allee-sud'])).size).toBe(0);
  });

  it('le ref est celui de la collecte : une rue étroite trouvée d’abord par une autre jambe, à 8 m', () => {
    const candidate = leg([segment('entree', at(0, 0), APEX, 5.5), segment('sortie', APEX, at(100, 100), 3.0)]);
    const firstFinder = narrowAt(at(8, 100));
    expect(narrowRefsOnTurnArms(candidate, [TURN], [firstFinder], PARAMS).get(TURN.ref)).toEqual([firstFinder.ref]);
  });
});

describe('narrowRefsOnWays — la rue de livraison, tout entière', () => {
  const candidate = leg([
    segment('entree', at(0, 0), APEX, 5.5),
    segment('allee-a', APEX, at(50, 100), 3.0),
    segment('allee-b', at(50, 100), at(100, 100), 3.0),
  ]);
  const collected = [narrowAt(APEX)];

  it('tous les segments sur les voies de la rue : couverte', () => {
    expect(narrowRefsOnWays(candidate, new Set(['allee-a', 'allee-b']), collected, PARAMS)).toEqual([collected[0]!.ref]);
  });

  it('un seul segment ailleurs : la question parle d’une autre rue, elle reste posée', () => {
    expect(narrowRefsOnWays(candidate, new Set(['allee-b']), collected, PARAMS)).toEqual([]);
  });

  it('pas de rue de livraison connue : rien n’est couvert', () => {
    expect(narrowRefsOnWays(candidate, new Set(), collected, PARAMS)).toEqual([]);
  });
});
