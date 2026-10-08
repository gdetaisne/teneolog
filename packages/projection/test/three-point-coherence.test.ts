/**
 * (b) Le trois temps et le un temps parlent du même camion.
 *
 * Le cercle du « un temps » a pour diamètre `turnaroundRequirementM` — 2 R +
 * dégagement, 24 m pour le 19 t — et c'est la seule source de ce nombre
 * (principe 23) : il est lu ici, jamais recalculé. Le simulateur du trois temps
 * (`@teneolog/swept-path`, `simulateThreePointTurn`), posé dans une rue sans
 * branche de cette largeur-là, doit trouver le demi-tour d'un seul mouvement :
 * sinon le cercle dessiné et l'empreinte diraient deux choses du même camion.
 *
 * Le test vit ici parce que `projection` voit les deux paquets (`swept-path` ne
 * dépend de rien).
 */
import { describe, expect, it } from 'vitest';
import { simulateThreePointTurn, type TruckSpec } from '@teneolog/swept-path';

import { turnaroundRequirementM } from '../src/evaluators.js';
import { PL19, POLICY } from './helpers/pairs-fixture.js';

/** Le gabarit tel que le simulateur le lit : les mêmes cotes que le profil, par leur nom. */
const PL19_SPEC: TruckSpec = {
  id: PL19.id,
  label: PL19.label,
  lengthM: PL19.envelope.lengthM,
  widthM: PL19.envelope.widthM,
  wheelbaseM: PL19.envelope.wheelbaseM,
  turnRadiusM: PL19.envelope.turnRadiusM,
  frontOverhangM: PL19.envelope.frontOverhangM,
  rearOverhangM: PL19.envelope.rearOverhangM,
};

describe('le trois temps retrouve le un temps à la largeur requise', () => {
  it('une rue sans branche large du requis du demi-tour (24 m pour le 19 t) : un seul temps', () => {
    const requiredM = turnaroundRequirementM(PL19, POLICY);
    expect(requiredM).toBe(24);
    const result = simulateThreePointTurn({
      truck: PL19_SPEC,
      streetWidthM: requiredM,
      side: 'right',
      variant: 'no_branch',
      branch: null,
    });
    expect(result.status).toBe('found');
    expect(result.temps).toBe(1);
    expect(result.ghostPoses).toHaveLength(1);
  });

  it('et le dégagement du requis n’est pas à zéro : sans lui (2 R = 22 m), le modèle ne tient plus en un temps', () => {
    const withoutClearanceM = turnaroundRequirementM(PL19, { ...POLICY, turnaroundClearanceM: 0 });
    const result = simulateThreePointTurn({
      truck: PL19_SPEC,
      streetWidthM: withoutClearanceM,
      side: 'right',
      variant: 'no_branch',
      branch: null,
    });
    expect(result.temps).toBe(3);
  });
});
