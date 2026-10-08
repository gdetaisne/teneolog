/**
 * S3 — l'ancre par LARGEUR, calculée EN SILENCE.
 *
 * la note de conception interne : Le responsable produit a tranché que le réseau sûr
 * est une **largeur** — celle de la BD TOPO, greffée sur les corridors depuis
 * c4a5549 — et que la classe OSM n'est qu'un repli là où aucune largeur n'est
 * connue. À Thairé le rayon de 2 km compte 83 `tertiary` et 13 `unclassified`
 * et pas une seule primaire : la classe n'y dit rien de la sûreté, la largeur
 * si (252 tronçons BD TOPO sur 298 en portent une).
 *
 * L'ancre d'une approche est donc, en remontant du point de livraison vers
 * l'extérieur, **le premier point d'où toutes les voies traversées jusqu'à
 * `radiusM` sont suffisantes** pour ce camion (ou muettes sur leur largeur
 * mais structurantes). Entre ce point et le point de livraison se trouve le
 * réseau que S4 doit contrôler ; au-delà, la route est générique.
 *
 * Trois choses que ce module n'est pas, et ne doit jamais devenir :
 *
 *  - il n'est pas une règle d'ancrage. Rien ici ne rend un `Gate`, rien ici
 *    n'atteint `buildRouteCandidates`. Le pipeline le pose à côté de R0 et
 * garde les deux, jusqu'à l'A/B.
 *  - il n'invente aucun seuil. « Large sans doute » est `comfortableWidthM`
 *    de `@teneolog/projection` — la largeur du camion, la garde latérale et
 *    la marge de confort de la policy, c'est-à-dire la borne au-dessus de
 *    laquelle `widthFit` rend OK plutôt que HUMAIN. Le seuil arrive par
 *    `requiredWidthM` ; ce fichier ne connaît pas de camion.
 *  - il ne fait jamais échouer un run. Un corridor muet coûte une ancre,
 *    nommée `corridor_unavailable`, et le reste continue.
 *
 * Le coût est celui des corridors (0,8 s la jambe, §1.3) : un fetch par
 * approche mesurée, plafonné par `gates.byWidth.maxApproaches`, et **une seule
 * dérivation de largeur par voie et par corridor** — les approches se
 * recouvrent près du point de livraison, et `waysLoaded` compte les voies
 * distinctes qu'elles se partagent. Le mémo, lui, ne se partage PAS : la
 * largeur greffée dépend de l'emprise du corridor qui l'a lue.
 */
import type {
  ApproachWidthRun,
  DiscoveredApproach,
  DiscoveryByWidth,
  GateByWidth,
  GateByWidthSource,
  GeoPoint,
} from '@teneolog/domain';
import { bearingDeg, haversineM, type RoadWay } from '@teneolog/topology';

import { nearestDrivableWay, samplePolyline, wayWidthFact } from './annotate.js';
import { mapWithConcurrency } from './concurrency.js';
import type { DraftApproach } from './discovery.js';
import { isStructuringWay } from './gates.js';
import type { CorridorPort } from './ports.js';

export interface GateByWidthInput {
  readonly stop: GeoPoint;
  /** Les approches ENTRANTES gardées par la découverte, dans son ordre. */
  readonly approachesIn: readonly DraftApproach[];
  /** Les SORTANTES : entrer et sortir sont deux choix indépendants. */
  readonly approachesOut: readonly DraftApproach[];
  /** « Large sans doute » pour ce camion — `comfortableWidthM`, jamais recalculé ici. */
  readonly requiredWidthM: number;
  /** Le camion pour lequel le seuil vaut, porté jusqu'à la vue. */
  readonly truckId: string;
  /** Jusqu'où l'exigence porte : le cercle de R0 (`gates.searchRadiusM`). */
  readonly radiusM: number;
  /** Marge du corridor — la même que celle des itinéraires. */
  readonly corridorMarginM: number;
  readonly sampleStepM: number;
  readonly snapM: number;
  readonly laneWidthM: number;
  /** Plafond d'approches mesurées, entrées et sorties confondues. */
  readonly maxApproaches: number;
  readonly maxConcurrent: number;
  readonly fetchedAt: string;
}

export interface GateByWidthResult {
  readonly approachesIn: readonly DraftApproach[];
  readonly approachesOut: readonly DraftApproach[];
  readonly byWidth: DiscoveryByWidth;
}

/**
 * Poser une ancre par largeur sur chaque approche gardée.
 *
 * Le plafond s'applique aux deux directions **en les alternant** (une entrée,
 * une sortie, une entrée…) : prendre toutes les entrées d'abord ferait, à
 * plafond serré, un relevé qui ne dit plus rien des sorties, alors que c'est
 * justement leur indépendance que a ouverte.
 */
export async function placeGatesByWidth(
  input: GateByWidthInput,
  corridor: CorridorPort,
): Promise<GateByWidthResult> {
  const startedAt = Date.now();

  interface Slot {
    readonly direction: 'in' | 'out';
    readonly index: number;
    readonly approach: DraftApproach;
  }
  const queue: Slot[] = [];
  const longest = Math.max(input.approachesIn.length, input.approachesOut.length);
  for (let i = 0; i < longest; i += 1) {
    const inbound = input.approachesIn[i];
    if (inbound !== undefined) queue.push({ direction: 'in', index: i, approach: inbound });
    const outbound = input.approachesOut[i];
    if (outbound !== undefined) queue.push({ direction: 'out', index: i, approach: outbound });
  }
  const measured = queue.slice(0, Math.max(0, input.maxApproaches));
  const skipped = queue.length - measured.length;

  // Combien de voies distinctes les approches se partagent — le recouvrement,
  // qui est une mesure et non un cache (le cache, lui, est par
  // corridor, voir plus bas).
  const wayIdsSeen = new Set<string>();
  const wayIdsWithBdtopoWidth = new Set<string>();

  let overpassCalls = 0;
  let bdtopoQueries = 0;

  const placed = await mapWithConcurrency(measured, Math.max(1, input.maxConcurrent), async (slot) => {
    const outward = outwardLine(slot.approach, input.radiusM);
    if (outward.length < 2) {
      return { slot, profile: [], gate: emptyGate(input.requiredWidthM, 'no_geometry') };
    }

    let ways: readonly RoadWay[];
    try {
      ways = await corridor.fetchCorridor(outward, input.corridorMarginM);
      overpassCalls += 1;
    } catch {
      // Un corridor muet coûte une ancre, jamais le run — la même règle que
      // la découverte s'impose à son routeur.
      overpassCalls += 1;
      return { slot, profile: [], gate: emptyGate(input.requiredWidthM, 'corridor_unavailable') };
    }
    // UNE LARGEUR APPARTIENT AU COUPLE (VOIE, CORRIDOR), JAMAIS À LA VOIE
    // SEULE. `graftDeclaredWidth` ne juge une voie que sur ses
    // échantillons DANS l'emprise du corridor (`corridorExtent`), et une voie
    // OSM un peu longue croise plusieurs tronçons BD TOPO : deux corridors qui
    // en voient deux bouts différents lui greffent deux largeurs différentes,
    // chacune vraie là où elle a été lue. Le mémo qui vivait ici était partagé
    // par tout le run et gardait la PREMIÈRE valeur vue — à Thairé, la voie
    // 755175098 était créditée 5,2 m par le profil quand la BD TOPO lui donne
    // 3,0 m sur l'approche mesurée (A/B §4). Un profil qui surestime
    // une largeur pousse l'ancre trop près du point de livraison et fait taire,
    // en silence, les questions d'en amont.
    //
    // Le mémo est donc celui de CETTE approche, et il est accroché à l'OBJET
    // `RoadWay` que ce corridor a rendu : deux corridors ne se mélangent plus,
    // et un identifiant qui reviendrait deux fois dans le même corridor ne se
    // confond pas non plus. Ce qu'il économise reste entier — les échantillons
    // d'une même approche retombent sans cesse sur la même voie.
    //
    // Ce qui reste à dire, et que ceci ne corrige pas : dans un corridor, la
    // greffe rend UN nombre pour toute la voie — le plus étroit des tronçons
    // BD TOPO qui ont gagné des voix. Une voie de 800 m large à un bout et
    // étroite à l'autre est donc encore lue d'un seul chiffre par corridor.
    const widths = new Map<RoadWay, WayWidth>();
    const widthOf = (way: RoadWay): WayWidth => {
      const held = widths.get(way);
      if (held !== undefined) return held;
      const fresh = readWidth(way, input.laneWidthM, input.fetchedAt);
      widths.set(way, fresh);
      wayIdsSeen.add(way.id);
      if (fresh.source === 'bdtopo') wayIdsWithBdtopoWidth.add(way.id);
      return fresh;
    };

    // Sans court-circuit : `waysLoaded` doit compter les voies du corridor, pas
    // celles qu'un `some` a traversées avant de trouver son compte.
    let touchedBdtopo = false;
    for (const way of ways) if (widthOf(way).source === 'bdtopo') touchedBdtopo = true;
    if (touchedBdtopo) bdtopoQueries += 1;

    const profile = profileOf({
      outward,
      corridor: ways,
      widthOf,
      radiusM: input.radiusM,
      sampleStepM: input.sampleStepM,
      snapM: input.snapM,
    });
    return {
      slot,
      profile,
      gate: anchorFromProfile(profile, input.stop, input.requiredWidthM),
    };
  });

  interface Placed {
    readonly profile: readonly ApproachWidthRun[];
    readonly gate: GateByWidth;
  }
  const gatesIn = new Map<number, Placed>();
  const gatesOut = new Map<number, Placed>();
  for (const { slot, profile, gate } of placed) {
    (slot.direction === 'in' ? gatesIn : gatesOut).set(slot.index, { profile, gate });
  }

  const join = (approach: DraftApproach, held: Placed | undefined): DraftApproach => ({
    ...approach,
    widthProfile: held?.profile ?? null,
    gateByWidth: held?.gate ?? null,
  });

  return {
    approachesIn: input.approachesIn.map((approach, i) => join(approach, gatesIn.get(i))),
    approachesOut: input.approachesOut.map((approach, i) => join(approach, gatesOut.get(i))),
    byWidth: {
      computedFor: measured.length,
      skipped,
      cost: { overpassCalls, bdtopoQueries, ms: Date.now() - startedAt },
      waysLoaded: wayIdsSeen.size,
      waysWithBdtopoWidth: wayIdsWithBdtopoWidth.size,
      requiredWidthM: input.requiredWidthM,
      truckId: input.truckId,
    },
  };
}

// -------------------------------------------------- le profil, sans camion --

export interface WidthProfileInput {
  /** La ligne orientée DU point de livraison VERS l'extérieur, déjà taillée. */
  readonly outward: readonly GeoPoint[];
  readonly corridor: readonly RoadWay[];
  readonly widthOf: (way: RoadWay) => WayWidth;
  readonly radiusM: number;
  readonly sampleStepM: number;
  readonly snapM: number;
}

/**
 * Les voies traversées par une approche, du point de livraison vers
 * l'extérieur — **sans aucun camion**.
 *
 * C'est la moitié chère et la moitié agnostique : un échantillon tous les
 * `sampleStepM`, accroché à la voie roulable la plus proche à moins de `snapM`
 * (le même accrochage que le corridor S4), puis les échantillons consécutifs
 * sur la même voie fusionnés en un tronçon. Dans un tronçon la voie, sa largeur
 * et sa classe ne changent pas : l'ancre ne peut donc tomber qu'au DÉBUT d'un
 * tronçon, et fusionner ne perd rien tout en rendant le profil lisible.
 *
 * Un échantillon que rien n'accroche donne un tronçon à `wayId: null`. Ce n'est
 * pas un trou dans le relevé, c'est le relevé : de la route qu'on ne connaît
 * pas est de la route à contrôler.
 */
export function profileOf(input: WidthProfileInput): readonly ApproachWidthRun[] {
  const runs: ApproachWidthRun[] = [];
  let current: { -readonly [K in keyof ApproachWidthRun]: ApproachWidthRun[K] } | null = null;

  for (const sample of samplePolyline(input.outward, input.sampleStepM)) {
    if (sample.alongM > input.radiusM) break;
    const way = nearestDrivableWay(sample.point, input.corridor, input.snapM);
    const width = way === null ? null : input.widthOf(way);
    const wayId = way?.id ?? null;
    if (current !== null && current.wayId === wayId) {
      current.toM = sample.alongM;
      continue;
    }
    current = {
      fromM: sample.alongM,
      toM: sample.alongM,
      at: sample.point,
      wayId,
      wayName: way?.name ?? null,
      highway: way?.tags['highway'] ?? null,
      widthM: width?.widthM ?? null,
      widthSource: width?.source ?? null,
      structuring: way !== null && isStructuringWay(way),
    };
    runs.push(current);
  }
  return runs;
}

// ------------------------------------------------- l'ancre, pour un camion --

/**
 * La règle, en une phrase : **l'ancre est le premier point d'où tout ce qui
 * reste, jusqu'au bout du profil, est acceptable.**
 *
 * « Acceptable » vaut pour deux choses et deux seulement : une largeur connue
 * au moins égale au seuil ; une largeur inconnue sur une voie STRUCTURANTE
 * (le repli par classe, quand OSM ne déclare rien et que la BD TOPO est
 * muette). Rien d'autre. Un tronçon qu'aucune voie roulable n'a accroché, comme
 * une voie locale muette, n'est pas acceptable : ce qu'on ne sait pas, on le
 * contrôle.
 *
 * Elle se calcule en remontant depuis le dernier tronçon : on recule tant que
 * c'est acceptable, et l'ancre est le début du tronçon où l'on s'arrête. C'est
 * ce qui interdit à un tronçon large isolé entre deux étroits de faire une
 * ancre — il ne tient pas jusqu'au bout.
 *
 * PURE, et c'est tout l'intérêt : rejouer un autre camion ne redemande rien au
 * réseau, exactement comme `projectTruck` rejoue un verdict sur des faits déjà
 * établis.
 */
export function anchorFromProfile(
  profile: readonly ApproachWidthRun[],
  stop: GeoPoint,
  requiredWidthM: number,
): GateByWidth {
  if (profile.length === 0) return emptyGate(requiredWidthM, 'no_geometry');

  const acceptable = (run: ApproachWidthRun): boolean =>
    run.wayId === null ? false : run.widthM === null ? run.structuring : run.widthM >= requiredWidthM;
  const narrow = (run: ApproachWidthRun): boolean =>
    run.widthM !== null && run.widthM < requiredWidthM;

  const first = profile.find(narrow) ?? null;
  const firstNarrowSegment =
    first === null || first.wayId === null || first.widthM === null
      ? null
      : { wayId: first.wayId, widthM: first.widthM, atM: first.fromM };

  let i = profile.length - 1;
  if (!acceptable(profile[i] as ApproachWidthRun)) {
    return { ...emptyGate(requiredWidthM, 'never_wide_enough'), firstNarrowSegment };
  }
  while (i > 0 && acceptable(profile[i - 1] as ApproachWidthRun)) i -= 1;

  const anchor = profile[i] as ApproachWidthRun;
  const basis: GateByWidth['basis'] = anchor.widthM === null ? 'class' : 'width';
  const widthSource: GateByWidthSource =
    anchor.widthM === null ? 'class_fallback' : (anchor.widthSource ?? 'osm');

  return {
    point: anchor.at,
    azimuthDeg: bearingDeg(stop, anchor.at),
    distanceFromDeliveryM: anchor.fromM,
    wayId: anchor.wayId,
    wayName: anchor.wayName,
    highway: anchor.highway,
    widthM: anchor.widthM,
    widthSource,
    requiredWidthM,
    basis,
    firstNarrowSegment,
    reason:
      basis === 'class'
        ? 'class_fallback'
        : i === 0
          ? 'wide_from_the_delivery_point'
          : 'first_wide_beyond_the_narrow',
  };
}

/** Ce qu'on retient d'une voie : sa largeur et d'où elle vient. Dérivé une fois. */
export interface WayWidth {
  readonly widthM: number | null;
  /** `null` quand la voie ne déclare aucune largeur, ni elle-même ni par greffe. */
  readonly source: 'bdtopo' | 'osm' | null;
}

/**
 * La largeur d'une voie, lue avec l'échelle du corridor (`wayWidthFact`).
 *
 * La greffe se reconnaît au code `declared_width_grafted` que pose
 * `wayWidthFact` : c'est OSM qui a dessiné la route, mais le nombre est celui
 * de la BD TOPO, et la provenance doit le dire.
 */
function readWidth(way: RoadWay, laneWidthM: number, fetchedAt: string): WayWidth {
  const at = way.geometry[0] ?? { lat: 0, lon: 0 };
  const fact = wayWidthFact(way, at, laneWidthM, fetchedAt);
  if (!fact.known) return { widthM: null, source: null };
  return {
    widthM: fact.value.freeM,
    source: fact.reliability.reasonCodes.includes('declared_width_grafted') ? 'bdtopo' : 'osm',
  };
}

/** Une ancre qu'on a cherchée et pas trouvée — ce qui n'est pas « pas cherchée ». */
function emptyGate(requiredWidthM: number, reason: string): GateByWidth {
  return {
    point: null,
    azimuthDeg: null,
    distanceFromDeliveryM: null,
    wayId: null,
    wayName: null,
    highway: null,
    widthM: null,
    widthSource: 'unknown',
    requiredWidthM,
    basis: 'none',
    firstNarrowSegment: null,
    reason,
  };
}

/**
 * La jambe orientée du point de livraison vers l'extérieur, taillée à
 * `radiusM`.
 *
 * Une entrante est routée `origine → arrêt` : on la retourne. Une sortante est
 * déjà dans le bon sens. C'est le même miroir que le dédoublonnage de la
 * découverte (`keepLegs`), et pour la même raison : une seule règle, lue des
 * deux bouts.
 *
 * Tailler n'est pas cosmétique : l'exigence ne porte que jusqu'à `radiusM`, et
 * demander un corridor sur 2 400 m pour n'en lire que 2 000 serait 20 % de
 * requête Overpass pour rien.
 */
export function outwardLine(
  approach: Pick<DiscoveredApproach, 'direction' | 'polyline'>,
  radiusM: number,
): readonly GeoPoint[] {
  const line = approach.direction === 'in' ? [...approach.polyline].reverse() : approach.polyline;
  const out: GeoPoint[] = [];
  let travelled = 0;
  for (const [i, point] of line.entries()) {
    out.push(point);
    const next = line[i + 1];
    if (next === undefined) break;
    travelled += haversineM(point, next);
    if (travelled >= radiusM) {
      out.push(next);
      break;
    }
  }
  return out;
}
