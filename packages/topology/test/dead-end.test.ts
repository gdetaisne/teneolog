/**
 * Terminal classification against the field corpus.
 *
 * Each fixture reproduces the TRAP of its corpus case — the naive
 * implementation that got the address wrong — so a regression here is a
 * regression on a documented delivery, not on an abstraction.
 */
import { describe, expect, it } from 'vitest';
import type { GeoPoint } from '@teneolog/domain';

import { classifyTerminal, type TerminalInput } from '../src/dead-end.js';
import { at, neighbourhood, way } from './fixtures.js';

// 10 allée Voisine LM, 36330 Le Poinçonnet (EC-18).
const POINCONNET: GeoPoint = { lat: 46.773049, lon: 1.7491 };
// 15 Impasse Voisine TR, 17220 Saint-Vivien (EC-17).
const SAINT_VIVIEN: GeoPoint = { lat: 46.075556, lon: -1.011659 };
// 8 Rue du Prototype, 92140 Clamart (BUG-037a).
const CLAMART: GeoPoint = { lat: 48.80236, lon: 2.30104 };
// 14 Avenue de l’Essai, 89000 Auxerre — same-name spur (BUG-068 / EC-29).
const AUXERRE: GeoPoint = { lat: 47.80366246125379, lon: 3.6202104271729695 };

function input(
  overrides: Pick<TerminalInput, 'neighbourhood' | 'deliveryWayId' | 'deliveryPoint'> & Partial<TerminalInput>,
): TerminalInput {
  return { ...overrides };
}

describe('classifyTerminal', () => {
  it('EC-18: a street ending in a loop of plain residential ways is TERMINAL_LOOP, never THROUGH', () => {
    const o = POINCONNET;
    // The allée runs east and ends where an untagged bulb of ordinary ways
    // circles back — the common mapping reality: no `junction=turning_loop`.
    const allee = way('allee', ['mouth', 'bulb-entry'], [at(o, 0, -20), at(o, 0, 10)]);
    const bulbNorth = way(
      'bulb-n',
      ['bulb-entry', 'bulb-top', 'bulb-far'],
      [at(o, 0, 10), at(o, 8, 18), at(o, 0, 26)],
    );
    const bulbSouth = way(
      'bulb-s',
      ['bulb-entry', 'bulb-bottom', 'bulb-far'],
      [at(o, 0, 10), at(o, -8, 18), at(o, 0, 26)],
    );
    const parent = way('parent', ['p1', 'mouth', 'p2'], [at(o, 30, -20), at(o, 0, -20), at(o, -30, -20)]);
    const hood = neighbourhood(o, 60, [allee, bulbNorth, bulbSouth, parent]);

    const result = classifyTerminal(input({ neighbourhood: hood, deliveryWayId: 'allee', deliveryPoint: o }));

    expect(result.topology.kind).toBe('TERMINAL_LOOP');
    if (result.topology.kind !== 'TERMINAL_LOOP') return;
    // The trap (A1): the old code read a loop as "not a dead end" and skipped
    // sizing for every truck. Here the loop must arrive UNMEASURED, so the
    // sizing question survives to the module that can answer it.
    expect(result.topology.turnaround.known).toBe(false);
  });

  it('a mapper-asserted junction=turning_loop touching the tip is TERMINAL_LOOP with an unmeasured turnaround', () => {
    const o = POINCONNET;
    const street = way('street', ['mouth', 'tip'], [at(o, 0, -20), at(o, 0, 15)]);
    const loop = way(
      'loop',
      ['tip', 'l1', 'l2', 'tip'],
      [at(o, 0, 15), at(o, 6, 21), at(o, -6, 21), at(o, 0, 15)],
      { tags: { junction: 'turning_loop' } },
    );
    const parent = way('parent', ['p1', 'mouth', 'p2'], [at(o, 30, -20), at(o, 0, -20), at(o, -30, -20)]);
    const hood = neighbourhood(o, 60, [street, loop, parent]);

    const result = classifyTerminal(input({ neighbourhood: hood, deliveryWayId: 'street', deliveryPoint: o }));

    expect(result.topology.kind).toBe('TERMINAL_LOOP');
    if (result.topology.kind !== 'TERMINAL_LOOP') return;
    // The mapper asserted a shape, not a size: EC-17's circle exists and is too
    // small for a 19 t. A tag must never become a measured diameter.
    expect(result.topology.turnaround.known).toBe(false);
  });

  it("EC-18 inverse: the neighbour cul-de-sac's turning loop does not answer for this street", () => {
    const o = POINCONNET;
    const street = way('street', ['mouth', 'tip'], [at(o, 0, -20), at(o, 0, 15)]);
    // A turning loop 35 m north, attached to a different street entirely.
    const neighbourLoop = way(
      'neighbour-loop',
      ['n-tip', 'n1', 'n2', 'n-tip'],
      [at(o, 35, 15), at(o, 41, 21), at(o, 29, 21), at(o, 35, 15)],
      { tags: { junction: 'turning_loop' } },
    );
    const parent = way('parent', ['p1', 'mouth', 'p2'], [at(o, 30, -20), at(o, 0, -20), at(o, -30, -20)]);
    const hood = neighbourhood(o, 60, [street, neighbourLoop, parent]);

    const result = classifyTerminal(input({ neighbourhood: hood, deliveryWayId: 'street', deliveryPoint: o }));

    // The old signal was neighbourhood-wide: any loop within the fetch answered
    // for every street. Anchoring to this street's own tips is the fix.
    expect(result.topology.kind).toBe('DEAD_END');
  });

  it('EC-17 Saint-Vivien: a plain dead end with an interior tip is DEAD_END with the turnaround unknown', () => {
    const o = SAINT_VIVIEN;
    const impasse = way('impasse', ['mouth', 'tip'], [at(o, 0, -15), at(o, 0, 20)]);
    const parent = way('parent', ['p1', 'mouth', 'p2'], [at(o, 30, -15), at(o, 0, -15), at(o, -30, -15)]);
    const hood = neighbourhood(o, 50, [impasse, parent]);

    const result = classifyTerminal(input({ neighbourhood: hood, deliveryWayId: 'impasse', deliveryPoint: o }));

    expect(result.topology.kind).toBe('DEAD_END');
    expect(result.terminalNodeInterior).toBe(true);
    if (result.topology.kind !== 'DEAD_END') return;
    expect(result.topology.turnaround.known).toBe(false);
  });

  it('BUG-037a Clamart: an attribute break with geometric continuation is THROUGH, and says the break out loud', () => {
    const o = CLAMART;
    // One straight carriageway split where the name and one-way flag change.
    const north = way('pvc', ['top', 'break'], [at(o, 60, 0), at(o, 0, 0)], {
      name: 'Rue du Prototype',
      importance: 5,
    });
    // Both continuations leave the fetched view: a network wholly contained in
    // the payload is a closed world, which the escape rule rightly reads as
    // having no way out.
    const south = way('voisineT', ['break', 'bottom', 'far'], [at(o, 0, 0), at(o, -40, 0), at(o, -120, 0)], {
      name: 'Rue Voisine T',
      importance: 4,
      oneWay: 'forward',
    });
    const top = way('top-street', ['t1', 'top', 't2'], [at(o, 60, -30), at(o, 60, 0), at(o, 60, 120)]);
    const hood = neighbourhood(o, 100, [north, south, top]);

    const result = classifyTerminal(
      input({ neighbourhood: hood, deliveryWayId: 'pvc', deliveryPoint: at(o, 10, 0) }),
    );

    // The trap: way identity read as street identity fabricated a terminus here
    // and the engine demanded an on-site U-turn on a street that plainly goes on.
    expect(result.topology.kind).toBe('THROUGH');
    if (result.topology.kind !== 'THROUGH') return;
    expect(result.topology.continuity.attributeBreak).toBe(true);
  });

  it('a mid-block segment of an ordinary street is THROUGH', () => {
    const o = CLAMART;
    const middle = way('middle', ['a', 'b'], [at(o, 20, 0), at(o, -20, 0)], { name: 'Rue X' });
    const upper = way('upper', ['a2', 'a'], [at(o, 120, 0), at(o, 20, 0)], { name: 'Rue X' });
    const lower = way('lower', ['b', 'b2'], [at(o, -20, 0), at(o, -120, 0)], { name: 'Rue X' });
    const hood = neighbourhood(o, 100, [middle, upper, lower]);

    const result = classifyTerminal(input({ neighbourhood: hood, deliveryWayId: 'middle', deliveryPoint: o }));

    expect(result.topology.kind).toBe('THROUGH');
  });

  it('one dead tip is enough: a segment continuing on one side only is DEAD_END', () => {
    const o = SAINT_VIVIEN;
    const spur = way('spur', ['mouth', 'tip'], [at(o, 0, 0), at(o, 0, 30)]);
    const parent = way('parent', ['p1', 'mouth', 'p2'], [at(o, 30, 0), at(o, 0, 0), at(o, -30, 0)]);
    const hood = neighbourhood(o, 60, [spur, parent]);

    const result = classifyTerminal(input({ neighbourhood: hood, deliveryWayId: 'spur', deliveryPoint: at(o, 0, 10) }));

    expect(result.topology.kind).toBe('DEAD_END');
  });

  it('BUG-068 / A3: a genuine tip at 46.5 m in a 50 m fetch is interior — no 0.7 ratio blind ring', () => {
    const o = AUXERRE;
    const spur = way('spur', ['mouth', 'tip'], [at(o, 0, -3), at(o, 0, 46.5)], {
      name: 'Avenue de l’Essai',
    });
    const n77 = way('n77', ['p1', 'mouth', 'p2'], [at(o, 60, -3), at(o, 0, -3), at(o, -60, -3)], {
      name: 'Avenue de l’Essai',
      importance: 3,
    });
    const hood = neighbourhood(o, 50, [spur, n77]);

    const result = classifyTerminal(input({ neighbourhood: hood, deliveryWayId: 'spur', deliveryPoint: at(o, 0, 5) }));

    // The trap: the old guard trusted degree-1 only inside 0.7 x radius = 35 m,
    // so this tip fell in the blind ring and the dead end vanished.
    expect(result.topology.kind).toBe('DEAD_END');
    expect(result.terminalNodeInterior).toBe(true);
  });

  it('BUG-003: a dead-shaped tip at the fetch boundary is reported non-interior — fetch wider, not THROUGH', () => {
    const o = AUXERRE;
    const clipped = way('clipped', ['mouth', 'cut'], [at(o, 0, -3), at(o, 0, 50.5)]);
    const parent = way('parent', ['p1', 'mouth', 'p2'], [at(o, 60, -3), at(o, 0, -3), at(o, -60, -3)]);
    const hood = neighbourhood(o, 50, [clipped, parent]);

    const result = classifyTerminal(input({ neighbourhood: hood, deliveryWayId: 'clipped', deliveryPoint: at(o, 0, 5) }));

    // The payload cannot prove the road goes on, so the shape reads DEAD_END —
    // but non-interior says "this claim would not survive a wider fetch".
    expect(result.terminalNodeInterior).toBe(false);
  });

  it('A6: a one-way inbound dead end carries its entry direction — no turnaround can rescue an illegal exit', () => {
    const o = SAINT_VIVIEN;
    const impasse = way('impasse', ['mouth', 'tip'], [at(o, 0, -15), at(o, 0, 25)], {
      oneWay: 'forward',
    });
    const parent = way('parent', ['p1', 'mouth', 'p2'], [at(o, 30, -15), at(o, 0, -15), at(o, -30, -15)]);
    const hood = neighbourhood(o, 60, [impasse, parent]);

    const result = classifyTerminal(input({ neighbourhood: hood, deliveryWayId: 'impasse', deliveryPoint: o }));

    expect(result.topology.kind).toBe('DEAD_END');
    if (result.topology.kind !== 'DEAD_END') return;
    const entry = result.topology.entryDirection;
    expect(entry.known).toBe(true);
    if (!entry.known) return;
    expect(entry.value.oneWay).toBe(true);
    // Node order runs west→east, so 'forward' permits an eastbound heading.
    expect(entry.value.permittedHeadingDeg).not.toBeNull();
    expect(Math.abs((entry.value.permittedHeadingDeg ?? 0) - 90)).toBeLessThan(5);
    expect(entry.reliability.basis).toBe('declared');
  });

  it('BUG-048d: a delivery way absent from the payload claims nothing — unknown on both facts, zero reach', () => {
    const o = SAINT_VIVIEN;
    const other = way('other', ['a', 'b'], [at(o, 30, 0), at(o, -30, 0)]);
    const hood = neighbourhood(o, 50, [other]);

    const result = classifyTerminal(input({ neighbourhood: hood, deliveryWayId: 'missing', deliveryPoint: o }));

    // Neither a false OK (THROUGH on a coverage gap) nor a confident reject:
    // an uncorroborated terminal with zero resolved reach reads as "fetch again".
    expect(result.resolvedWithinM).toBe(0);
    expect(result.terminalNodeInterior).toBe(false);
    expect(result.topology.kind).toBe('DEAD_END');
    if (result.topology.kind !== 'DEAD_END') return;
    expect(result.topology.turnaround.known).toBe(false);
    if (result.topology.turnaround.known) return;
    expect(result.topology.turnaround.why).toBe('out_of_coverage');
  });

  it('a delivery way that is itself a closed ring is TERMINAL_LOOP', () => {
    const o = POINCONNET;
    const ring = way(
      'ring',
      ['r0', 'r1', 'r2', 'r0'],
      [at(o, 0, 0), at(o, 10, 8), at(o, -10, 8), at(o, 0, 0)],
    );
    const hood = neighbourhood(o, 60, [ring]);

    const result = classifyTerminal(input({ neighbourhood: hood, deliveryWayId: 'ring', deliveryPoint: o }));

    expect(result.topology.kind).toBe('TERMINAL_LOOP');
  });
});

describe('EC-24 escape rule', () => {
  // Saint-Fulgent, found live: the impasse's far end sprouts short service
  // driveways. An exit into a contained pocket is not an exit.
  it('an impasse whose tip continues only into contained driveways stays DEAD_END', () => {
    const o: import('@teneolog/domain').GeoPoint = { lat: 46.856414, lon: -1.145828 };
    const impasse = way('impasse', ['mouth', 'tip'], [at(o, 0, -15), at(o, 0, 30)]);
    // Two driveways off the tip, both ending inside the fetch.
    const drive1 = way('drive1', ['tip', 'd1'], [at(o, 0, 30), at(o, 12, 42)], {
      tags: { highway: 'service' },
    });
    const drive2 = way('drive2', ['tip', 'd2'], [at(o, 0, 30), at(o, -12, 42)], {
      tags: { highway: 'service' },
    });
    const parent = way(
      'parent',
      ['p1', 'mouth', 'p2'],
      [at(o, 120, -15), at(o, 0, -15), at(o, -120, -15)],
    );
    const hood = neighbourhood(o, 100, [impasse, drive1, drive2, parent]);

    const result = classifyTerminal({ neighbourhood: hood, deliveryWayId: 'impasse', deliveryPoint: o });

    expect(result.topology.kind).toBe('DEAD_END');
  });

  it('the same tip with a driveway that leaves the fetch is THROUGH', () => {
    const o: import('@teneolog/domain').GeoPoint = { lat: 46.856414, lon: -1.145828 };
    const impasse = way('impasse', ['mouth', 'tip'], [at(o, 0, -15), at(o, 0, 30)]);
    const onward = way('onward', ['tip', 'far'], [at(o, 0, 30), at(o, 0, 130)], {
      tags: { highway: 'service' },
    });
    const parent = way(
      'parent',
      ['p1', 'mouth', 'p2'],
      [at(o, 120, -15), at(o, 0, -15), at(o, -120, -15)],
    );
    const hood = neighbourhood(o, 100, [impasse, onward, parent]);

    const result = classifyTerminal({ neighbourhood: hood, deliveryWayId: 'impasse', deliveryPoint: o });

    expect(result.topology.kind).toBe('THROUGH');
  });
});
