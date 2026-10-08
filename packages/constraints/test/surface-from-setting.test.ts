/**
 * le cadre bâti mesuré traduit en `SurfaceContext`, et la règle de
 * repliement à deux valeurs. Le piège est le bourg : le chargeur le compte
 * comme urbain (`rules.ts:75-77`), et c'est cette règle-là qu'on reprend.
 */
import { describe, expect, it } from 'vitest';

import { surfaceFromSetting } from '../src/stop-constraints.js';

const FETCHED_AT = '2026-09-11T10:00:00.000Z';

function make(kind: string, builtRatio: number | null = 0.25) {
  return surfaceFromSetting({ kind, builtRatio, densityRadiusM: 200, fetchedAt: FETCHED_AT });
}

describe('surfaceFromSetting', () => {
  it.each([
    ['dense', 'urban'],
    ['urbain', 'urban'],
    ['bourg', 'urban'],
    ['periurbain', 'rural'],
    ['rural', 'rural'],
  ])('cadre « %s » → %s', (kind, expected) => {
    const fact = make(kind);
    expect(fact.known).toBe(true);
    if (!fact.known) throw new Error('unreachable');
    expect(fact.value.urbanRural).toBe(expected);
  });

  it('un cadre inconnu reste un inconnu déclaré — pas un « rural » par défaut', () => {
    const fact = make('inconnu', null);
    expect(fact).toEqual({ known: false, why: 'no_data' });
  });

  it('la provenance nomme la BD TOPO et le rayon qui a servi', () => {
    const fact = make('rural', 0.05);
    if (!fact.known) throw new Error('unreachable');
    expect(fact.provenance).toEqual({
      source: 'bdtopo-postgis',
      method: 'built-ratio-200m',
      fetchedAt: FETCHED_AT,
    });
    expect(fact.reliability.basis).toBe('derived');
  });

  it('les deux champs que personne ne mesure partent avec un code qui le dit', () => {
    // `false` sans code se lirait « on a regardé et il n'y en avait pas » ;
    // c'est exactement le faux négatif que l'enveloppe Fact doit empêcher.
    const fact = make('dense', 0.5);
    if (!fact.known) throw new Error('unreachable');
    expect(fact.value.parkedVehiclesObserved).toBe(false);
    expect(fact.value.sidewalkBothSides).toBe(false);
    expect(fact.reliability.reasonCodes).toContain('parked_vehicles_not_observed');
    expect(fact.reliability.reasonCodes).toContain('sidewalks_not_observed');
  });

  it('la part bâtie voyage dans les codes de raison, chiffrée', () => {
    const fact = make('bourg', 0.2783);
    if (!fact.known) throw new Error('unreachable');
    expect(fact.reliability.reasonCodes).toContain('built_ratio_0.278');
    expect(fact.reliability.reasonCodes).toContain('setting_bourg');
  });
});
