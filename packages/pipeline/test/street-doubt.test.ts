/**
 * le doute de S0, ses quatre raisons et ses seuils.
 *
 * Le cas qui a fait la règle est Auxerre : la N77 tombe à 30,002 m pour un
 * rayon d'accrochage de 30 m. 1,7 mm de trop, et elle n'entre jamais dans le
 * concours — donc rien dans la confiance ne dit qu'on a failli livrer sur une
 * autre rue. C'est ce trou que `near_miss_snap` bouche.
 */
import { describe, expect, it } from 'vitest';

import type {
  ConsideredWay,
  DeliveryAnchor,
  DeliveryStreet,
  Fact,
  RejectedStreet,
} from '@teneolog/domain';

import { STREET_DOUBT_OFF, streetDoubt, type StreetDoubtParams } from '../src/street-doubt.js';

const ON: StreetDoubtParams = { enabled: true, nearMissM: 2, minConfidence: 0.9 };
const OFF_BUT_CALIBRATED: StreetDoubtParams = { ...ON, enabled: false };

function way(over: Partial<ConsideredWay> & Pick<ConsideredWay, 'stage'>): ConsideredWay {
  return {
    segmentId: over.segmentId ?? 'w1',
    name: over.name ?? null,
    highway: null,
    geometry: [],
    distanceM: over.distanceM ?? null,
    endsInsideFetch: null,
    outcome: over.outcome ?? 'filtered',
    reason: over.reason ?? null,
    ...over,
  };
}

function street(options: {
  confidence?: number;
  rivals?: number;
}): Fact<DeliveryStreet> {
  const alternativesConsidered: RejectedStreet[] = Array.from(
    { length: options.rivals ?? 0 },
    (_, i) => ({
      segmentId: `rival-${i}`,
      name: 'N77',
      distanceFromPointM: 12,
      reason: 'lower_importance' as const,
    }),
  );
  return {
    known: true,
    value: {
      segmentId: 'retained',
      name: 'Avenue de l’Essai',
      importance: 4,
      declaredWidthM: 9,
      oneWay: false,
      isPrivate: false,
      alternativesConsidered,
    },
    provenance: { source: 'osm-overpass', method: 'street-selection', fetchedAt: '2026-09-11T00:00:00Z' },
    reliability: {
      confidence: options.confidence ?? 0.9,
      basis: 'derived',
      reasonCodes: [],
    },
  };
}

function anchorWith(options: {
  confidence?: number;
  rivals?: number;
  considered?: readonly ConsideredWay[];
  maxSnapM?: number;
  ambiguityWindowM?: number;
  noSearch?: boolean;
}): DeliveryAnchor {
  return {
    requestedAddress: '14 Avenue de l’Essai 89000 Auxerre',
    normalisedAddress: '14 avenue de l’essai 89000 auxerre',
    point: {
      known: true,
      value: { lat: 47.79, lon: 3.56 },
      provenance: { source: 'geocoder-ban', method: 'ban', fetchedAt: '2026-09-11T00:00:00Z' },
      reliability: { confidence: 0.97, basis: 'declared', reasonCodes: [] },
    },
    street: street(options),
    geocodeAgreement: { known: false, why: 'not_applicable' },
    streetSearch: options.noSearch
      ? null
      : {
          centre: { lat: 47.79, lon: 3.56 },
          fetchRadiusM: 80,
          maxSnapM: options.maxSnapM ?? 30,
          ambiguityWindowM: options.ambiguityWindowM ?? 12,
          considered: options.considered ?? [way({ stage: 'retained', outcome: 'retained', distanceM: 6 })],
        },
  };
}

describe('streetDoubt — aucune raison', () => {
  it('une rue sans rivale, sans quasi-raté, sans impasse ne doute de rien', () => {
    const doubt = streetDoubt(anchorWith({}), ON);
    expect(doubt.doubtful).toBe(false);
    expect(doubt.reasons).toEqual([]);
    expect(doubt.details.confidence).toBe(0.9);
  });

  it('une voie écartée LOIN du seuil ne crée pas de doute', () => {
    const doubt = streetDoubt(
      anchorWith({
        considered: [
          way({ stage: 'retained', outcome: 'retained', distanceM: 6 }),
          way({ segmentId: 'far', stage: 'beyond_snap', distanceM: 41 }),
        ],
      }),
      ON,
    );
    expect(doubt.reasons).toEqual([]);
  });

  it("une voie jamais mesurée (non vehiculaire, distance nulle) n'est pas un quasi-raté", () => {
    const doubt = streetDoubt(
      anchorWith({
        considered: [
          way({ stage: 'retained', outcome: 'retained', distanceM: 6 }),
          way({ segmentId: 'path', stage: 'non_vehicular', distanceM: null }),
          way({ segmentId: 'noline', stage: 'beyond_snap', distanceM: null }),
        ],
      }),
      ON,
    );
    expect(doubt.reasons).toEqual([]);
  });
});

describe('streetDoubt — les quatre raisons', () => {
  it('rival_compared : une rivale a atteint le concours et l’a perdu', () => {
    const doubt = streetDoubt(anchorWith({ rivals: 1 }), ON);
    expect(doubt.reasons).toContain('rival_compared');
    expect(doubt.details.rivalsCompared).toBe(1);
    expect(doubt.doubtful).toBe(true);
  });

  it('low_confidence : 0,75 est sous le 0,9 du « sans rivale »', () => {
    const doubt = streetDoubt(anchorWith({ confidence: 0.75 }), ON);
    expect(doubt.reasons).toContain('low_confidence');
  });

  it('les deux partent ensemble sur une rue résolue au classement', () => {
    const doubt = streetDoubt(anchorWith({ confidence: 0.75, rivals: 1 }), ON);
    expect(doubt.reasons).toEqual(['rival_compared', 'low_confidence']);
  });

  it('near_miss_snap : Auxerre — la N77 à 30,002 m pour un rayon de 30 m', () => {
    const doubt = streetDoubt(
      anchorWith({
        considered: [
          way({ stage: 'retained', outcome: 'retained', distanceM: 6.4 }),
          way({ segmentId: 'n77', name: 'N77', stage: 'beyond_snap', distanceM: 30.0017 }),
        ],
      }),
      ON,
    );
    expect(doubt.reasons).toEqual(['near_miss_snap']);
    expect(doubt.details.nearSnap).toMatchObject({ name: 'N77', thresholdM: 30 });
    expect(doubt.details.nearSnap?.missedByM).toBeCloseTo(0.0017, 4);
  });

  it('near_miss_window : une voie à 2 m du bord de la fenêtre d’ambiguïté', () => {
    // Plus proche à 6 m, fenêtre 12 m → bord à 18 m. La rivale à 19,5 m a
    // manqué la fenêtre de 1,5 m.
    const doubt = streetDoubt(
      anchorWith({
        considered: [
          way({ stage: 'retained', outcome: 'retained', distanceM: 6 }),
          way({ segmentId: 'window', name: 'Rue B', stage: 'outside_window', distanceM: 19.5 }),
        ],
      }),
      ON,
    );
    expect(doubt.reasons).toEqual(['near_miss_window']);
    expect(doubt.details.nearWindow).toMatchObject({ thresholdM: 18, distanceM: 19.5 });
    expect(doubt.details.nearWindow?.missedByM).toBeCloseTo(1.5, 6);
  });

  it('les quatre raisons peuvent tenir ensemble, dans l’ordre du module', () => {
    const doubt = streetDoubt(
      anchorWith({
        confidence: 0.75,
        rivals: 2,
        considered: [
          way({ stage: 'retained', outcome: 'retained', distanceM: 6 }),
          way({ segmentId: 'n77', stage: 'beyond_snap', distanceM: 31 }),
          way({ segmentId: 'win', stage: 'outside_window', distanceM: 19 }),
        ],
      }),
      ON,
    );
    expect(doubt.reasons).toEqual([
      'rival_compared',
      'low_confidence',
      'near_miss_snap',
      'near_miss_window',
    ]);
  });
});

describe('streetDoubt — les seuils, pile dessus', () => {
  it('30 + 2 m pile est ENCORE un quasi-raté : le test est inclusif', () => {
    const at = (distanceM: number) =>
      streetDoubt(
        anchorWith({
          considered: [
            way({ stage: 'retained', outcome: 'retained', distanceM: 6 }),
            way({ segmentId: 'x', stage: 'beyond_snap', distanceM }),
          ],
        }),
        ON,
      ).reasons;
    expect(at(32)).toEqual(['near_miss_snap']);
    expect(at(32.0001)).toEqual([]);
  });

  it('la confiance PILE au seuil ne doute pas : le seuil est un plancher atteint', () => {
    expect(streetDoubt(anchorWith({ confidence: 0.9 }), ON).reasons).toEqual([]);
    expect(streetDoubt(anchorWith({ confidence: 0.8999 }), ON).reasons).toEqual(['low_confidence']);
  });

  it('la plus proche des écartées est celle qui compte, pas la première venue', () => {
    const doubt = streetDoubt(
      anchorWith({
        considered: [
          way({ stage: 'retained', outcome: 'retained', distanceM: 6 }),
          way({ segmentId: 'far', name: 'loin', stage: 'beyond_snap', distanceM: 60 }),
          way({ segmentId: 'near', name: 'près', stage: 'beyond_snap', distanceM: 30.5 }),
        ],
      }),
      ON,
    );
    expect(doubt.details.nearSnap?.name).toBe('près');
  });
});

describe('streetDoubt — le drapeau et les trous', () => {
  it('drapeau baissé : les raisons sont calculées, le doute ne l’est pas', () => {
    const doubt = streetDoubt(anchorWith({ confidence: 0.75, rivals: 1 }), OFF_BUT_CALIBRATED);
    expect(doubt.reasons).toEqual(['rival_compared', 'low_confidence']);
    expect(doubt.doubtful).toBe(false);
  });

  it('sans paramètres du tout, la règle est muette', () => {
    const doubt = streetDoubt(anchorWith({ confidence: 0.75, rivals: 1 }), STREET_DOUBT_OFF);
    // La rivale reste visible — c'est un fait de S0, pas une opinion de la
    // règle —, mais aucun seuil n'est posé, donc rien n'est comparé.
    expect(doubt.reasons).toEqual(['rival_compared']);
    expect(doubt.doubtful).toBe(false);
  });

  it('sans recherche de rue (géocodage échoué), aucun quasi-raté n’est inventé', () => {
    const doubt = streetDoubt(anchorWith({ noSearch: true }), ON);
    expect(doubt.details.nearSnap).toBeNull();
    expect(doubt.details.nearWindow).toBeNull();
    expect(doubt.details.maxSnapM).toBeNull();
  });

  it('les seuils sous lesquels le doute a été lu voyagent avec la réponse', () => {
    const doubt = streetDoubt(anchorWith({}), ON);
    expect(doubt.details).toMatchObject({
      maxSnapM: 30,
      ambiguityWindowM: 12,
      nearMissM: 2,
      minConfidence: 0.9,
    });
  });
});
