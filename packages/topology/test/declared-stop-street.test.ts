/**
 * UN ARRÊT POSÉ PAR LE MOTEUR GARDE SA RUE.
 *
 * Prod, 2026-09-30 : à 3 route du Modèle, 79260 La Crèche, « Non » au
 * demi-tour puis « Livrer depuis ce point » sur l'arrêt de repli (Rue de
 * Voisine B, 268 m) — deux runs, deux fois « street: below_confidence » en S0.
 * L'arrêt est à 15 m de la bouche, et la Route du Modèle en repart presque
 * parallèle : à 5,7 m de l'arrêt, dans la fenêtre d'ambiguïté, même rang,
 * même largeur, aucune des deux ne finit dans le barreau de 80 m. Rechoisir la
 * rue d'un arrêt que le moteur a lui-même posé sur la Rue Voisine B était un
 * concours sans vainqueur.
 *
 * Les voisinages sont ceux que S0 lit (barreau de 80 m, Overpass + greffe BD
 * TOPO de la prod, relus le 2026-09-30) : `fixtures/la-creche-arret-de-repli-s0.json`.
 *
 * Relecture du 2026-09-30 : la voie d'un POINT CLIQUÉ n'a pas le poids de
 * celle de l'arrêt du moteur. L'aperçu accroche le clic à la chaussée la plus
 * proche (`free-point.ts`) — l'heuristique même que la règle d'Auxerre
 * renverse. Retenue sans concours, elle faisait passer un clic à 8 m dans
 * l'antenne d'Auxerre de la primaire (TRAVERSANTE en S1) à l'antenne
 * (IMPASSE), sans A/B (principe 17). Le clic ne fait donc que départager une
 * égalité ; l'arrêt de repli, posé par construction sur sa rue d'avant, garde
 * la sienne sans concours. Voisinage d'Auxerre : `fixtures/auxerre-point-clique-s0.json`.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import type { GeoPoint } from '@teneolog/domain';

import type { RoadNeighbourhood, RoadWay } from '../src/ports.js';
import {
  selectDeliveryStreetWithSearch,
  type DeclaredWay,
  type StreetSelectionInput,
} from '../src/street-selection.js';

type Place = { readonly point: GeoPoint; readonly hood: RoadNeighbourhood };
const FIXTURE = JSON.parse(
  readFileSync(new URL('./fixtures/la-creche-arret-de-repli-s0.json', import.meta.url), 'utf8'),
) as { stop: Place; clickModele: Place; clickVoisineB: Place };

const RUE_VOISINE_B = '1415923834';
const ROUTE_DE_L_ISLE = '53683785';

/** L'arrêt de repli du moteur, posé sur sa rue d'avant. */
const stopOn = (id: string): DeclaredWay => ({ id, by: 'fallback_stop' });
/** Un clic, accroché par l'aperçu à la chaussée la plus proche. */
const clickOn = (id: string): DeclaredWay => ({ id, by: 'clicked_point' });

/** `pipeline.selection` de la policy, telle que la prod la lit. */
function at(place: Place, declaredWay?: DeclaredWay): StreetSelectionInput {
  return {
    point: place.point,
    neighbourhood: place.hood,
    maxSnapM: 30,
    ambiguityWindowM: 12,
    minWidthAdvantageM: 0.5,
    tipInteriorMarginM: 5,
    continuationDeviationDeg: 40,
    fetchedAt: '2026-09-30T08:48:00Z',
    confidence: { unambiguous: 0.9, resolvedByRank: 0.75 },
    ...(declaredWay === undefined ? {} : { declaredWay }),
  };
}

describe('La Crèche — la rue d’un arrêt posé par le moteur', () => {
  it('rejoue la prod : sans la rue de l’arrêt, S0 ne départage pas les deux rues (below_confidence)', () => {
    for (const place of [FIXTURE.stop, FIXTURE.clickModele, FIXTURE.clickVoisineB]) {
      const { street } = selectDeliveryStreetWithSearch(at(place));
      expect(street.known ? street.value.name : street.why).toBe('below_confidence');
    }
  });

  it('l’arrêt de repli garde la Rue Voisine B ; la Route du Modèle, à 5,7 m, est écartée et nommée', () => {
    const { street, search } = selectDeliveryStreetWithSearch(at(FIXTURE.stop, stopOn(RUE_VOISINE_B)));
    if (!street.known) throw new Error(`street unknown: ${street.why}`);
    expect(street.value.segmentId).toBe(RUE_VOISINE_B);
    expect(street.value.name).toBe('Rue Voisine B');
    expect(street.reliability.reasonCodes).toContain('street_declared_by_stop');
    expect(street.value.alternativesConsidered).toEqual([
      expect.objectContaining({ segmentId: ROUTE_DE_L_ISLE, reason: 'declared_stop_street' }),
    ]);
    expect(street.value.alternativesConsidered[0]?.distanceFromPointM).toBeCloseTo(5.7, 1);
    // La couche grise dit la même chose que la décision.
    const row = (id: string) => search.considered.find((c) => c.segmentId === id);
    expect(row(RUE_VOISINE_B)).toMatchObject({ outcome: 'retained', stage: 'retained' });
    expect(row(ROUTE_DE_L_ISLE)).toMatchObject({ outcome: 'compared', stage: 'compared', reason: 'declared_stop_street' });
  });

  it('un point cliqué projeté sur la Route du Modèle, à l’entrée de l’impasse : le concours est à égalité, le clic départage', () => {
    const { street } = selectDeliveryStreetWithSearch(at(FIXTURE.clickModele, clickOn(ROUTE_DE_L_ISLE)));
    if (!street.known) throw new Error(`street unknown: ${street.why}`);
    expect(street.value.segmentId).toBe(ROUTE_DE_L_ISLE);
    expect(street.reliability.reasonCodes).toContain('street_declared_breaks_tie');
    expect(street.reliability.reasonCodes).not.toContain('street_declared_by_stop');
    expect(street.value.alternativesConsidered.map((r) => r.reason)).toEqual(['declared_stop_street']);
  });

  it('un point cliqué projeté sur la Rue Voisine B, près de la bouche : le clic départage, la Rue Voisine B', () => {
    const { street } = selectDeliveryStreetWithSearch(at(FIXTURE.clickVoisineB, clickOn(RUE_VOISINE_B)));
    if (!street.known) throw new Error(`street unknown: ${street.why}`);
    expect(street.value.segmentId).toBe(RUE_VOISINE_B);
    expect(street.reliability.reasonCodes).toContain('street_declared_breaks_tie');
  });

  it('une voie déclarée que le voisinage ne porte pas : le concours se fait comme avant, rien d’inventé', () => {
    for (const declared of [stopOn('way-not-fetched'), clickOn('way-not-fetched')]) {
      const { street } = selectDeliveryStreetWithSearch(at(FIXTURE.stop, declared));
      expect(street.known ? street.value.segmentId : street.why).toBe('below_confidence');
    }
  });

  it('une voie déclarée n’est retenue qu’accrochable : au-delà de `maxSnapM`, rien ne la relie plus au point', () => {
    // La Rue du Modèle est à 15 m de l'arrêt : accrochable à 30 m, plus à 10 m.
    const farWay = FIXTURE.stop.hood.ways.find((w) => w.name === "Rue du Modèle");
    if (farWay === undefined) throw new Error('fixture: Rue du Modèle missing');
    const within = selectDeliveryStreetWithSearch(at(FIXTURE.stop, stopOn(farWay.id))).street;
    expect(within.known ? within.value.segmentId : within.why).toBe(farWay.id);
    const beyond = selectDeliveryStreetWithSearch({ ...at(FIXTURE.stop, stopOn(farWay.id)), maxSnapM: 10 }).street;
    expect(beyond.known ? beyond.value.segmentId : beyond.why).toBe('below_confidence');
  });

  it('une voie déclarée absente, et le concours qui aboutit, le dit : `street_declared_not_found`', () => {
    const { street } = selectDeliveryStreetWithSearch({ ...at(FIXTURE.stop, stopOn('way-not-fetched')), ambiguityWindowM: 2 });
    if (!street.known) throw new Error(`street unknown: ${street.why}`);
    expect(street.value.segmentId).toBe(RUE_VOISINE_B);
    expect(street.reliability.reasonCodes).toEqual(['street_unambiguous', 'street_declared_not_found']);
  });
});

const AUXERRE = JSON.parse(
  readFileSync(new URL('./fixtures/auxerre-point-clique-s0.json', import.meta.url), 'utf8'),
) as { click: Place };
const AUXERRE_SPUR = '67002480';
const AUXERRE_PRIMARY = '419782065';

describe('Auxerre — un point cliqué 8 m dans l’antenne ne prend pas la place du concours', () => {
  it('rejoue eb9155f : sans voie déclarée, S0 garde la primaire, départagée sur le rang', () => {
    const { street } = selectDeliveryStreetWithSearch(at(AUXERRE.click));
    if (!street.known) throw new Error(`street unknown: ${street.why}`);
    expect(street.value.segmentId).toBe(AUXERRE_PRIMARY);
    expect(street.reliability.reasonCodes).toEqual(['street_resolved_by_lower_importance']);
  });

  it('le clic accroché à l’antenne : la primaire reste retenue, l’antenne écartée sur le rang, et le fait dit que le clic a été renversé', () => {
    const bare = selectDeliveryStreetWithSearch(at(AUXERRE.click)).street;
    const { street, search } = selectDeliveryStreetWithSearch(at(AUXERRE.click, clickOn(AUXERRE_SPUR)));
    if (!street.known || !bare.known) throw new Error('street unknown');
    // La même rue, les mêmes rivales, la même confiance qu'en eb9155f : rien du verdict ne bouge.
    expect(street.value).toEqual(bare.value);
    expect(street.reliability.confidence).toBe(bare.reliability.confidence);
    expect(street.value.alternativesConsidered).toEqual([
      expect.objectContaining({ segmentId: AUXERRE_SPUR, reason: 'lower_importance' }),
    ]);
    // Seule une note s'ajoute : le clic était ailleurs.
    expect(street.reliability.reasonCodes).toEqual(['street_resolved_by_lower_importance', 'street_declared_overruled']);
    const row = (id: string) => search.considered.find((c) => c.segmentId === id);
    expect(row(AUXERRE_PRIMARY)).toMatchObject({ outcome: 'retained', stage: 'retained' });
    expect(row(AUXERRE_SPUR)).toMatchObject({ outcome: 'compared', reason: 'lower_importance' });
  });

  it('un clic sur la voie que le concours retient ne change rien, pas même une note', () => {
    const bare = selectDeliveryStreetWithSearch(at(AUXERRE.click));
    const clicked = selectDeliveryStreetWithSearch(at(AUXERRE.click, clickOn(AUXERRE_PRIMARY)));
    expect(clicked).toEqual(bare);
  });

  it('la même voie déclarée par un arrêt du moteur, elle, est retenue sans concours : ce qui décide est la provenance', () => {
    const { street } = selectDeliveryStreetWithSearch(at(AUXERRE.click, stopOn(AUXERRE_SPUR)));
    expect(street.known && street.value.segmentId).toBe(AUXERRE_SPUR);
    expect(street.known && street.reliability.reasonCodes).toContain('street_declared_by_stop');
  });
});

// ------------------------------------------------ un clic départage une égalité, jamais une séparation --

/** Metres per degree of latitude on the sphere `geometry.ts` measures with. */
const LAT_M_PER_DEG = 111_194.93;
const O: GeoPoint = { lat: 46.37, lon: -0.29 };
const off = (eastM: number, northM: number): GeoPoint => ({
  lat: O.lat + northM / LAT_M_PER_DEG,
  lon: O.lon + eastM / (LAT_M_PER_DEG * Math.cos((O.lat * Math.PI) / 180)),
});
/** A straight way crossing the whole fetch: its tips are cuts, never ends of road. */
const through = (id: string, from: GeoPoint, to: GeoPoint, highway: string): RoadWay => ({
  id,
  source: 'osm-overpass',
  nodeIds: [`${id}-a`, `${id}-b`],
  geometry: [from, to],
  name: id,
  importance: null,
  declaredWidthM: null,
  laneCount: null,
  oneWay: 'no',
  isPrivate: false,
  limits: { maxWeightT: null, maxHeightM: null, maxWidthM: null, maxLengthM: null },
  tags: { highway },
});
/** Two residential streets 4 m either side of the point, level on every ground; a service lane 1 m away. */
const LEVEL: Place = {
  point: O,
  hood: {
    centre: O,
    radiusM: 50,
    nodes: [],
    ways: [
      through('north', off(-60, 4), off(60, 4), 'residential'),
      through('south', off(-60, -4), off(60, -4), 'residential'),
      through('lane', off(1, -60), off(1, 60), 'service'),
    ],
  },
};

describe('un clic départage une égalité, jamais une séparation', () => {
  it('sans clic : les deux résidentielles sont à égalité, S0 ne choisit pas', () => {
    const { street } = selectDeliveryStreetWithSearch(at(LEVEL));
    expect(street.known ? street.value.segmentId : street.why).toBe('below_confidence');
  });

  it('un clic sur l’une des deux : elle est retenue ; l’autre écartée comme à égalité, l’allée sur le rang', () => {
    const { street, search } = selectDeliveryStreetWithSearch(at(LEVEL, clickOn('north')));
    if (!street.known) throw new Error(`street unknown: ${street.why}`);
    expect(street.value.segmentId).toBe('north');
    expect(street.reliability.reasonCodes).toEqual(['street_declared_breaks_tie', 'street_resolved_by_lower_importance']);
    expect(street.value.alternativesConsidered.map((r) => [r.segmentId, r.reason])).toEqual([
      ['lane', 'lower_importance'],
      ['south', 'declared_stop_street'],
    ]);
    const row = (id: string) => search.considered.find((c) => c.segmentId === id);
    expect(row('north')).toMatchObject({ outcome: 'retained', stage: 'retained' });
    expect(row('south')).toMatchObject({ outcome: 'compared', reason: 'declared_stop_street' });
    expect(row('lane')).toMatchObject({ outcome: 'compared', reason: 'lower_importance' });
  });

  it('un clic sur l’allée, que les deux rues battent sur le rang : rien n’est départagé, S0 le dit', () => {
    const { street } = selectDeliveryStreetWithSearch(at(LEVEL, clickOn('lane')));
    expect(street.known ? street.value.segmentId : street.why).toBe('below_confidence');
  });
});
