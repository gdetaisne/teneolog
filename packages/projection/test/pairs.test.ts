/**
 * the one pairing rule, shared by S5 and by the judgement replay in
 * compat-wire. Every case here is a case both callers must agree on.
 */
import { describe, expect, it } from 'vitest';
import type { Verdict } from '@teneolog/domain';

import { concludePairs, type PairLegInput } from '../src/pairs.js';

function leg(
  id: string,
  inboundId: string | null,
  points: readonly { ref: string; verdict: Verdict }[] = [],
  overrides: Partial<Pick<PairLegInput, 'verdict' | 'blockedAtSegmentId'>> = {},
): PairLegInput {
  return { id, inboundId, verdict: 'OK', blockedAtSegmentId: null, points, ...overrides };
}

describe('concludePairs', () => {
  it('a viable pair: the run is OK, names its outbound, and rests on the pair\'s points only', () => {
    const c = concludePairs({
      legs: [
        leg('g1:in', null, [{ ref: 'TURN@1', verdict: 'OK' }]),
        leg('g1:out', 'g1:in', [{ ref: 'TURN@2', verdict: 'OK' }]),
        // A discarded pair with a doubtful corner: not part of the answer.
        leg('g2:in', null, [{ ref: 'TURN@9', verdict: 'HUMAN' }]),
        leg('g2:out', 'g2:in'),
      ],
    });
    expect(c.overall).toBe('OK');
    expect(c.bestPair?.outId).toBe('g1:out');
    expect(c.bestPair?.inboundId).toBe('g1:in');
    expect(c.reasonCodes).toEqual([]);
    expect(c.retainedPointRefs).toEqual(['TURN@1', 'TURN@2']);
  });

  it('a HUMAN point on the only pair decides it: HUMAN, decidedBy the point', () => {
    const c = concludePairs({
      legs: [
        leg('g1:in', null, [{ ref: 'TURN@1', verdict: 'OK' }, { ref: 'TURN@2', verdict: 'HUMAN' }]),
        leg('g1:out', 'g1:in'),
      ],
    });
    expect(c.overall).toBe('HUMAN');
    expect(c.bestPair?.decidedBy).toBe('TURN@2');
  });

  it('a leg HUMAN by legality with clean points has no deciding point', () => {
    const c = concludePairs({
      legs: [
        leg('g1:in', null, [{ ref: 'TURN@1', verdict: 'OK' }], { verdict: 'HUMAN' }),
        leg('g1:out', 'g1:in'),
      ],
    });
    expect(c.overall).toBe('HUMAN');
    expect(c.bestPair?.decidedBy).toBeNull();
  });

  it('the best pair legally blocked: NO with best_pair_legally_blocked and its segment', () => {
    const c = concludePairs({
      legs: [
        leg('g1:in', null, [], { verdict: 'NO', blockedAtSegmentId: 'limited' }),
        leg('g1:out', 'g1:in'),
        leg('g2:in', null, [{ ref: 'TURN@1', verdict: 'NO' }]),
        leg('g2:out', 'g2:in', [], { verdict: 'NO', blockedAtSegmentId: 'bridge' }),
      ],
    });
    expect(c.overall).toBe('NO');
    expect(c.reasonCodes).toEqual(['best_pair_legally_blocked']);
    expect(c.bestPair?.blockedAtSegmentId).toBe('limited');
    expect(c.bestPair?.decidedBy).toBeNull();
  });

  it('a NO decided by a measured point carries no legal code and names the point', () => {
    const c = concludePairs({
      legs: [
        leg('g1:in', null, [{ ref: 'TURNAROUND@1', verdict: 'NO' }]),
        leg('g1:out', 'g1:in'),
      ],
    });
    expect(c.overall).toBe('NO');
    expect(c.reasonCodes).toEqual([]);
    expect(c.bestPair?.decidedBy).toBe('TURNAROUND@1');
  });

  it('inbound wins a tie between legs of equal severity', () => {
    const c = concludePairs({
      legs: [
        leg('g1:in', null, [{ ref: 'IN@1', verdict: 'HUMAN' }]),
        leg('g1:out', 'g1:in', [{ ref: 'OUT@1', verdict: 'HUMAN' }]),
      ],
    });
    expect(c.bestPair?.decidedBy).toBe('IN@1');
  });

  it('no legs at all: HUMAN with no_viable_pair — an empty set is not a refusal', () => {
    const c = concludePairs({ legs: [] });
    expect(c.overall).toBe('HUMAN');
    expect(c.reasonCodes).toEqual(['no_viable_pair']);
    expect(c.bestPair).toBeNull();
    expect(c.retainedPointRefs).toEqual([]);
  });

  it('outbound legs whose inbound the router lost → HUMAN, router_unavailable, never NO', () => {
    const c = concludePairs({
      legs: [
        leg('g1:out', 'g1:in', [{ ref: 'TURN@1', verdict: 'OK' }]),
        leg('g2:out', 'g2:in', [{ ref: 'TURN@2', verdict: 'HUMAN' }]),
      ],
    });
    expect(c.overall).toBe('HUMAN');
    expect(c.reasonCodes).toEqual(['router_unavailable']);
    expect(c.bestPair).toBeNull();
    // Without a pair, the open legs are what a human would still look at.
    expect(c.retainedPointRefs).toEqual(['TURN@2']);
  });

  it('inbound legs nobody continues are the same outage, seen from the other side', () => {
    const c = concludePairs({ legs: [leg('g1:in', null), leg('g2:in', null)] });
    expect(c.overall).toBe('HUMAN');
    expect(c.reasonCodes).toEqual(['router_unavailable']);
  });

  it('the explicit S3 flag names the router even when the structure alone could not', () => {
    const c = concludePairs({ legs: [], routerFailed: true });
    expect(c.overall).toBe('HUMAN');
    expect(c.reasonCodes).toEqual(['router_unavailable']);
  });

  it('a router failure on some legs does not shadow a pair that did form', () => {
    const c = concludePairs({
      legs: [leg('g1:in', null), leg('g1:out', 'g1:in'), leg('g2:out', 'g2:in')],
      routerFailed: true,
    });
    expect(c.overall).toBe('OK');
    expect(c.reasonCodes).toEqual([]);
  });

  it('a point the caller cannot vouch for is not silently OK: judged points speak per leg', () => {
    // The same corner, validated on arrival, still rejected on departure.
    const c = concludePairs({
      legs: [
        leg('g1:in', null, [{ ref: 'TURN@1', verdict: 'OK' }]),
        leg('g1:out', 'g1:in', [{ ref: 'TURN@1', verdict: 'NO' }]),
      ],
    });
    expect(c.overall).toBe('NO');
    expect(c.retainedPointRefs).toEqual(['TURN@1']);
  });

  // the ring guard: a caller who already knows WHY the set is
  // empty (`detectNoLegReachesRing`) hands the motif in, and only then does
  // the reason get more specific than `no_viable_pair`.
  const RING_MOTIF = {
    minReachM: 1800,
    bestReachM: 1312,
    bestWayId: 'w1',
    bestWayName: 'D 113',
    bestAzimuthDeg: 45,
  };

  it('no legs, a ring motif supplied → HUMAN, no_leg_reaches_ring, the motif travels', () => {
    const c = concludePairs({ legs: [], noRouteMotif: RING_MOTIF });
    expect(c.overall).toBe('HUMAN');
    expect(c.reasonCodes).toEqual(['no_leg_reaches_ring']);
    expect(c.bestPair).toBeNull();
    expect(c.noLegReachesRing).toEqual(RING_MOTIF);
  });

  it('no legs, no motif supplied → the silence of no_viable_pair is intact', () => {
    const c = concludePairs({ legs: [] });
    expect(c.reasonCodes).toEqual(['no_viable_pair']);
    expect(c.noLegReachesRing).toBeNull();
  });

  it('a router failure outranks the ring motif — never both codes at once', () => {
    const c = concludePairs({ legs: [], routerFailed: true, noRouteMotif: RING_MOTIF });
    expect(c.reasonCodes).toEqual(['router_unavailable']);
    expect(c.noLegReachesRing).toBeNull();
  });

  it('a formed pair never carries the ring motif, even if the caller passes one', () => {
    const c = concludePairs({
      legs: [leg('g1:in', null), leg('g1:out', 'g1:in')],
      noRouteMotif: RING_MOTIF,
    });
    expect(c.overall).toBe('OK');
    expect(c.noLegReachesRing).toBeNull();
  });
});
