/**
 * 9 Rue Témoin, 92110 Clichy, sur le voisinage OSM que S1 a lu
 * (`fixtures/rue-temoin-clichy.json`, 80 m, le premier barreau de la prod).
 *
 * Le responsable produit : « étrange... ce n'est pas une impasse ». Ce que les données disent :
 * l'arrêt est sur le bout sud de la Rue Témoin (way 173317907), à 18,6 m au sud
 * du carrefour avec la « Rue témoin » (way 711050967, vers la Rue Voisine SV) ;
 * ce bout finit 53 m plus loin au nœud 1841624140, que seul touche un trottoir
 * (footway 715780700) — celui qui mène à la place piétonne Voisine JC. La
 * BD TOPO dessine encore la chaussée d'avant la place (TRONROUT…518073), que
 * l'orthophoto du 22/08/2024 ne montre plus. L'impasse est donc bien lue.
 *
 * Le défaut était ailleurs : les deux places piétonnes (ways 117624157 et
 * 225761835, highway=pedestrian, area=yes) étaient servies comme options de
 * demi-tour « boucle », Ø 30,5 m mesuré, sol public — une surface où le
 * planificateur ne manœuvre pas.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { classifyTerminal } from '../src/dead-end.js';
import { haversineM } from '../src/geometry.js';
import { isNonDrivableAreaWay } from '../src/non-drivable-area.js';
import type { RoadNeighbourhood } from '../src/ports.js';
import { assessTopology } from '../src/topology-assessment.js';

const hood = JSON.parse(
  readFileSync(new URL('./fixtures/rue-temoin-clichy.json', import.meta.url), 'utf8'),
) as RoadNeighbourhood;

const STOP = { lat: 48.897633, lon: 2.34649 };
const RUE_TEMOIN = '173317907';
const SQUARE_TIP = '1841624140';
const JUNCTION = '249494038';

const assessed = assessTopology({
  neighbourhood: hood,
  surfaces: [],
  deliveryWayId: RUE_TEMOIN,
  deliveryPoint: STOP,
  turnaroundSearchRadiusM: 120,
  maxMouthDepth: 2,
  maxDeviationDeg: 40,
  barrierSnapM: 6,
  measurement: {
    defaultTurningCircleDiameterM: null,
    fallbackCarriagewayWidthM: null,
    loopClosureToleranceM: 3,
    observedAt: '2026-09-28T00:00:00Z',
  },
});

describe('9 Rue Témoin, Clichy', () => {
  it('lit une impasse : le bout sud ne touche qu’un trottoir, le nord rejoint la Rue Voisine 8M', () => {
    const tip = hood.nodes.find((n) => n.id === SQUARE_TIP);
    const users = tip?.wayIds.map((id) => hood.ways.find((w) => w.id === id)?.tags['highway']);
    expect(users?.sort()).toEqual(['footway', 'residential']);
    expect(classifyTerminal({ neighbourhood: hood, deliveryWayId: RUE_TEMOIN, deliveryPoint: STOP }).topology.kind).toBe(
      'DEAD_END',
    );
  });

  it('pose la bouche au carrefour de la Rue témoin, à une vingtaine de mètres de l’arrêt', () => {
    expect(assessed.handoff.known).toBe(true);
    if (!assessed.handoff.known) return;
    const junction = hood.nodes.find((n) => n.id === JUNCTION)!;
    expect(haversineM(assessed.handoff.value.point, junction.at)).toBeLessThan(0.5);
  });

  it('ne propose aucune place piétonne comme boucle de demi-tour', () => {
    expect(assessed.egressCandidates.known).toBe(true);
    if (!assessed.egressCandidates.known) return;
    // Dans les 80 m lus, seule la place Voisine JC est là (la prod servait aussi la 225761835,
    // lue plus large) : elle est bien dans le voisinage — c'est le tri qui l'écarte, pas la lecture.
    const square = hood.ways.find((w) => w.id === '117624157');
    expect([square?.tags['highway'], square?.tags['area']]).toEqual(['pedestrian', 'yes']);
    expect(assessed.egressCandidates.value.map((c) => c.id)).not.toContain('way:117624157');
  });
});

describe('isNonDrivableAreaWay', () => {
  it('une place piétonne en aire, oui ; une rue piétonne (sans area=yes), non', () => {
    expect(isNonDrivableAreaWay({ highway: 'pedestrian', area: 'yes' })).toBe(true);
    expect(isNonDrivableAreaWay({ highway: 'footway', area: 'yes' })).toBe(true);
    expect(isNonDrivableAreaWay({ highway: 'pedestrian' })).toBe(false);
    expect(isNonDrivableAreaWay({ highway: 'residential', area: 'yes' })).toBe(false);
    expect(isNonDrivableAreaWay({ leisure: 'park' })).toBe(true);
  });
});
