/**
 * S6 — the conclusion in words. All user-facing copy is French (the repo
 * rule: code and docs English, product French); every sentence is DERIVED
 * from the conclusion's typed fields — this module adds no judgement, only
 * language, so a summary can never say what the verdicts do not.
 */
import type { NoLegReachesRingMotif, PointVerdict, RunConclusion, Verdict } from '@teneolog/domain';

export interface ConclusionSummary {
  /** One-line verdict headline. */
  readonly headline: string;
  /** Why, in one or two sentences a dispatcher can read aloud. */
  readonly explanation: string;
  /**
   * The points a human still has to look at, most severe first — on the
   * retained pair only (or, with no pair, on the legs still open). A point on
   * a discarded itinerary is not pending: the answer does not rest on it
   *.
   */
  readonly attention: readonly PointVerdict[];
}

const HEADLINE: Readonly<Record<RunConclusion['overall'], (label: string) => string>> = {
  OK: (label) => `Livrable en ${label}.`,
  HUMAN: (label) => `Livrable en ${label}, sous réserve de contrôle.`,
  NO: (label) => `Non accessible en ${label}.`,
  NOT_DELIVERABLE: () => `Adresse non livrable.`,
};

const SEVERITY: Readonly<Record<Verdict, number>> = { NO: 2, HUMAN: 1, OK: 0 };

/**
 * Les trois motifs qui veulent dire « pas de réponse », et non « à contrôler ».
 *
 * Un ensemble vide de paires n'est ni un refus ni une réserve : il n'y a pas
 * d'itinéraire. Les trois codes viennent de `concludePairs` (`emptySetReason`),
 * qui est leur seule source ; cette liste est leur seule traduction.
 */
const NO_ANSWER_CODES: readonly string[] = [
  'router_unavailable',
  'no_leg_reaches_ring',
  'no_viable_pair',
];

export const ROUTER_UNAVAILABLE_EXPLANATION =
  "Itinéraires indisponibles : le calculateur de trajets n'a pas répondu. Relancez l'analyse.";

export function summariseConclusion(conclusion: RunConclusion, truckLabel: string): ConclusionSummary {
  const retained = new Set(conclusion.retainedPointRefs);
  const attention = conclusion.pointVerdicts
    .filter((pv) => pv.verdict !== 'OK' && retained.has(pv.pointRef))
    .sort((a, b) => SEVERITY[b.verdict] - SEVERITY[a.verdict]);

  return {
    headline: headline(conclusion, truckLabel),
    explanation: explain(conclusion, attention),
    attention,
  };
}

function headline(conclusion: RunConclusion, truckLabel: string): string {
  // Un routeur en panne n'établit rien sur l'adresse, et le
  // garde-fou de portée (aucun candidat, rien à « livrer sous
  // réserve ») est la même situation pour l'opérateur — pas de réponse, pas
  // un refus (principe 5) : une seule phrase pour les deux (relecture
  //, principe 23 — elle était écrite deux fois côte à côte).
  //
  // `no_viable_pair` les rejoint. C'est le MÊME état —
  // aucun itinéraire, donc aucune réponse — et il ne devenait visible que
  // depuis que le run sans candidat conclut au lieu de se taire. Le titre
  // « Livrable sous réserve de contrôle » y était faux dans le sens dangereux :
  // il n'y avait rien à contrôler, et rien à livrer.
  if (NO_ANSWER_CODES.some((code) => conclusion.reasonCodes.includes(code))) {
    return `Accès en ${truckLabel} non déterminé.`;
  }
  return HEADLINE[conclusion.overall](truckLabel);
}

function explain(conclusion: RunConclusion, attention: readonly PointVerdict[]): string {
  if (conclusion.reasonCodes.includes('router_unavailable')) {
    return ROUTER_UNAVAILABLE_EXPLANATION;
  }
  if (conclusion.reasonCodes.includes('best_pair_legally_blocked')) {
    return 'Tous les itinéraires praticables traversent une restriction légale (tonnage, gabarit ou accès réservé).';
  }
  if (conclusion.reasonCodes.includes('no_leg_reaches_ring') && conclusion.noLegReachesRing !== null) {
    return explainNoLegReachesRing(conclusion.noLegReachesRing);
  }
  if (conclusion.reasonCodes.includes('no_viable_pair')) {
    return "Aucun couple d'itinéraires aller-retour n'a pu être établi vers cette adresse.";
  }
  const deciding = attention.find((pv) => pv.pointRef === conclusion.decidedBy);
  if (deciding !== undefined) {
    // The point's own explanation was derived from its facts in S5; reuse it
    // rather than paraphrasing — one text per fact, not two.
    return deciding.explanation;
  }
  if (conclusion.overall === 'OK') {
    return "L'itinéraire retenu ne présente aucun point au-dessous des marges de confort.";
  }
  return `${attention.length} point(s) restent à contrôler sur l'itinéraire retenu.`;
}

/**
 * la phrase du garde-fou de portée. Rendue une seule fois ici,
 * lue depuis `/explain` (`summary.explanation`, inchangé) et depuis le fil
 * l’API (`compat-wire.ts` la relaie telle quelle, sans la reformuler) :
 * une seule source pour un texte qui voyage à deux endroits (principe 23).
 */
export function explainNoLegReachesRing(motif: NoLegReachesRingMotif): string {
  const floor = frMetres(motif.minReachM);
  const best = frMetres(motif.bestReachM);
  const wayLabel = motif.bestWayId === null ? null : (motif.bestWayName ?? `voie ${motif.bestWayId}`);
  const compass = motif.bestAzimuthDeg === null ? null : frCompassDirection(motif.bestAzimuthDeg);
  const detail =
    wayLabel === null ? '' : ` (${wayLabel}${compass === null ? '' : `, vers le ${compass}`})`;
  return (
    `Aucune voie structurante n'atteint le cercle de ${floor} autour de l'arrêt : ` +
    `la plus proche s'arrête à ${best}${detail}. ` +
    `L'analyse ne peut pas proposer d'itinéraire ; ce n'est pas un refus.`
  );
}

/** `1 312 m` — un espace pour les milliers, jamais de décimale : la brasse suffit ici. */
function frMetres(m: number): string {
  const rounded = Math.round(m).toString();
  return `${rounded.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} m`;
}

const COMPASS_FR = [
  'nord',
  'nord-est',
  'est',
  'sud-est',
  'sud',
  'sud-ouest',
  'ouest',
  'nord-ouest',
] as const;

/** Le cap, aux huit points cardinaux — la précision d'un azimut mesuré au sommet, pas plus. */
function frCompassDirection(azimuthDeg: number): string {
  const normalised = ((azimuthDeg % 360) + 360) % 360;
  const index = Math.round(normalised / 45) % COMPASS_FR.length;
  return COMPASS_FR[index] as string;
}
