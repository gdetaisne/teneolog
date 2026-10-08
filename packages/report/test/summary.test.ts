import { describe, expect, it } from 'vitest';
import type { NoLegReachesRingMotif, PointVerdict, RunConclusion } from '@teneolog/domain';

import { explainNoLegReachesRing, ROUTER_UNAVAILABLE_EXPLANATION, summariseConclusion } from '../src/summary.js';

function conclusion(overrides: Partial<RunConclusion>): RunConclusion {
  return {
    profileId: 'pl-19t',
    overall: 'OK',
    pointVerdicts: [],
    // Ni les verdicts par jambe : le résumé S6 parle du lieu, parce
    // qu'il énumère ce qui reste à contrôler, jamais quelle jambe le conduit.
    legVerdicts: [],
    candidateVerdicts: [],
    decidedBy: null,
    viaCandidateId: 'g1:out',
    // Unless a test says otherwise, every point listed is on the retained pair.
    retainedPointRefs: (overrides.pointVerdicts ?? []).map((pv) => pv.pointRef),
    reasonCodes: [],
    // Le résumé ne lit pas le classement : il reste vide ici, et
    // c'est en soi ce que le test dit.
    ranking: [],
    rankingDisagreesWithVia: false,
    // Ni le classement des paires, ni les plans : le résumé S6 parle
    // de la réponse, et rien de ce qui est calculé en silence à côté d'elle.
    plans: [],
    planCount: 0,
    bestPlanIsSameGatePair: false,
    plansDisagreeWithVia: false,
    // Ni le plan retenu ni la trace de R0, pour la même raison : le
    // résumé dit la réponse, pas par quelles deux jambes elle est rendue.
    retainedPlan: null,
    r0Pair: { viaCandidateId: 'g1:out', overall: 'OK' },
    // non nul seulement avec `no_leg_reaches_ring`; chaque test
    // qui veut ce cas le pose lui-même via `overrides`.
    noLegReachesRing: null,
    policyVersion: 'v1',
    validUntil: 'x',
    ...overrides,
  };
}

function point(pointRef: string, verdict: PointVerdict['verdict'], explanation = ''): PointVerdict {
  return {
    pointRef,
    profileId: 'pl-19t',
    candidateId: null,
    verdict,
    marginM: null,
    reasonCodes: [],
    derivedFrom: [],
    explanation,
  };
}

describe('summariseConclusion', () => {
  it('a clean OK says so and lists nothing', () => {
    const s = summariseConclusion(conclusion({}), 'porteur 19 t');
    expect(s.headline).toBe('Livrable en porteur 19 t.');
    expect(s.attention).toHaveLength(0);
  });

  it('a legal block explains itself without inventing detail', () => {
    const s = summariseConclusion(
      conclusion({ overall: 'NO', reasonCodes: ['best_pair_legally_blocked'] }),
      'porteur 19 t',
    );
    expect(s.headline).toBe('Non accessible en porteur 19 t.');
    expect(s.explanation).toContain('restriction légale');
  });

  it('the deciding point speaks in its own derived words — no paraphrase', () => {
    const pv = point('TURNAROUND@1,1', 'NO', 'Retournement : 5.0 m utilisables pour 24.0 m requis.');
    const s = summariseConclusion(
      conclusion({ overall: 'NO', decidedBy: pv.pointRef, pointVerdicts: [pv] }),
      'porteur 19 t',
    );
    expect(s.explanation).toBe(pv.explanation);
    expect(s.attention[0]?.pointRef).toBe(pv.pointRef);
  });

  it('a router outage is neither livrable nor non accessible — it asks for a retry', () => {
    const s = summariseConclusion(
      conclusion({ overall: 'HUMAN', viaCandidateId: null, reasonCodes: ['router_unavailable'] }),
      'Porteur 19 t',
    );
    expect(s.headline).toBe('Accès en Porteur 19 t non déterminé.');
    expect(s.explanation).toBe(ROUTER_UNAVAILABLE_EXPLANATION);
    expect(s.explanation).toContain("n'a pas répondu");
    expect(s.attention).toHaveLength(0);
  });

  it('no anchor and no discovered leg reach the ring — the numbers, not a silence', () => {
    const motif: NoLegReachesRingMotif = {
      minReachM: 1800,
      bestReachM: 1312,
      bestWayId: 'w-d113',
      bestWayName: 'D 113',
      bestAzimuthDeg: 45,
    };
    const s = summariseConclusion(
      conclusion({
        overall: 'HUMAN',
        viaCandidateId: null,
        reasonCodes: ['no_leg_reaches_ring'],
        noLegReachesRing: motif,
      }),
      'Porteur 19 t',
    );
    // Même formule que le routeur indisponible : ni « livrable », ni « non
    // accessible » — pas de candidat, donc rien à établir (principe 5).
    expect(s.headline).toBe('Accès en Porteur 19 t non déterminé.');
    expect(s.explanation).toBe(explainNoLegReachesRing(motif));
    expect(s.explanation).toContain('1 800 m');
    expect(s.explanation).toContain('1 312 m');
    expect(s.explanation).toContain('D 113');
    expect(s.explanation).toContain('nord-est');
    expect(s.explanation).toContain("ce n'est pas un refus");
    expect(s.attention).toHaveLength(0);
  });

  it('attention lists the retained pair\'s points only, most severe first', () => {
    const onPair = point('TURN@1,1', 'HUMAN');
    const onPairWorse = point('TURNAROUND@1,2', 'NO');
    const discarded = point('TURN@9,9', 'NO');
    const s = summariseConclusion(
      conclusion({
        overall: 'HUMAN',
        pointVerdicts: [onPair, discarded, onPairWorse],
        retainedPointRefs: [onPair.pointRef, onPairWorse.pointRef],
      }),
      'porteur 19 t',
    );
    expect(s.attention.map((pv) => pv.pointRef)).toEqual([onPairWorse.pointRef, onPair.pointRef]);
    expect(s.explanation).toBe("2 point(s) restent à contrôler sur l'itinéraire retenu.");
  });

  it('a deciding point off the retained pair cannot explain the run', () => {
    const stray = point('TURN@9,9', 'NO', 'Une explication qui ne concerne pas la route retenue.');
    const s = summariseConclusion(
      conclusion({ overall: 'HUMAN', decidedBy: stray.pointRef, pointVerdicts: [stray], retainedPointRefs: [] }),
      'porteur 19 t',
    );
    expect(s.explanation).not.toBe(stray.explanation);
    expect(s.attention).toHaveLength(0);
  });
});

describe('explainNoLegReachesRing', () => {
  it('names the way, the compass point, and the two distances', () => {
    const text = explainNoLegReachesRing({
      minReachM: 1800,
      bestReachM: 1312,
      bestWayId: 'w-d113',
      bestWayName: 'D 113',
      bestAzimuthDeg: 45,
    });
    expect(text).toBe(
      "Aucune voie structurante n'atteint le cercle de 1 800 m autour de l'arrêt : " +
        "la plus proche s'arrête à 1 312 m (D 113, vers le nord-est). " +
        "L'analyse ne peut pas proposer d'itinéraire ; ce n'est pas un refus.",
    );
  });

  it('an unnamed way falls back to its id — never a fabricated name', () => {
    const text = explainNoLegReachesRing({
      minReachM: 1800,
      bestReachM: 900,
      bestWayId: 'w-42',
      bestWayName: null,
      bestAzimuthDeg: 180,
    });
    expect(text).toContain('(voie w-42, vers le sud)');
  });

  it('no way at all (the winner came from the discovery): the parenthetical disappears, not a lie', () => {
    const text = explainNoLegReachesRing({
      minReachM: 1800,
      bestReachM: 1499,
      bestWayId: null,
      bestWayName: null,
      bestAzimuthDeg: null,
    });
    expect(text).toBe(
      "Aucune voie structurante n'atteint le cercle de 1 800 m autour de l'arrêt : " +
        "la plus proche s'arrête à 1 499 m. " +
        "L'analyse ne peut pas proposer d'itinéraire ; ce n'est pas un refus.",
    );
  });
});
