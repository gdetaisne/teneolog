/**
 * LE VÉHICULE ARTICULÉ, JUGÉ COMME UN ARTICULÉ —, constat L6-4.
 *
 * Deux moitiés du principe 31 (Décision produit), et elles se testent
 * séparément parce qu'elles se retirent séparément :
 *
 *  1. **la dimension qui balaye.** « Le semi se juge tracteur + remorque
 *     (sellette → essieu 7,70 m, comme l'engine ; l'app avait la simulation de
 *     chaîne sans la brancher au jugement). » Le catalogue livré porte
 *     `wheelbaseM: 3.9` — l'empattement du TRACTEUR — et c'est lui qui entrait
 *     dans `OT = R − √(R² − L²)`, où `L` est ÉLEVÉ AU CARRÉ. Résultat mesuré
 *     avant le correctif : 4,07 m requis dans un angle droit pour le 44 t
 *     contre 5,35 m pour un porteur 19 t. Le plus gros camion du catalogue
 *     exigeait moins que le porteur, et sortait « Certain » là où le porteur
 *     posait une question.
 *  2. **la bande de confort.** « Il faut à l'évidence dégrader, et peut-être
 *     même prendre une marge additionnelle, parce que sortir un semi qui est
 *     bloqué, c'est très compliqué […] sa bande de confort est plus large que
 *     celle d'un porteur (valeur en policy avec cette source ; proposition
 *     0,8 m contre 0,4). » Elle ne refuse rien : elle transforme un OK serré en
 *     question.
 */
import { describe, expect, it } from 'vitest';
import type { CriticalPoint, TruckProfile } from '@teneolog/domain';
import { effectiveOffTrackWheelbaseM } from '@teneolog/domain';
import { requiredWidthForTurnM } from '@teneolog/swept-path';

import { comfortMarginOf, evaluatePoint } from '../src/evaluators.js';
import type { ProjectionPolicy } from '../src/policy.js';
import { POLICY, TRUCKS, truck } from './helpers/thaire-corner.js';

/** La policy de référence, moins la bande de confort par famille — pour l'isoler. */
const WITHOUT_FAMILY_BAND: ProjectionPolicy = { ...POLICY, comfortMarginByFamilyM: {} };

/** Le même semi, sans la sellette → essieu : le catalogue d'. */
const SEMI_ON_ITS_TRACTOR: TruckProfile = (() => {
  const semi = truck('semi-44t');
  const { kingPinToRearAxleM: _dropped, ...envelope } = semi.envelope;
  return { ...semi, envelope };
})();

describe('la dimension qui conduit le déport', () => {
  it('le semi balaye sur sa sellette → essieu, les autres sur leur empattement', () => {
    expect(effectiveOffTrackWheelbaseM(truck('semi-44t'))).toBe(7.7);
    expect(effectiveOffTrackWheelbaseM(truck('pl-19t'))).toBe(6.1);
    expect(effectiveOffTrackWheelbaseM(truck('vul-fourgon'))).toBe(3.7);
    // Un profil de famille `semi` sans la cote retombe sur l'empattement du
    // tracteur : le comportement d'hier, nommé. La garde est le catalogue.
    expect(effectiveOffTrackWheelbaseM(SEMI_ON_ITS_TRACTOR)).toBe(3.9);
  });

  /**
   * LA PHRASE DE L'AUDIT, EN TEST : « le semi 44 t exige moins qu'un 19 t et
   * sort OK là où le 19 t doute ». Elle ne doit plus être vraie.
   */
  it('dans un angle droit, le 44 t exige désormais PLUS que le 19 t', () => {
    const at90 = (profile: TruckProfile): number =>
      requiredWidthForTurnM(
        90,
        {
          id: profile.id,
          label: profile.label,
          lengthM: profile.envelope.lengthM,
          widthM: profile.envelope.widthM,
          wheelbaseM: effectiveOffTrackWheelbaseM(profile),
          turnRadiusM: profile.envelope.turnRadiusM,
          frontOverhangM: profile.envelope.frontOverhangM,
          rearOverhangM: profile.envelope.rearOverhangM,
        },
        POLICY.turnSweptClearanceM,
      );

    // Les trois nombres, au centimètre : 2,55 + 2,13 + 1,0 pour le semi.
    expect(at90(truck('semi-44t'))).toBeCloseTo(5.68, 2);
    expect(at90(truck('pl-19t'))).toBeCloseTo(5.35, 2);
    expect(at90(truck('vul-fourgon'))).toBeCloseTo(4.16, 2);

    expect(at90(truck('semi-44t'))).toBeGreaterThan(at90(truck('pl-19t')));
    // Et la valeur d'avant, pour dire de combien on s'était trompé : 4,07 m,
    // moins que le porteur.
    expect(at90(SEMI_ON_ITS_TRACTOR)).toBeCloseTo(4.07, 2);
    expect(at90(SEMI_ON_ITS_TRACTOR)).toBeLessThan(at90(truck('pl-19t')));
  });
});

describe('la bande de confort du semi', () => {
  it('0,8 m pour la famille articulée, 0,4 m pour les autres', () => {
    expect(comfortMarginOf(truck('semi-44t'), POLICY)).toBe(0.8);
    expect(comfortMarginOf(truck('pl-19t'), POLICY)).toBe(0.4);
    expect(comfortMarginOf(truck('vul-fourgon'), POLICY)).toBe(0.4);
    // Clé absente : tout le monde reprend la générique, au bit près.
    for (const profile of TRUCKS) {
      expect(comfortMarginOf(profile, WITHOUT_FAMILY_BAND)).toBe(0.4);
    }
  });

  /**
   * CE QU'ELLE CHANGE, ET SEULEMENT ÇA : un OK serré devient une question.
   *
   * 3,95 m mesurés à l'arrêt pour 3,35 m requis (2,55 + 0,8) : +0,60 m. Sous la
   * bande du semi, au-dessus de la générique. Un refus, lui, ne dépend que du
   * signe de la marge — la bande n'en fabrique aucun.
   */
  it('une marge de +0,60 m devient une question pour le semi, et reste OK sans la clé', () => {
    const stop: CriticalPoint = {
      ref: 'DESTINATION@46.0000,-0.9629',
      type: 'DESTINATION',
      at: { lat: 46, lon: -1 },
      geometry: {
        known: true,
        value: {
          type: 'DESTINATION',
          width: {
            known: true,
            value: {
              freeM: 3.95,
              structuralM: 3.95,
              measuredAt: { lat: 46, lon: -1 },
              offsetFromAnchorM: 0,
            },
            provenance: { source: 'ign-ortho', method: 'd10', fetchedAt: '2026-09-18T00:00:00Z' },
            reliability: { confidence: 0.9, basis: 'measured', reasonCodes: [] },
          },
        },
        provenance: { source: 'ign-ortho', method: 'stop-constraints', fetchedAt: '2026-09-18T00:00:00Z' },
        reliability: { confidence: 0.9, basis: 'derived', reasonCodes: [] },
      },
      evidence: [],
    };

    const withBand = evaluatePoint(stop, truck('semi-44t'), POLICY);
    expect(withBand.verdict).toBe('HUMAN');
    expect(withBand.marginM ?? 0).toBeCloseTo(0.6, 2);
    expect(withBand.reasonCodes).toContain('margin_within_comfort_band');

    const without = evaluatePoint(stop, truck('semi-44t'), WITHOUT_FAMILY_BAND);
    expect(without.verdict).toBe('OK');
    expect(without.marginM ?? 0).toBeCloseTo(0.6, 2);
  });
});
