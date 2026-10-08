/**
 * le doute de S0 dans le prédicat de l'arrêt évident.
 *
 * Ce que le test verrouille, dans l'ordre d'importance :
 *
 *  1. **Le test d'or.** Drapeau baissé — ou fact sans le champ, ce qu'est tout
 *     run stocké avant la règle — le prédicat rend EXACTEMENT ce qu'il rendait.
 *  2. Drapeau levé et doute présent : l'arrêt cesse d'être évident, donc la
 *     scène de destination est posée. Rien d'autre ne bouge : `basis` reste
 *     celui du seuil appliqué, et les raisons nomment le doute.
 *  3. Le doute ne MASQUE jamais un motif d'en haut : une largeur trop faible
 *     reste `width_below_*`, pas `street_doubt_*`. Il n'ajoute des questions
 *     que là où il n'y en avait plus.
 */
import { describe, expect, it } from 'vitest';

import type { TruckProfile } from '@teneolog/domain';

import type { S0S2Facts } from '../src/analyse.js';
import { assessObviousStop, type ObviousStopThresholds } from '../src/obvious-stop.js';
import { streetDoubt, type StreetDoubt } from '../src/street-doubt.js';

const PL19 = {
  id: 'pl-19t',
  envelope: { widthM: 2.5, heightM: 3.5, gvwT: 19 },
} as unknown as TruckProfile;

const THRESHOLDS: ObviousStopThresholds = {
  declaredWidthMinM: 10,
  measuredWidthMinM: 6.5,
  publishableConfidence: 0.55,
};

/** Un doute fabriqué par la vraie fonction, jamais à la main. */
function doubtOf(options: { enabled: boolean; confidence: number }): StreetDoubt {
  return streetDoubt(
    {
      requestedAddress: 'x',
      normalisedAddress: 'x',
      point: { known: false, why: 'no_data' },
      street: {
        known: true,
        value: {
          segmentId: 's',
          name: 'Rue A',
          importance: 4,
          declaredWidthM: 12,
          oneWay: false,
          isPrivate: false,
          alternativesConsidered: [],
        },
        provenance: { source: 'osm-overpass', method: 'street-selection', fetchedAt: 'now' },
        reliability: { confidence: options.confidence, basis: 'derived', reasonCodes: [] },
      },
      geocodeAgreement: { known: false, why: 'not_applicable' },
      streetSearch: null,
    },
    { enabled: options.enabled, nearMissM: 2, minConfidence: 0.9 },
  );
}

function factsWith(widthM: number, doubt?: StreetDoubt): S0S2Facts {
  const unknown = { known: false, why: 'no_data' };
  return {
    topology: { topology: { kind: 'THROUGH' } },
    stop: {
      width: {
        known: true,
        value: { freeM: widthM, structuralM: widthM },
        reliability: { confidence: 0.55, basis: 'declared', reasonCodes: [] },
      },
      legal: {
        maxWeightT: unknown,
        maxHeightM: unknown,
        maxWidthM: unknown,
        access: { known: true, value: { kind: 'open' } },
      },
    },
    ...(doubt === undefined ? {} : { streetDoubt: doubt }),
  } as unknown as S0S2Facts;
}

describe('assessObviousStop — le test d’or', () => {
  it('sans le champ du tout (run d’avant la règle), le verdict est celui d’avant', () => {
    expect(assessObviousStop(factsWith(12), PL19, THRESHOLDS)).toEqual({
      obvious: true,
      basis: 'declared',
      reasonCodes: ['obvious_stop_declared_width'],
    });
  });

  it('drapeau baissé avec un doute réel : rien ne change', () => {
    const doubt = doubtOf({ enabled: false, confidence: 0.75 });
    expect(doubt.reasons).toEqual(['low_confidence']);
    expect(assessObviousStop(factsWith(12, doubt), PL19, THRESHOLDS)).toEqual({
      obvious: true,
      basis: 'declared',
      reasonCodes: ['obvious_stop_declared_width'],
    });
  });

  it('drapeau levé mais aucun doute : rien ne change non plus', () => {
    const doubt = doubtOf({ enabled: true, confidence: 0.9 });
    expect(doubt.doubtful).toBe(false);
    expect(assessObviousStop(factsWith(12, doubt), PL19, THRESHOLDS)).toMatchObject({
      obvious: true,
    });
  });
});

describe('assessObviousStop — le doute pose la question', () => {
  it('un arrêt large sur une rue douteuse redevient une question', () => {
    const verdict = assessObviousStop(
      factsWith(12, doubtOf({ enabled: true, confidence: 0.75 })),
      PL19,
      THRESHOLDS,
    );
    expect(verdict).toEqual({
      obvious: false,
      // Le seuil a bien été appliqué : la carte doit pouvoir dire lequel.
      basis: 'declared',
      reasonCodes: ['street_doubt_low_confidence'],
    });
  });

  it('le doute ne masque pas un motif d’en haut : une rue trop étroite reste trop étroite', () => {
    expect(
      assessObviousStop(
        factsWith(8, doubtOf({ enabled: true, confidence: 0.75 })),
        PL19,
        THRESHOLDS,
      ),
    ).toEqual({
      obvious: false,
      basis: null,
      reasonCodes: ['width_below_declared_threshold'],
    });
  });
});
