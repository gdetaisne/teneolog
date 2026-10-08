/**
 * S2/S3 — legal bands from every source that described the street.
 *
 * This is the data-source fix for the engine's BUG-087 class: OSM legal
 * restrictions existed, were parsed correctly, and never reached the product
 * path — a weight limit present in OSM and absent from BDTOPO was invisible,
 * and the truck was routed through it. Here the merge is the only door: every
 * description of the same street goes in, the smallest readable limit wins,
 * and each source's stated value stays visible so a disagreement is a fact,
 * never an average.
 *
 * Access semantics are the engine's validated specification (its wiring was
 * wrong, its rules were right):
 * - `access=no` bars everyone; `hgv=no` bars heavy goods only.
 * - destination / delivery / agricultural / forestry / permit are CONDITIONAL —
 *   "sauf desserte locale". Whether a conditional segment clears depends on
 *   its position in the route (approach/egress lawful, transit not), which is
 *   the consumer's judgement: this module only states the rule.
 * - `private` is deliberately NOT a bar and NOT conditional: a commissioned
 *   delivery to a private way is the normal, permitted case (M8e). Privacy
 *   already travels on `RoadWay.isPrivate`.
 */
import type { AccessRule, Fact, LegalBands, LegalLimit, SourceId } from '@teneolog/domain';
import type { RoadWay } from '@teneolog/topology';

export interface LegalBandsInput {
  /** Every description of the same street — typically one BDTOPO, one OSM. */
  readonly descriptions: readonly RoadWay[];
  readonly fetchedAt: string;
}

export function mergeLegalBands(input: LegalBandsInput): LegalBands {
  return {
    maxWeightT: mergeLimit(input, (w) => w.limits.maxWeightT),
    maxHeightM: mergeLimit(input, (w) => w.limits.maxHeightM),
    maxWidthM: mergeLimit(input, (w) => w.limits.maxWidthM),
    maxLengthM: mergeLimit(input, (w) => w.limits.maxLengthM),
    access: mergeAccess(input),
    // No adapter feeds LEZ yet. An honest unknown outranks a fabricated
    // "no zone": the difference is a fine.
    lowEmissionZone: { known: false, why: 'no_data' },
  };
}

function mergeLimit(
  input: LegalBandsInput,
  read: (way: RoadWay) => number | null,
): Fact<LegalLimit> {
  const stated: { source: SourceId; value: number }[] = [];
  for (const way of input.descriptions) {
    const value = read(way);
    if (value !== null) stated.push({ source: way.source, value });
  }
  if (stated.length === 0) {
    // Every source was silent. Distinct from "no limit exists": the road may
    // carry a sign nobody surveyed, which is why this is a Fact and not a null.
    return { known: false, why: 'no_data' };
  }

  const smallest = stated.reduce((a, b) => (b.value < a.value ? b : a));
  const sources = [...new Set(stated.map((s) => s.source))];
  return {
    known: true,
    value: { value: smallest.value, sources, statedValues: stated },
    provenance: { source: smallest.source, method: 'legal-limit-smallest-wins', fetchedAt: input.fetchedAt },
    reliability: {
      confidence: 1,
      basis: 'declared',
      reasonCodes:
        new Set(stated.map((s) => s.value)).size > 1
          ? ['legal_limit_sources_disagree']
          : ['legal_limit_declared'],
    },
  };
}

/** OSM access-tag values meaning "open conditionally" — the engine's C2 bucket. */
const CONDITIONAL_ACCESS = new Set(['destination', 'delivery', 'agricultural', 'forestry', 'permit']);
/** Values that are information, never a bar — `private` is the M8e decision. */
const INFO_ACCESS = new Set(['private', 'permissive', 'yes', 'unknown']);

function mergeAccess(input: LegalBandsInput): Fact<AccessRule> {
  // an empty description list means no source described this street —
  // the absence of data must not become a positive "open" assertion attributed
  // to a source that never said anything. Matches the `no_data` pattern used
  // by every `mergeLimit` call in this same file.
  if (input.descriptions.length === 0) return { known: false, why: 'no_data' };

  let rule: AccessRule = { kind: 'open' };
  let decidedBy: SourceId | null = null;
  const permits = new Set<'destination' | 'delivery' | 'permit'>();

  for (const way of input.descriptions) {
    const access = way.tags['access'];
    const hgv = way.tags['hgv'];
    const motor = way.tags['motor_vehicle'];

    // Forbidden beats conditional beats open; the strictest source speaks.
    if (access === 'no' || motor === 'no') {
      rule = { kind: 'forbidden', appliesTo: 'all' };
      decidedBy = way.source;
      break;
    }
    if (hgv === 'no') {
      rule = { kind: 'forbidden', appliesTo: 'hgv' };
      decidedBy = way.source;
      continue;
    }
    for (const raw of [access, hgv, motor]) {
      if (raw === undefined || INFO_ACCESS.has(raw)) continue;
      if (CONDITIONAL_ACCESS.has(raw)) {
        permits.add(raw === 'agricultural' || raw === 'forestry' ? 'permit' : (raw as 'destination' | 'delivery' | 'permit'));
        if (rule.kind === 'open') {
          rule = { kind: 'conditional', permits: [] };
          decidedBy = way.source;
        }
      }
    }
  }

  if (rule.kind === 'conditional') {
    rule = { kind: 'conditional', permits: [...permits] };
  }

  const first = input.descriptions[0];
  return {
    known: true,
    value: rule,
    provenance: {
      source: decidedBy ?? first?.source ?? 'osm-overpass',
      method: 'access-rule-strictest-source',
      fetchedAt: input.fetchedAt,
    },
    reliability: {
      confidence: 1,
      basis: 'declared',
      reasonCodes: [`access_${rule.kind}`],
    },
  };
}
