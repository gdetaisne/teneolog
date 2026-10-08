/**
 * Le jury de Thairé, figé.
 *
 * la note de conception interne — trois jambes
 * du run `382e9a97`, relues avec le responsable produit sur la carte, et trois désaccords
 * entre ce que le chauffeur voit et ce que le moteur disait :
 *
 *  - **la bleue** (`disc:r2@285:in`) : « deux virages à quasi 90° de suite »
 *    dans le bourg — l'outil les avait EFFACÉS derrière un giratoire de 35 m
 *    de rayon qu'aucune voie `junction=roundabout` ne porte (défaut H) ;
 *  - **la sortie ouest** (`disc:r2@285:out`) : un « virage 128°, marge 0,35 m »
 *    qui fixait la pire marge des 100 plans du run, là où la route tourne de
 *    42° sur 60 m — une courbe, pas un carrefour (défaut J) ;
 * - **la grise** (`119513478@56:in`) : « aucun virage serré », dit le responsable produit,
 *    contre un « virage 61° » posé sur une courbe de plus de cent mètres de
 *    rayon (défaut J encore).
 *
 * Les fixtures sont les vraies polylignes servies par ce run, et l'extrait
 * Overpass local de la commune capturé une fois le 2026-09-12 — le test ne
 * dépend donc d'aucun tunnel.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { GeoPoint, RouteCandidate } from '@teneolog/domain';
import { haversineM, type RoadWay } from '@teneolog/topology';

import { collectCriticalPoints, type CollectedPoints, type CollectPointsParams } from '../src/collect.js';
import { detectTurns, type DetectedTurn, type TurnDetectionParams } from '../src/turns.js';
import { detectRoundabouts } from '../src/roundabouts.js';

const AT = '2026-09-12T00:00:00Z';

/** La policy de test (`config/policy.example.json`, `points.turns`). */
const TURNS: TurnDetectionParams = {
  windowM: 40,
  minDeflectionDeg: 45,
  bearingOffsetM: 10,
  mergeWithinM: 25,
  geometryConfidence: 0.7,
  curveIgnoreRadiusM: 60,
  junction: { nodeSnapM: 6, apexShare: 0.8 },
};
const ROUNDABOUTS = {
  ringSnapM: 8,
  ringMergeM: 40,
  geometryConfidence: 0.7,
  declaredWidthConfidence: 0.55,
};

function fixture(name: string): unknown {
  const path = fileURLToPath(new URL(`./fixtures/thaire/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8'));
}

interface OsmNode { readonly type: 'node'; readonly id: number; readonly lat: number; readonly lon: number }
interface OsmWay { readonly type: 'way'; readonly id: number; readonly nodes: readonly number[]; readonly tags: Record<string, string> }

/** L'extrait Overpass tel qu'il est enregistré, en voies du corridor. */
function corridorWays(): readonly RoadWay[] {
  const raw = fixture('jury-thaire-osm-corridor.json') as { elements: readonly (OsmNode | OsmWay)[] };
  const nodes = new Map<number, GeoPoint>();
  for (const element of raw.elements) {
    if (element.type === 'node') nodes.set(element.id, { lat: element.lat, lon: element.lon });
  }
  const ways: RoadWay[] = [];
  for (const element of raw.elements) {
    if (element.type !== 'way') continue;
    const geometry = element.nodes.map((id) => nodes.get(id)).filter((p): p is GeoPoint => p !== undefined);
    if (geometry.length !== element.nodes.length) continue;
    ways.push({
      id: String(element.id),
      source: 'osm-overpass',
      nodeIds: element.nodes.map(String),
      geometry,
      name: element.tags['name'] ?? null,
      importance: null,
      declaredWidthM: null,
      laneCount: null,
      oneWay: element.tags['oneway'] === 'yes' ? 'forward' : 'no',
      isPrivate: false,
      limits: { maxWeightT: null, maxHeightM: null, maxWidthM: null, maxLengthM: null },
      tags: element.tags,
    });
  }
  return ways;
}

/** Les jambes du run `382e9a97`, telles qu'elles ont été servies. */
function candidate(id: string): RouteCandidate {
  const raw = fixture('jury-thaire-routes-geo.json') as {
    data: { candidates: { value: readonly RouteCandidate[] } };
  };
  const found = raw.data.candidates.value.find((c) => c.id === id);
  if (found === undefined) throw new Error(`jambe absente de la fixture : ${id}`);
  return found;
}

/** Les polylignes du run `382e9a97`, par identifiant de jambe. */
function leg(id: string): readonly GeoPoint[] {
  return candidate(id).polyline;
}

const CORRIDOR = corridorWays();

interface Seen {
  readonly kind: 'junction' | 'curve';
  readonly deflectionDeg: number;
  readonly radiusM: number | null;
  readonly at: GeoPoint;
}

/** Ce que S4 pose sur une jambe, giratoires réels compris. */
function analyse(legId: string): {
  readonly turns: readonly Seen[];
  readonly roundabouts: readonly GeoPoint[];
} {
  const polyline = leg(legId);
  const rings = detectRoundabouts(polyline, CORRIDOR, ROUNDABOUTS, AT);
  const kept: DetectedTurn[] = detectTurns(polyline, CORRIDOR, TURNS, AT).filter(
    (turn) => !rings.some((ring) => haversineM(ring.at, turn.at) <= ring.suppressWithinM),
  );
  return {
    turns: kept.flatMap((turn) =>
      turn.geometry.known
        ? [{
            kind: turn.kind,
            deflectionDeg: turn.geometry.value.deflectionDeg,
            radiusM: turn.geometry.value.radiusM,
            at: turn.at,
          }]
        : [],
    ),
    roundabouts: rings.map((ring) => ring.at),
  };
}

function near(a: GeoPoint, lat: number, lon: number, withinM = 25): boolean {
  return haversineM(a, { lat, lon }) <= withinM;
}

describe('jury de Thairé — la bleue (disc:r2@285:in)', () => {
  const seen = analyse('disc:r2@285:in');

  it('pose les DEUX virages de carrefour du bourg, ~97° et ~105°', () => {
    const coinExemple = seen.turns.filter((t) => near(t.at, 46.0733, -0.9649));
    const coinVoisin = seen.turns.filter((t) => near(t.at, 46.0727, -0.9652));

    expect(coinExemple).toHaveLength(1);
    expect(coinExemple[0]?.kind).toBe('junction');
    expect(coinExemple[0]?.deflectionDeg).toBeGreaterThan(90);
    expect(coinExemple[0]?.deflectionDeg).toBeLessThan(105);

    expect(coinVoisin).toHaveLength(1);
    expect(coinVoisin[0]?.kind).toBe('junction');
    expect(coinVoisin[0]?.deflectionDeg).toBeGreaterThan(100);
    expect(coinVoisin[0]?.deflectionDeg).toBeLessThan(120);
  });

  it('et AUCUN giratoire dans le bourg : celui de 46.0730,-0.9651 était inventé', () => {
    // `ROUNDABOUT@46.0730,-0.9651`, « R = 35 m, balayage 196°, anneau roulable
    // non mesuré » — construit par la promotion de cluster sur la boucle de
    // sens uniques Voisine 23 / Voisine 29, sans une seule voie
    // `junction=roundabout` à 70 m. C'est lui qui effaçait les deux virages.
    expect(seen.roundabouts.filter((at) => near(at, 46.073, -0.9651, 200))).toHaveLength(0);
  });

  it('un virage de carrefour ne porte pas de rayon ; une courbe en porte toujours un', () => {
    for (const turn of seen.turns) {
      if (turn.kind === 'junction') expect(turn.radiusM).toBeNull();
      else expect(turn.radiusM).not.toBeNull();
    }
  });
});

describe('jury de Thairé — la sortie ouest (disc:r2@285:out)', () => {
  const seen = analyse('disc:r2@285:out');

  it('le « virage 128° » de 46.0733,-0.9669 n’est pas un carrefour : c’est une courbe', () => {
    // Au même endroit la polyligne tourne de 3° sur ±10 m, 21° sur ±20 m,
    // 42° sur ±40 m — l'Église → Voisine 10 est une courbe de 50 à 100 m
    // de rayon. Le 128° était une somme de caps sur une fenêtre trop large.
    const here = seen.turns.filter((t) => near(t.at, 46.0733, -0.9669, 40));
    expect(here.every((t) => t.kind === 'curve')).toBe(true);
    for (const turn of here) {
      expect(turn.deflectionDeg).toBeLessThan(80);
      expect(turn.radiusM ?? 0).toBeGreaterThan(40);
    }
  });

  it('et UN seul giratoire, le vrai : way 1080841173, à 46.0740,-0.9731', () => {
    expect(seen.roundabouts).toHaveLength(1);
    expect(near(seen.roundabouts[0] as GeoPoint, 46.074, -0.9731, 30)).toBe(true);
  });
});

describe('jury de Thairé — la grise (119513478@56:in)', () => {
  const seen = analyse('119513478@56:in');

  it('AUCUN virage de carrefour à 46.0737,-0.9613 — c’est une courbe', () => {
    // Le « virage 61° » de l'outil : 27° sur ±10 m, 36° sur ±20 m, 58° sur
    // ±80 m. Aucun balayage de carrefour n'a de sens là, et le nœud partagé
    // qui s'y trouve ne porte que 47 % de la déflexion.
    const here = seen.turns.filter((t) => near(t.at, 46.0737, -0.9613, 30));
    expect(here.every((t) => t.kind === 'curve')).toBe(true);
  });

  it('un seul virage de carrefour sur toute la jambe, ~57° à l’entrée du bourg', () => {
    const junctions = seen.turns.filter((t) => t.kind === 'junction');
    expect(junctions).toHaveLength(1);
    expect(near(junctions[0]?.at as GeoPoint, 46.0733, -0.9649)).toBe(true);
    expect(junctions[0]?.deflectionDeg).toBeGreaterThan(50);
    expect(junctions[0]?.deflectionDeg).toBeLessThan(65);
  });

  it('le même sommet, abordé par deux rues, n’est pas le même virage', () => {
    // 46.0733,-0.9649 : 57° depuis la grise, 98° depuis la bleue. C'est le
    // sens de « déflexion nette » — ce que le camion tourne, pas ce que le
    // carrefour mesure.
    const fromGrey = seen.turns.find((t) => near(t.at, 46.0733, -0.9649));
    const fromBlue = analyse('disc:r2@285:in').turns.find((t) => near(t.at, 46.0733, -0.9649));
    expect(fromGrey?.deflectionDeg ?? 0).toBeLessThan((fromBlue?.deflectionDeg ?? 0) - 30);
  });
});

/**
 * LE COIN EXEMPLE / VOISINE 23, VU DES DEUX JAMBES.
 *
 * Le test précédent le dit du DÉTECTEUR, qui lit une jambe à la fois et ne peut
 * pas se tromper. Celui-ci le dit du RELEVÉ complet — `collectCriticalPoints`,
 * là où les jambes se rencontrent — parce que c'est là que la géométrie était
 * partagée : la grise, première de la liste, imposait ses 57° et ses 3,0 m à
 * tout le monde, la vraie difficulté de la bleue (98° dans 5,2 m) disparaissait
 * et la grise portait une inconnue qu'elle ne conduit pas.
 */
describe('jury de Thairé — un lieu, deux jambes, deux géométries', () => {
  const GREY = '119513478@56:in';
  const BLUE = 'disc:r2@285:in';
  const CORNER = { lat: 46.0733, lon: -0.9649 };

  /** La policy de test, `points` (`config/policy.example.json`). */
  const PARAMS: CollectPointsParams = {
    turns: TURNS,
    roundabouts: ROUNDABOUTS,
    narrowMaxFreeM: 5,
    dedupeWithinM: 15,
    chainedWithinM: 40,
  };

  function collect(ids: readonly string[]): CollectedPoints {
    const candidates = ids.map(candidate);
    return collectCriticalPoints(
      {
        candidates,
        corridors: new Map(candidates.map((c) => [c.id, CORRIDOR])),
        stop: {
          // Le 12 Rue de l’Exemple, tel que le run l'a géocodé.
          at: { lat: 46.073482, lon: -0.965414 },
          width: { known: false, why: 'no_data' },
          slopePct: { known: false, why: 'no_data' },
          legal: {
            maxWeightT: { known: false, why: 'no_data' },
            maxHeightM: { known: false, why: 'no_data' },
            maxWidthM: { known: false, why: 'no_data' },
            maxLengthM: { known: false, why: 'no_data' },
            access: { known: false, why: 'no_data' },
            lowEmissionZone: { known: false, why: 'no_data' },
          },
          surface: { known: false, why: 'no_data' },
        },
        topology: {
          kind: 'THROUGH',
          continuity: { establishedBy: 'same_way', deviationDeg: 0, attributeBreak: false },
        },
        fetchedAt: AT,
      },
      PARAMS,
    );
  }

  /** La référence du virage à ce coin, telle que le relevé la porte. */
  function cornerRef(collected: CollectedPoints): string {
    const found = collected.points.find(
      (p) => p.type === 'TURN' && haversineM(p.at, CORNER) <= 25,
    );
    if (found === undefined) throw new Error('le coin Exemple / Voisine 23 n’est pas dans le relevé');
    return found.ref;
  }

  /** Ce que CETTE jambe a mesuré à ce point : l'angle et la largeur. */
  function asSeenBy(
    collected: CollectedPoints,
    candidateId: string,
    ref: string,
  ): { readonly deflectionDeg: number; readonly freeM: number; readonly kind: string } {
    const geometry = collected.geometryByCandidate.get(candidateId)?.get(ref);
    if (geometry === undefined || !geometry.known) throw new Error(`pas de géométrie pour ${candidateId}`);
    const value = geometry.value;
    if (value.type !== 'TURN') throw new Error('ce point n’est pas un virage');
    const width = value.geometry.approachWidth;
    if (!width.known) throw new Error(`largeur inconnue pour ${candidateId}`);
    return {
      deflectionDeg: value.geometry.deflectionDeg,
      freeM: width.value.freeM,
      kind: value.geometry.kind,
    };
  }

  it('57° dans 3,0 m depuis la grise, 98° dans 5,2 m depuis la bleue', () => {
    const collected = collect([GREY, BLUE]);
    const ref = cornerRef(collected);

    const grey = asSeenBy(collected, GREY, ref);
    expect(grey.kind).toBe('junction');
    expect(grey.deflectionDeg).toBeGreaterThan(50);
    expect(grey.deflectionDeg).toBeLessThan(65);
    // La Rue Voisine 14, d'où la grise arrive — 3,0 m BD TOPO.
    expect(grey.freeM).toBeCloseTo(3.0, 3);

    const blue = asSeenBy(collected, BLUE, ref);
    expect(blue.kind).toBe('junction');
    expect(blue.deflectionDeg).toBeGreaterThan(90);
    expect(blue.deflectionDeg).toBeLessThan(105);
    // Exemple / Voisine 23 — 5,2 m. C'est LÀ qu'est la difficulté de la
    // bleue : 98° exigent 5,3 m, il en reste 5,2 — marge −0,1 m.
    expect(blue.freeM).toBeCloseTo(5.2, 3);
  });

  it('l’ordre des jambes ne change aucun de ces nombres', () => {
    const straight = collect([GREY, BLUE]);
    const flipped = collect([BLUE, GREY]);
    // La référence est la même dans les deux sens : c'est le LIEU qui la fixe,
    // pas le run ni la jambe (architecture §3.3).
    expect(cornerRef(flipped)).toBe(cornerRef(straight));
    for (const id of [GREY, BLUE]) {
      expect(asSeenBy(flipped, id, cornerRef(flipped))).toEqual(
        asSeenBy(straight, id, cornerRef(straight)),
      );
    }
  });

  it('une seule référence, donc une seule clé de jugement pour les deux jambes', () => {
    const collected = collect([GREY, BLUE]);
    const ref = cornerRef(collected);
    // Une seule entrée dans `points[]` : un lieu, une identité.
    expect(collected.points.filter((p) => p.type === 'TURN' && haversineM(p.at, CORNER) <= 25))
      .toHaveLength(1);
    expect(collected.byCandidate.get(GREY)).toContain(ref);
    expect(collected.byCandidate.get(BLUE)).toContain(ref);
    // Les deux jambes sont entrantes : `judgementKeyOf` (l'API (hors instantané))
    // en tire `entry:${ref}` de part et d'autre — une question, une réponse,
    // valable pour les deux itinéraires.
    expect(candidate(GREY).direction).toBe('in');
    expect(candidate(BLUE).direction).toBe('in');
  });

  it('test d’or : la géométrie partagée de `points[]` est celle du premier trouveur, et rien d’autre ne la lit', () => {
    // `points[].geometry` reste la première mesure rencontrée — c'est ce que
    // lisent les contrôles S4, le tronc commun de la phase 2 et le snapshot du
    // run. Avec la grise en tête, c'est la sienne ; la bleue en tête, c'est
    // celle de la bleue. Ce champ EST dépendant de l'ordre, par construction, et
    // c'est pourquoi S5 lit `geometryByCandidate` (collect.ts).
    const greyFirst = collect([GREY, BLUE]);
    const blueFirst = collect([BLUE, GREY]);
    const shared = (c: CollectedPoints): number => {
      const point = c.points.find((p) => p.ref === cornerRef(c));
      if (point === undefined || !point.geometry.known) throw new Error('point absent');
      const value = point.geometry.value;
      if (value.type !== 'TURN') throw new Error('pas un virage');
      return value.geometry.deflectionDeg;
    };
    expect(shared(greyFirst)).toBeLessThan(65);
    expect(shared(blueFirst)).toBeGreaterThan(90);
  });
});
