/**
 * The OSM `highway` vocabulary, in one place.
 *
 * Two rules already read this vocabulary and neither could see the other: the
 * street selection ranked classes to pick a frontage (`street-selection.ts`),
 * and the gate search kept a set of "structuring" classes to place anchors
 * (`routes/src/gates.ts`). S5's pair ranking needs both. A third
 * private copy is how two definitions of the same road class drift apart, so
 * the tables live here — beside `isDrivableWay`, which is the same kind of
 * statement about the same tag.
 *
 * These are vocabulary, not policy. Nothing here is a threshold a run may tune;
 * it is what the OSM tag MEANS, and it is the same for every truck.
 */
import type { RoadWay } from './ports.js';

/**
 * Rank of an OSM class: 1 is the most structuring, 9 the least.
 *
 * Not a metric — a ladder. The gaps carry no meaning, only the order does, and
 * two classes share a rank where the road they describe is the same road
 * (`primary` and `primary_link`, a road and its slip).
 */
const HIGHWAY_RANK: ReadonlyMap<string, number> = new Map([
  ['motorway', 1],
  ['motorway_link', 1],
  ['trunk', 2],
  ['trunk_link', 2],
  ['primary', 3],
  ['primary_link', 3],
  ['secondary', 4],
  ['secondary_link', 4],
  ['tertiary', 5],
  ['tertiary_link', 5],
  ['unclassified', 6],
  ['residential', 6],
  ['living_street', 7],
  ['pedestrian', 7],
  ['service', 8],
  ['track', 9],
]);

/**
 * Rank of a class named by tag value. Null for an absent or unknown class —
 * unknown is not "worst": a missing tag must not lose to a stated one.
 */
export function highwayRankOf(highway: string | null | undefined): number | null {
  if (highway === undefined || highway === null) return null;
  return HIGHWAY_RANK.get(highway) ?? null;
}

/** Rank of the class a way declares. */
export function highwayRank(way: RoadWay): number | null {
  return highwayRankOf(way.tags['highway']);
}

/**
 * OSM classes that count as the structuring network. Vocabulary, not a
 * threshold: these are the roads a route worth considering arrives by.
 * `residential` is deliberately absent — a gate on a residential street is
 * just a second delivery street.
 */
export const STRUCTURING_HIGHWAY: ReadonlySet<string> = new Set([
  'motorway', 'motorway_link', 'trunk', 'trunk_link',
  'primary', 'primary_link', 'secondary', 'secondary_link',
  'tertiary', 'tertiary_link', 'unclassified',
]);

/**
 * Is this class one of the structuring network's?
 *
 * An absent class is NOT structuring. That asymmetry is deliberate and is not
 * the same statement `highwayRankOf` makes: ranking an unknown class would
 * invent a place in the ladder, whereas claiming an untagged way is structuring
 * would be an unearned promotion. A road has to say what it is to be counted
 * among the big ones.
 */
export function isStructuringHighway(highway: string | null | undefined): boolean {
  return highway !== undefined && highway !== null && STRUCTURING_HIGHWAY.has(highway);
}
