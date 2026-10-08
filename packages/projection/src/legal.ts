/**
 * S5 — one candidate's legality for one truck.
 *
 * The end of the BUG-087 chain: the annotated segment bands meet the truck's
 * papers. A block names its segment (`blockedAtSegmentId`) so "no itinerary"
 * can finally say WHERE and WHY — the engine flattened every distinct cause
 * into the same empty answer (BUG-034, BUG-038).
 *
 * E1 lands here too: a conditional-access segment in TRANSIT is a violation;
 * the same band on the approach or the egress is the legitimate local
 * service and clears with its reason spoken.
 */
import type { CandidateVerdict, FactRef, LegalBands, RouteCandidate, TruckProfile } from '@teneolog/domain';

import type { ProjectionPolicy } from './policy.js';

export interface LegalBlock {
  readonly code: string;
  readonly source: FactRef['source'];
  readonly confidence: number;
}

/**
 * The first legal band of ONE set that stops THIS truck: the four limits in
 * the order the road signs them (weight, height, width, length), then an
 * access forbidden to everyone or to heavy goods vehicles. Null when none
 * bites — an absent limit says nothing (principe 5). The single reading for a
 * corridor segment and for a stop (the fallback stop is checked with
 * the same rule as the itinerary, principe 23).
 */
export function legalBlockOf(legal: LegalBands, truck: TruckProfile, isHgv: boolean): LegalBlock | null {
  const limits = [
    [legal.maxWeightT, truck.envelope.gvwT, 'legal_weight_limit_exceeded'],
    [legal.maxHeightM, truck.envelope.heightM, 'legal_height_limit_exceeded'],
    [legal.maxWidthM, truck.envelope.widthM, 'legal_width_limit_exceeded'],
    [legal.maxLengthM, truck.envelope.lengthM, 'legal_length_limit_exceeded'],
  ] as const;
  for (const [fact, own, code] of limits) {
    if (fact.known && own > fact.value.value) {
      return { code, source: fact.provenance.source, confidence: fact.reliability.confidence };
    }
  }
  const access = legal.access;
  if (access.known && access.value.kind === 'forbidden' && (access.value.appliesTo === 'all' || isHgv)) {
    return {
      code: access.value.appliesTo === 'all' ? 'access_forbidden' : 'access_forbidden_hgv',
      source: access.provenance.source,
      confidence: access.reliability.confidence,
    };
  }
  return null;
}

export function evaluateCandidateLegality(
  candidate: RouteCandidate,
  truck: TruckProfile,
  policy: ProjectionPolicy,
): CandidateVerdict {
  // Defence-in-depth: a corridor with zero annotated segments
  // cannot be checked. An empty corridor is most often an Overpass timeout
  // that slipped through — never a genuine "no restrictions" answer.
  // Escalate to HUMAN rather than silently clearing the candidate.
  if (candidate.segments.length === 0) {
    return {
      candidateId: candidate.id,
      verdict: 'HUMAN',
      blockedAtSegmentId: null,
      reasonCodes: ['corridor_empty'],
      derivedFrom: [],
    };
  }
  // a corridor whose samples were mostly left unmatched (below
  // policy.candidates.minCorridorCoverage, decided in S3) has legal bands and
  // widths missing on those stretches. Half-mute is not clean: escalate.
  if (candidate.corridorReasonCodes.includes('corridor_partial')) {
    return {
      candidateId: candidate.id,
      verdict: 'HUMAN',
      blockedAtSegmentId: null,
      reasonCodes: ['corridor_partial'],
      derivedFrom: [],
    };
  }

  const reasonCodes: string[] = [];
  const derivedFrom: FactRef[] = [];
  const isHgv = truck.envelope.gvwT > policy.hgvThresholdT;

  for (const segment of candidate.segments) {
    const blocked = (code: string, source: FactRef['source'], confidence: number): CandidateVerdict => ({
      candidateId: candidate.id,
      verdict: 'NO',
      blockedAtSegmentId: segment.segmentId,
      reasonCodes: [...reasonCodes, code],
      derivedFrom: [...derivedFrom, { path: `${candidate.id}/${segment.segmentId}`, source, confidence }],
    });

    const block = legalBlockOf(segment.legal, truck, isHgv);
    if (block !== null) return blocked(block.code, block.source, block.confidence);

    const access = segment.legal.access;
    if (access.known) {
      const rule = access.value;
      if (rule.kind === 'conditional') {
        if (segment.position === 'transit') {
          return blocked('conditional_access_in_transit', access.provenance.source, access.reliability.confidence);
        }
        // Legitimate local service: cleared, and said out loud once.
        if (!reasonCodes.includes('conditional_access_cleared_local_service')) {
          reasonCodes.push('conditional_access_cleared_local_service');
        }
      }
    }
  }

  return {
    candidateId: candidate.id,
    verdict: 'OK',
    blockedAtSegmentId: null,
    reasonCodes,
    derivedFrom,
  };
}
