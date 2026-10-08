/**
 * S2 — everything measured at the stop, agnostically, from what the data
 * layer can feed TODAY.
 *
 * Width comes from the street's declared attribute (basis 'declared'); the
 * D10 imagery measurement supersedes it when present, by appending a stronger
 * fact — never by overwriting this one. Slope is measured along the delivery
 * axis (Google Elevation) when the caller supplies it; urban/rural stays an
 * honest unknown until its adapter exists. This module refuses to fabricate
 * what nothing measured, which is the whole point of the Fact envelope.
 */
import type {
  Fact,
  GeoPoint,
  LowEmissionZone,
  PhysicalBarrier,
  StopConstraints,
  SurfaceContext,
  Width,
} from '@teneolog/domain';
import type { RoadWay } from '@teneolog/topology';
import { closestPointOnPolyline } from '@teneolog/topology';

import { mergeLegalBands } from './legal-bands.js';

export interface StopConstraintsInput {
  readonly at: GeoPoint;
  /** Every description of the delivery street — typically one BDTOPO, one OSM. */
  readonly descriptions: readonly RoadWay[];
  readonly fetchedAt: string;
  /** Confidence published for a declared (unverified) width. Policy, not code. */
  readonly declaredWidthConfidence: number;
  /**
   * A width measured on imagery (D10), when the imagery port ran. The
   * PUBLISHED width is whichever known fact carries the higher confidence —
   * a low-confidence measurement (the core's own signal that its window is
   * doubtful, e.g. the Auxerre spur where the frame caught the N77 next
   * door) must not displace a solid declared attribute, and a failed
   * measurement must never delete weaker evidence. When only one of the two
   * is known, it stands whatever its confidence: doubtful beats silent.
   */
  readonly measuredWidth?: Fact<Width>;
  /**
   * The low-emission zone in force at the stop, when the caller looked it up.
   * Omitted, it stays an explicit unknown — which is what it must render as.
   */
  readonly lowEmissionZone?: Fact<LowEmissionZone | null>;
  /**
   * Grade of the delivery street at the stop, measured along the road axis.
   * Omitted or unknown → the chip says so; never a made-up 0 %.
   */
  readonly measuredSlope?: Fact<number>;
  /**
   * les barrières physiques relevées par S1 sur la rue
   * retenue (`TopologyAssessment.barriers`). Elles ne sont pas MESURÉES ici :
   * elles sont portées jusqu'à l'arrêt, parce que c'est l'arrêt qu'elles
   * ferment et que rien ne les lisait. Omises, elles restent une absence.
   */
  readonly barriers?: readonly Fact<PhysicalBarrier>[];
}

export function assembleStopConstraints(input: StopConstraintsInput): StopConstraints {
  const declared = declaredWidth(input);
  const width = pickHighestConfidence([input.measuredWidth, declared]);
  const legal = mergeLegalBands({ descriptions: input.descriptions, fetchedAt: input.fetchedAt });
  return {
    at: input.at,
    width,
    slopePct: input.measuredSlope ?? { known: false, why: 'no_data' },
    legal:
      input.lowEmissionZone === undefined
        ? legal
        : { ...legal, lowEmissionZone: input.lowEmissionZone },
    surface: surfaceContext(),
    ...(input.barriers === undefined ? {} : { barriers: input.barriers }),
  };
}

/**
 * The narrowest declared width across descriptions, measured where the stop
 * projects onto that street. Narrowest for the same reason legal limits take
 * the smallest: two sources disagreeing about a width is a reason for caution,
 * not an invitation to average.
 */
function declaredWidth(input: StopConstraintsInput): Fact<Width> {
  const stated: { readonly way: RoadWay; readonly widthM: number }[] = [];
  for (const way of input.descriptions) {
    if (way.declaredWidthM !== null) stated.push({ way, widthM: way.declaredWidthM });
  }
  if (stated.length === 0) return { known: false, why: 'no_data' };

  const narrowest = stated.reduce((a, b) => (b.widthM < a.widthM ? b : a));
  const projection = closestPointOnPolyline(narrowest.way.geometry, input.at);

  const value: Width = {
    // A declared width is the carriageway attribute: no obstacle information,
    // so free and structural coincide until imagery says otherwise.
    freeM: narrowest.widthM,
    structuralM: narrowest.widthM,
    measuredAt: projection?.point ?? input.at,
    offsetFromAnchorM: projection?.distanceM ?? 0,
  };

  // A width the way did not state itself was grafted from another source
  // (`graftDeclaredWidth`). Publishing it under the way's own source would
  // credit OSM for a BD TOPO number — the same confusion between what was
  // stated and what was borrowed that cut out of the imagery path.
  const grafted = narrowest.way.attributed?.declaredWidthM;
  const reasonCodes =
    new Set(stated.map((s) => s.widthM)).size > 1
      ? ['declared_width_sources_disagree']
      : ['declared_width'];

  return {
    known: true,
    value,
    provenance: {
      source: grafted?.source ?? narrowest.way.source,
      method: 'declared-width-narrowest',
      fetchedAt: input.fetchedAt,
    },
    reliability: {
      confidence: input.declaredWidthConfidence,
      basis: 'declared',
      reasonCodes: grafted === undefined ? reasonCodes : [...reasonCodes, 'declared_width_grafted'],
    },
  };
}

function pickHighestConfidence(candidates: ReadonlyArray<Fact<Width> | undefined>): Fact<Width> {
  let best: Fact<Width> | null = null;
  for (const candidate of candidates) {
    if (candidate === undefined || !candidate.known) continue;
    if (best === null || !best.known || candidate.reliability.confidence > best.reliability.confidence) {
      best = candidate;
    }
  }
  if (best !== null) return best;
  return candidates.find((c): c is Fact<Width> => c !== undefined) ?? { known: false, why: 'no_data' };
}

function surfaceContext(): Fact<SurfaceContext> {
  // Urban/rural needs the INSEE density adapter; parked-vehicle evidence needs
  // imagery. Nothing measured it yet, and the consumer must know that.
  //
  // la part bâtie de la BD TOPO sait désormais répondre à la
  // PREMIÈRE des trois questions — mais elle est mesurée DERRIÈRE la réponse
  // (`compat.ts`, bloc asynchrone), donc pas ici, où S2 s'assemble sur le
  // chemin critique. L'appelant qui a la mesure reconstruit le fait avec
  // `surfaceFromSetting()` ci-dessous. Tant que personne ne le fait, ce fait
  // reste exactement ce qu'il était : un inconnu déclaré.
  return { known: false, why: 'no_data' };
}

/** Ce que le cadre bâti mesuré dit du contexte de surface. */
export interface MeasuredSetting {
  /** Le vocabulaire du chargeur : dense · urbain · bourg · periurbain · rural · inconnu. */
  readonly kind: string;
  readonly builtRatio: number | null;
  readonly densityRadiusM: number;
  readonly fetchedAt: string;
}

/**
 * le cadre bâti mesuré, traduit en `SurfaceContext`.
 *
 * `UrbanRural` n'a que deux valeurs là où le chargeur en a cinq : le
 * repliement suit `isUrbanSetting` (l'API (hors instantané)`),
 * donc **un bourg est urbain**. Ce n'est pas une approximation par paresse,
 * c'est la règle du chargeur reprise telle quelle ; la nuance à cinq valeurs
 * reste lisible à côté, dans l'onglet.
 *
 * Les deux autres champs de `SurfaceContext` restent `false` parce que RIEN ne
 * les mesure : `parkedVehiclesObserved` demande de l'imagerie (le D10 est
 * coupé) et `sidewalkBothSides` n'a aucun producteur. Ils partent
 * donc avec un code de raison qui le dit, pour qu'un lecteur ne prenne jamais
 * ce `false` pour un « non » mesuré — c'est précisément la confusion que
 * l'enveloppe `Fact` existe pour empêcher.
 */
export function surfaceFromSetting(setting: MeasuredSetting): Fact<SurfaceContext> {
  if (setting.kind === 'inconnu') return { known: false, why: 'no_data' };
  const urban = setting.kind === 'dense' || setting.kind === 'urbain' || setting.kind === 'bourg';
  return {
    known: true,
    value: {
      urbanRural: urban ? 'urban' : 'rural',
      parkedVehiclesObserved: false,
      sidewalkBothSides: false,
    },
    provenance: {
      source: 'bdtopo-postgis',
      method: `built-ratio-${setting.densityRadiusM}m`,
      fetchedAt: setting.fetchedAt,
    },
    reliability: {
      confidence: 0.7,
      basis: 'derived',
      reasonCodes: [
        `built_ratio_${setting.builtRatio === null ? 'unknown' : setting.builtRatio.toFixed(3)}`,
        `setting_${setting.kind}`,
        'parked_vehicles_not_observed',
        'sidewalks_not_observed',
      ],
    },
  };
}
