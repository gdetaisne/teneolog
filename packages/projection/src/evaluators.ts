/**
 * S5 — per-point evaluators. Pure comparisons of a truck's envelope against
 * agnostic measurements; a registry keyed by point type (architecture §5:
 * adding a type is one evaluator here, nothing else touched).
 *
 * Two rules govern every evaluator:
 * - An unknown measurement NEVER auto-resolves. `known:false` → HUMAN, with
 *   the reason carried. That is the Fact contract reaching the verdict.
 * - Confidence gates symmetrically (EC-04/BUG-011): below the publishable
 *   threshold, OK and NO alike become HUMAN. A doubtful NO refuses good
 *   addresses as silently as a doubtful OK ships bad ones.
 */
import type {
  CriticalPoint,
  Fact,
  FactRef,
  PhysicalBarrier,
  PointGeometry,
  TruckProfile,
  TurnGeometry,
  Verdict,
  Width,
} from '@teneolog/domain';
import { effectiveOffTrackWheelbaseM, readBarrierClosure } from '@teneolog/domain';
import {
  requiredWidthForCurveM,
  requiredWidthForTurnM,
  steadyStateOfftrackingM,
  type TruckSpec,
} from '@teneolog/swept-path';

import type { ProjectionPolicy } from './policy.js';

export interface Evaluation {
  readonly verdict: Verdict;
  readonly marginM: number | null;
  readonly reasonCodes: readonly string[];
  readonly derivedFrom: readonly FactRef[];
  readonly explanation: string;
}

export function evaluatePoint(
  point: CriticalPoint,
  truck: TruckProfile,
  policy: ProjectionPolicy,
): Evaluation {
  if (!point.geometry.known) {
    return human(
      [`point_geometry_${point.geometry.why}`],
      [],
      `La géométrie de ce point n'a pas pu être établie (${point.geometry.why}) — contrôle humain.`,
    );
  }
  const geometry = point.geometry.value;
  const ref = factRef(point.ref, point.geometry);
  const gate = confidenceGate(point.geometry.reliability.confidence, policy);

  switch (geometry.type) {
    case 'DESTINATION':
      return gated(destinationFit(geometry, truck, policy), gate);
    case 'NARROW':
      return gated(widthFit(geometry.geometry.width, truck, policy, 'narrow'), gate);
    case 'TURN':
      return judgeTurn(point, geometry.geometry, ref, gate, truck, policy);
    case 'ROUNDABOUT': {
      const rb = geometry.geometry;
      // Off-tracking is a function of the radius actually driven, not of the
      // vehicle's tightest possible turn: the rear cuts far less around a
      // 25 m ring than around the truck's own 11 m minimum. Taking the tighter
      // of the two overstated the requirement by most of a metre and, now that
      // the ring width yields a graded verdict, turned comfortable rings into
      // refusals. The guard below keeps the radius at or above the minimum.
      const drivenRadiusM = Math.max(rb.outerRadiusM, truck.envelope.turnRadiusM);
      const offtracking = steadyStateOfftrackingM(drivenRadiusM, effectiveOffTrackWheelbaseM(truck));
      const requiredRingM = truck.envelope.widthM + offtracking + policy.roundaboutSweptClearanceM;
      // A ring the truck cannot even steer around is NO, whatever its width.
      if (rb.outerRadiusM < truck.envelope.turnRadiusM) {
        return gated(
          {
            verdict: 'NO',
            marginM: rb.outerRadiusM - truck.envelope.turnRadiusM,
            reasonCodes: ['roundabout_radius_below_vehicle_minimum'],
            derivedFrom: [ref],
            explanation: `Giratoire R=${rb.outerRadiusM.toFixed(0)} m sous le rayon de braquage (${truck.envelope.turnRadiusM} m).`,
          },
          gate,
        );
      }
      // With a ring width, the annulus answers the question the radius cannot:
      // does the vehicle plus its off-tracking fit around the island. Without
      // one, escalate — an unmeasured annulus is not a generous one.
      if (rb.ringWidthM.known) {
        const evaluated = band(
          rb.ringWidthM.value - requiredRingM,
          comfortMarginOf(truck, policy),
          ['roundabout_ring_width'],
          [ref, factRef(point.ref, rb.ringWidthM)],
          `Giratoire R=${rb.outerRadiusM.toFixed(0)} m, balayage ${rb.sweptAngleDeg.toFixed(0)}° : anneau de ${rb.ringWidthM.value.toFixed(1)} m pour ${requiredRingM.toFixed(1)} m requis.`,
        );
        // A width a source DECLARES may clear a roundabout, never condemn one.
        // A refusal is terminal for the customer — there is no deck behind it —
        // and a tag someone typed into OSM is not the evidence that decision
        // deserves. So a declared refusal escalates to a human instead.
        if (evaluated.verdict === 'NO' && rb.ringWidthM.reliability.basis === 'declared') {
          return human(
            ['roundabout_ring_width', 'declared_width_cannot_refuse'],
            [ref, factRef(point.ref, rb.ringWidthM)],
            `${evaluated.explanation} Largeur déclarée, non mesurée : à confirmer avant de refuser.`,
          );
        }
        return gated(
          evaluated,
          worstGate(gate, confidenceGate(rb.ringWidthM.reliability.confidence, policy)),
        );
      }
      return human(
        ['roundabout_annulus_unmeasured'],
        [ref],
        `Giratoire R=${rb.outerRadiusM.toFixed(0)} m, balayage ${rb.sweptAngleDeg.toFixed(0)}° — anneau roulable non mesuré (${requiredRingM.toFixed(1)} m requis).`,
      );
    }
    case 'TURNAROUND':
      // la même lecture que les plans, et une seule : le corps de ce
      // cas est parti dans `judgeTurnaround` ci-dessous, parce que
      // `turnaroundFeasibility` (plans.ts) en tenait une deuxième copie, privée
      // des deux garde-fous de elle refusait donc exactement sur la
      // preuve que ce cas s'interdit de refuser (A/B, §3.1).
      return judgeTurnaround(
        {
          turnaround: {
            known: true,
            value: { usableDiameterM: geometry.geometry.surface.usableDiameterM },
            provenance: point.geometry.provenance,
            reliability: point.geometry.reliability,
          },
          provenTopology: geometry.geometry.provenTopology,
          path: point.ref,
        },
        truck,
        policy,
      );
    // Height: no point type. A declared `maxheight` (OSM, BD TOPO) is a legal
    // band on the segment and is judged in `legal.ts` (`legal_height_limit_
    // exceeded`); a MEASURED overhead obstruction has no producer in S4, so
    // the LOW_CLEARANCE evaluator was retired rather than kept as an illusion
    // of coverage.
  }
}

/**
 * A junction turn and a curve are two objects, and this is where the app had
 * stopped saying so. One rule each:
 *
 * - **virage de carrefour** — the vehicle pivots: the swept width of its angle
 *   against the carriageway it opens onto. The radius does NOT enter; a corner
 *   drawn by a router has none worth the name.
 * - **courbe** — the vehicle is steered through: the off-tracking at the
 *   bend's own radius against the same carriageway. The angle does not enter.
 *
 * Everything after the requirement is the rule every other width test follows,
 * and is deliberately identical: an unmeasured width may clear a manoeuvre,
 * never refuse one, and confidence gates symmetrically.
 */
function judgeTurn(
  point: CriticalPoint,
  turn: TurnGeometry,
  ref: FactRef,
  gate: Gate,
  truck: TruckProfile,
  policy: ProjectionPolicy,
): Evaluation {
  // A bend tighter than the vehicle can steer is not a width problem, and no
  // width rescues it. Asked of a CURVE only: a corner's radius is the router's
  // rounding, and this same test, applied to junction turns, published deficits
  // of ten metres on streets a lorry plainly turns into (13 boulevard Témoin, Paris).
  if (turn.kind === 'curve' && turn.radiusM !== null && turn.radiusM < truck.envelope.turnRadiusM) {
    return gated(
      {
        verdict: 'NO',
        marginM: turn.radiusM - truck.envelope.turnRadiusM,
        reasonCodes: ['curve_radius_below_vehicle_minimum'],
        derivedFrom: [ref],
        explanation: `Courbe de rayon ${turn.radiusM.toFixed(0)} m sous le rayon de braquage (${truck.envelope.turnRadiusM} m).`,
      },
      gate,
    );
  }
  const required = turnRequirement(turn, truck, policy);
  if (required === null) {
    return human(
      ['curve_radius_unknown'],
      [ref],
      `Courbe de ${turn.deflectionDeg.toFixed(0)}° — rayon non établi, donc le déport n'est pas calculable : contrôle humain.`,
    );
  }
  if (!turn.approachWidth.known) {
    return human(
      [`${required.what}_width_unknown`],
      [ref],
      `${required.label} exigeant ${required.metres.toFixed(1)} m — largeur disponible non mesurée.`,
    );
  }
  const widthRef = factRef(point.ref, turn.approachWidth);
  const evaluated = band(
    turn.approachWidth.value.freeM - required.metres,
    comfortMarginOf(truck, policy),
    [`${required.what}_swept_width`],
    [ref, widthRef],
    `${required.label} : ${turn.approachWidth.value.freeM.toFixed(1)} m disponibles pour ${required.metres.toFixed(1)} m requis.`,
  );
  // Same rule as every other width test (see `widthFit`): an estimate may
  // clear the manoeuvre, never refuse it.
  if (evaluated.verdict === 'NO' && turn.approachWidth.reliability.basis !== 'measured') {
    return human(
      [`${required.what}_swept_width`, 'unmeasured_width_cannot_refuse'],
      [ref, widthRef],
      `${evaluated.explanation} Largeur estimée, non mesurée : à confirmer avant de refuser.`,
    );
  }
  // Gated on the point AND on the width it was judged by, the weaker
  // deciding — as every other width test does.
  return gated(
    evaluated,
    worstGate(gate, confidenceGate(turn.approachWidth.reliability.confidence, policy)),
  );
}

/** What this manoeuvre demands, and how to name it to the operator. */
function turnRequirement(
  turn: TurnGeometry,
  truck: TruckProfile,
  policy: ProjectionPolicy,
): { readonly metres: number; readonly what: string; readonly label: string } | null {
  if (turn.kind === 'junction') {
    return {
      metres: requiredWidthForTurnM(turn.deflectionDeg, toTruckSpec(truck), policy.turnSweptClearanceM),
      what: 'turn',
      label: `Virage de carrefour ${turn.deflectionDeg.toFixed(0)}°`,
    };
  }
  // A curve with no radius cannot be judged as a curve, and is not silently
  // promoted to a crossroads: it becomes a question (principe 5).
  if (turn.radiusM === null) return null;
  return {
    metres: requiredWidthForCurveM(turn.radiusM, toTruckSpec(truck), policy.turnSweptClearanceM),
    what: 'curve',
    label: `Courbe R=${turn.radiusM.toFixed(0)} m (${turn.deflectionDeg.toFixed(0)}°)`,
  };
}

/**
 * L'ARRÊT : la rue est-elle fermée, et sinon, est-elle assez large ?
 *
 * La fermeture d'abord, et c'est tout le constat L4-3 : une borne
 * fixe relevée sur la rue de livraison n'atteignait aucun verdict. Une rue
 * traversante, large de 10 m, sans limite de tonnage, et fermée, sortait
 * « arrêt évident » — « worse than a false dead end, because the truck arrives
 * and the report said it would pass » (`topology-assessment.ts`).
 *
 * Ce qu'une barrière vaut est écrit UNE fois, dans `readBarrierClosure`
 * (`@teneolog/domain`), et `assessObviousStop` lit la même chose. Une barrière
 * seulement DÉCLARÉE — c'est le cas de toutes celles qu'OSM donne — rend une
 * QUESTION, jamais un refus (principe 5, et `OSM_BARRIER_PHYSICAL` de l'engine
 * porte `hardNo: false`). La largeur n'est même pas lue quand la rue est
 * fermée : elle ne répondrait pas à la question posée.
 */
function destinationFit(
  geometry: { readonly width: Fact<Width>; readonly barriers?: readonly Fact<PhysicalBarrier>[] },
  truck: TruckProfile,
  policy: ProjectionPolicy,
): Evaluation {
  const closure = readBarrierClosure(geometry.barriers);
  if (closure.kind === 'blocked') {
    return {
      verdict: 'NO',
      marginM: null,
      reasonCodes: closure.reasonCodes,
      derivedFrom: [],
      explanation: `Rue de livraison fermée : ${BARRIER_FR[closure.barrier.kind]} infranchissable, mesurée sur place.`,
    };
  }
  if (closure.kind === 'doubtful') {
    return human(
      closure.reasonCodes,
      [],
      `Rue de livraison : ${BARRIER_FR[closure.barrier.kind]} relevée sur la voie, franchissement non établi — à confirmer avant de livrer.`,
    );
  }
  return widthFit(geometry.width, truck, policy, 'destination');
}

/** Le nom de l'objet, en français, pour la phrase de l'écran. Une seule table. */
const BARRIER_FR: Readonly<Record<PhysicalBarrier['kind'], string>> = {
  bollard: 'borne fixe',
  gate: 'portail',
  chicane: 'chicane',
  retractable_post: 'borne escamotable',
  height_frame: 'gabarit de hauteur',
  block: 'bloc de béton',
};

function widthFit(
  width: Fact<Width>,
  truck: TruckProfile,
  policy: ProjectionPolicy,
  what: string,
): Evaluation {
  if (!width.known) {
    return human([`${what}_width_${width.why}`], [], `Largeur non mesurée (${width.why}) — contrôle humain.`);
  }
  const requiredM = requiredWidthM(truck, policy);
  const marginM = width.value.freeM - requiredM;
  const inner = band(marginM, comfortMarginOf(truck, policy), [`${what}_width`], [factRefOf(what, width)],
    `${width.value.freeM.toFixed(1)} m libres pour ${requiredM.toFixed(1)} m requis.`);
  // A width nobody measured — read off a lane count, or off an attribute
  // someone typed into a map — is good enough to relieve a review, never to
  // condemn an address. A refusal is terminal for the customer: there is no
  // deck behind it and no way to argue with it, so it is owed a measurement
  // or a pair of eyes.
  if (inner.verdict === 'NO' && width.reliability.basis !== 'measured') {
    return human(
      [`${what}_width`, 'unmeasured_width_cannot_refuse'],
      [factRefOf(what, width)],
      `${inner.explanation} Largeur estimée, non mesurée : à confirmer avant de refuser.`,
    );
  }
  // The width fact carries its own confidence, gated on top of the point's.
  return gated(inner, confidenceGate(width.reliability.confidence, policy));
}

/**
 * The carriageway width this lorry needs to pass at all: its envelope plus the
 * policy's lateral clearance. Below it, `band` returns NO.
 *
 * Exported for the same reason as `turnaroundRequirementM` below: the anchor
 * by width asks the very same question of a road it has not routed
 * yet — "is this wide enough for this truck" — and a second copy of the sum
 * would be a second definition of a lorry's width.
 */
export function requiredWidthM(truck: TruckProfile, policy: ProjectionPolicy): number {
  return truck.envelope.widthM + policy.lateralClearanceM;
}

/**
 * The width at which the passage stops being a question — "large sans doute".
 *
 * `band` below has two positive levels: above `requiredWidthM` the geometry
 * clears on paper (HUMAN, a person confirms), and above `requiredWidthM +
 * comfortMarginM` it clears with room (OK, nobody is asked). This is the
 * second: the width from which a road no longer has to be controlled, which
 * is exactly what an anchor marks the end of (la note de conception interne).
 *
 * pl-19t on the production policy: 2,5 + 0,8 + 0,4 = 3,7 m.
 */
export function comfortableWidthM(truck: TruckProfile, policy: ProjectionPolicy): number {
  return requiredWidthM(truck, policy) + comfortMarginOf(truck, policy);
}

/**
 * LA BANDE DE CONFORT DE CE CAMION — la seule lecture (principe 23).
 *
 * Générique par défaut ; plus large pour la famille que la policy nomme.
 * Décision produit (principe 31) : « il faut à l'évidence dégrader, et
 * peut-être même prendre une marge additionnelle, parce que sortir un semi qui
 * est bloqué, c'est très compliqué. » Une famille absente de la table prend
 * `comfortMarginM`, donc rien ne bouge pour le fourgon ni pour le porteur.
 */
export function comfortMarginOf(truck: TruckProfile, policy: ProjectionPolicy): number {
  return policy.comfortMarginByFamilyM?.[truck.family] ?? policy.comfortMarginM;
}


/**
 * The diameter a turnaround must offer this truck: two turning radii plus the
 * policy's clearance.
 *
 * Exported because the plans ask the same question of the same
 * measurement, off any critical point: "can this lorry turn round here". Two
 * copies of the formula would be two definitions of a U-turn.
 */
export function turnaroundRequirementM(truck: TruckProfile, policy: ProjectionPolicy): number {
  return 2 * truck.envelope.turnRadiusM + policy.turnaroundClearanceM;
}

/** Ce qu'il faut savoir pour juger un demi-tour, d'où qu'on le lise. */
export interface TurnaroundReading {
  /**
   * Le retournement mesuré. `known: false` — `not_applicable` compris — est un
   * silence : ni un refus, ni une permission.
   */
  readonly turnaround: Fact<{ readonly usableDiameterM: number }>;
  /**
   * VV1-06 / faux quand le nœud terminal était au bord du rayon
   * étudié — l'impasse peut se dissoudre sur un fetch plus large, donc la forme
   * n'est pas établie et un refus ferme ne se publie pas.
   */
  readonly provenTopology: boolean;
  /** Où le fait est accroché : la référence du point en S5, l'arrêt pour un plan. */
  readonly path: string;
}

/**
 * Ce camion peut-il faire demi-tour ici — LA lecture, et la seule.
 *
 * Elle vivait ici, dans le cas TURNAROUND de `evaluatePoint`, et une deuxième
 * fois dans `turnaroundFeasibility` (`plans.ts`) sous la forme d'une
 * comparaison nue `usableDiameterM >= turnaroundRequirementM`. Les deux
 * lectures portaient sur la MÊME mesure, mais la seconde ignorait les deux
 * garde-fous que avait posés après coup : sur les trois impasses du
 * corpus, le point disait HUMAIN et le plan disait NON — huit régressions sur
 * vingt-quatre cas (A/B, §3.1 et annexe, défaut 1).
 *
 * L'ordre des trois questions est ce qui fait la règle, et il ne se
 * réordonne pas :
 *
 *  1. la marge, dans les bandes de la policy (`band`) — négative NON, sous la
 *     marge de confort HUMAIN, au-dessus OK ;
 *  2. un NON sur une topologie non prouvée redevient une question ;
 *  3. un NON sur un diamètre seulement DÉCLARÉ redevient une question — un
 *     nombre que personne n'a mesuré peut absoudre un retournement, jamais le
 *     condamner (même règle que `widthFit`, TURN et ROUNDABOUT) ;
 *  4. et la confiance filtre symétriquement par-dessus (EC-04/BUG-011).
 *
 * On ne refuse donc jamais sur du non-mesuré.
 */
export function judgeTurnaround(
  reading: TurnaroundReading,
  truck: TruckProfile,
  policy: ProjectionPolicy,
): Evaluation {
  const { turnaround } = reading;
  // Le même silence que celui d'une géométrie de point inconnue, et le même
  // code : `collectCriticalPoints` recopie ce `why` tel quel dans la géométrie
  // du point TURNAROUND, donc les deux lectures le nomment pareil.
  if (!turnaround.known) {
    return human(
      [`point_geometry_${turnaround.why}`],
      [],
      `Le retournement à l'arrêt n'a pas pu être établi (${turnaround.why}) — contrôle humain.`,
    );
  }
  const ref = factRef(reading.path, turnaround);
  const requiredM = turnaroundRequirementM(truck, policy);
  const marginM = turnaround.value.usableDiameterM - requiredM;
  const evaluated = band(marginM, comfortMarginOf(truck, policy), ['turnaround_diameter'], [ref],
    `Retournement : ${turnaround.value.usableDiameterM.toFixed(1)} m utilisables pour ${requiredM.toFixed(1)} m requis.`);
  // VV1-06 / an unproven topology (terminal node at the edge of the
  // fetch) means the dead-end might dissolve on a wider fetch. The shape is
  // therefore not established and a firm refusal is not warranted.
  if (evaluated.verdict === 'NO' && !reading.provenTopology) {
    return human(
      ['turnaround_diameter', 'topology_unproven'],
      [ref],
      `${evaluated.explanation} Topologie non établie (nœud terminal hors du rayon intérieur) : élargir le fetch avant de refuser.`,
    );
  }
  // VV1-05 / a declared diameter (tag OSM ou largeur de chaussée
  // déclarée) may clear a turnaround, never condemn one — same rule as every
  // other width test (widthFit, TURN, ROUNDABOUT).
  if (evaluated.verdict === 'NO' && turnaround.reliability.basis === 'declared') {
    return human(
      ['turnaround_diameter', 'declared_width_cannot_refuse'],
      [ref],
      `${evaluated.explanation} Diamètre déclaré, non mesuré : à confirmer avant de refuser.`,
    );
  }
  return gated(evaluated, confidenceGate(turnaround.reliability.confidence, policy));
}

/**
 * OK / HUMAIN / NON par la marge, la bande de confort restant humaine.
 *
 * `comfortMarginM` est passé résolu, jamais lu sur la policy ici : depuis
 * il dépend de la FAMILLE du camion (principe 31 — un semi bloqué est
 * très compliqué à sortir), et `comfortMarginOf` est la seule lecture.
 */
function band(
  marginM: number,
  comfortMarginM: number,
  reasonCodes: readonly string[],
  derivedFrom: readonly FactRef[],
  explanation: string,
): Evaluation {
  if (marginM < 0) return { verdict: 'NO', marginM, reasonCodes: [...reasonCodes, 'margin_negative'], derivedFrom, explanation };
  if (marginM < comfortMarginM) {
    return { verdict: 'HUMAN', marginM, reasonCodes: [...reasonCodes, 'margin_within_comfort_band'], derivedFrom, explanation };
  }
  return { verdict: 'OK', marginM, reasonCodes, derivedFrom, explanation };
}

type Gate = 'pass' | 'escalate';

function confidenceGate(confidence: number, policy: ProjectionPolicy): Gate {
  return confidence >= policy.publishableConfidence ? 'pass' : 'escalate';
}

/** Two gates over one verdict: the weaker evidence decides. */
function worstGate(left: Gate, right: Gate): Gate {
  return left === 'escalate' || right === 'escalate' ? 'escalate' : 'pass';
}

/** Below the publishable bar, OK and NO alike become HUMAN. */
function gated(evaluation: Evaluation, gate: Gate): Evaluation {
  if (gate === 'pass' || evaluation.verdict === 'HUMAN') return evaluation;
  return {
    ...evaluation,
    verdict: 'HUMAN',
    reasonCodes: [...evaluation.reasonCodes, 'confidence_below_publishable'],
  };
}

function human(reasonCodes: readonly string[], derivedFrom: readonly FactRef[], explanation: string): Evaluation {
  return { verdict: 'HUMAN', marginM: null, reasonCodes, derivedFrom, explanation };
}

/**
 * Le gabarit tel que le verdict le lit (le semi : d'un bloc, sellette → essieu).
 * Lu aussi par le demi-tour dans l'espace réel (
 * l'API (hors instantané)) : une seule lecture.
 */
export function toTruckSpec(truck: TruckProfile): TruckSpec {
  return {
    id: truck.id,
    label: truck.label,
    lengthM: truck.envelope.lengthM,
    widthM: truck.envelope.widthM,
    // la dimension qui conduit le déport, pas celle du tracteur.
    // Une seule lecture, dans `@teneolog/domain` (principe 23).
    wheelbaseM: effectiveOffTrackWheelbaseM(truck),
    turnRadiusM: truck.envelope.turnRadiusM,
    frontOverhangM: truck.envelope.frontOverhangM,
    rearOverhangM: truck.envelope.rearOverhangM,
  };
}

function factRef(path: string, fact: { readonly known: true; readonly provenance: { readonly source: FactRef['source'] }; readonly reliability: { readonly confidence: number } }): FactRef {
  return { path, source: fact.provenance.source, confidence: fact.reliability.confidence };
}

function factRefOf(path: string, fact: Fact<Width>): FactRef {
  if (!fact.known) return { path, source: 'human', confidence: 0 };
  return { path, source: fact.provenance.source, confidence: fact.reliability.confidence };
}

export type { PointGeometry };
