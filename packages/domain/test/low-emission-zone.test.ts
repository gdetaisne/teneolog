/**
 * The one rule in this codebase that is easy to invert and expensive to get
 * wrong: `bannedFrom` names the sticker at which circulation STOPS being
 * allowed, not the worst one still admitted. Reading it backwards tells a
 * carrier their Crit'Air 4 lorry may enter Paris, where it may not.
 *
 * The Paris figures below are the national base's own, read on 2026-08-26:
 * zone 217500016-ZFE-001, `pl_critair: V4`, `pl_horaires: Mo-Su 08:00-20:00`.
 */
import { describe, expect, it } from 'vitest';

import type { LowEmissionZone, TruckProfile } from '../src/index.js';
import { cleanestAdmittedCritAir, readLowEmissionZone } from '../src/index.js';

const PARIS: LowEmissionZone = {
  zoneId: '217500016-ZFE-001',
  name: 'Paris',
  bannedFrom: 'V4',
  hours: 'Mo-Su 08:00-20:00; PH off',
  since: '2021-06-01',
  until: null,
  decreeUrl: null,
  infoUrl: null,
  dataUpdatedAt: '2026-03-26',
};

function truck(critAir?: TruckProfile['critAir']): TruckProfile {
  return {
    id: 'pl-19t',
    label: 'Porteur 19 t',
    family: 'rigid',
    envelope: {
      lengthM: 9, widthM: 2.5, heightM: 3.5, gvwT: 19,
      turnRadiusM: 11, wheelbaseM: 6.1, frontOverhangM: 1.2, rearOverhangM: 1.7,
    },
    equipment: { tailLift: true, crane: false, refrigerated: false },
    ...(critAir === undefined ? {} : { critAir }),
  };
}

describe('readLowEmissionZone', () => {
  it('bans the threshold sticker itself, and everything dirtier', () => {
    expect(readLowEmissionZone(PARIS, truck('V4')).kind).toBe('forbidden');
    expect(readLowEmissionZone(PARIS, truck('V5')).kind).toBe('forbidden');
    expect(readLowEmissionZone(PARIS, truck('NC')).kind).toBe('forbidden');
  });

  it('admits everything cleaner than the threshold', () => {
    expect(readLowEmissionZone(PARIS, truck('V3')).kind).toBe('allowed');
    expect(readLowEmissionZone(PARIS, truck('V1')).kind).toBe('allowed');
    expect(readLowEmissionZone(PARIS, truck('EL')).kind).toBe('allowed');
  });

  it('a gabarit with no declared sticker is unknown, never assumed', () => {
    const outcome = readLowEmissionZone(PARIS, truck());
    expect(outcome.kind).toBe('unknown_vehicle');
    // The rule still travels, so the requirement can be stated.
    if (outcome.kind !== 'unknown_vehicle') throw new Error('expected the zone to be carried');
    expect(outcome.zone.zoneId).toBe(PARIS.zoneId);
  });

  it('no zone, or a zone that spares heavy goods, is not a restriction', () => {
    expect(readLowEmissionZone(null, truck('V5')).kind).toBe('no_zone');
    expect(readLowEmissionZone({ ...PARIS, bannedFrom: null }, truck('NC')).kind).toBe('no_zone');
  });

  it('states the requirement to meet, one rank cleaner than the ban', () => {
    expect(cleanestAdmittedCritAir(PARIS)).toBe('V3');
    // A zone admitting only electric leaves nothing cleaner to name.
    expect(cleanestAdmittedCritAir({ ...PARIS, bannedFrom: 'EL' })).toBeNull();
    expect(cleanestAdmittedCritAir({ ...PARIS, bannedFrom: 'V1' })).toBe('EL');
  });
});
