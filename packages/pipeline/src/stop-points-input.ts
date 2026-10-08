/**
 * What the stop contributes to `collectCriticalPoints`, written once.
 *
 * Four call sites (the full run, its per-batch stop, the no-R0 run, the
 * no-route run) built the same fields by hand, and `2bf8c43` added
 * `turnaroundAt` to three of them — the fourth had already been forgotten,
 * and the A/B harnesses had been too. One reading of the facts, every caller
 * (principe 23).
 */
import type { CollectPointsInput } from '@teneolog/points';
import { preferredMappedTurnaroundAt } from '@teneolog/topology';

import type { S0S2Facts } from './analyse.js';

export type StopPointsInput = Pick<
  CollectPointsInput,
  'stop' | 'topology' | 'fetchedAt' | 'terminalNodeInterior' | 'turnaroundAt'
>;

export function stopPointsInputOf(facts: S0S2Facts, fetchedAt: string): StopPointsInput {
  // A partial fixture, or facts assembled before the candidates existed,
  // carry none: then there is no mapped place to sit the point on — the
  // point stays at the stop, as it did before never a crash.
  const candidates = (facts.topology as { egressCandidates?: S0S2Facts['topology']['egressCandidates'] }).egressCandidates;
  return {
    stop: facts.stop,
    topology: facts.topology.topology,
    fetchedAt,
    terminalNodeInterior: facts.topology.terminalNodeInterior,
    turnaroundAt: candidates === undefined ? undefined : preferredMappedTurnaroundAt(candidates),
  };
}
