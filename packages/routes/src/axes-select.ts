/**
 * LA SÉLECTION FINALE : cinq portes, réparties par secteurs.
 *
 * Portage de `itinerary-selection.ts` de l'engine (principe 29) :
 * `selectItinerariesForAnalysis` trie toutes les portes éligibles par distance
 * croissante à l'adresse, puis `selectSectorDistributedItineraryAnchors` en
 * garde au plus `maxPerSector` par secteur de 30°, et `buildRouteAttemptPlans`
 * monte le quota 1 → 2 → 3 → tout tant qu'il en faut.
 *
 * L'app s'arrête à `gates.gateCount` (cinq) parce qu'elle ROUTE chaque ancre
 * dans les deux sens et en croise toutes les entrantes avec toutes les
 * sortantes : l'engine peut se permettre de tout router, pas le plan de l'app.
 * Donc : quota 1 d'abord — au plus une porte par direction — puis 2, puis 3,
 * en s'arrêtant dès que cinq sont prises.
 *
 * POURQUOI LES SECTEURS REMPLACENT LES 36°. Le plancher de séparation de R0
 * (`360 / gateCount / 2`) est RELATIF au premier arrivé : la première ancre
 * prise interdit 36° de part et d'autre d'elle-même, et comme le tri est « le
 * plus loin d'abord », le premier arrivé est celui qui est un mètre plus loin.
 * À Auxerre, une voie communale sans nom a bloqué 28 voies à elle seule, dont
 * six `primary` (fiche S3 §H4). Douze secteurs FIXES de 30° donnent au
 * contraire une place à chaque direction, indépendamment de l'ordre d'arrivée.
 * Ce qu'on perd : une porte à 1° d'une frontière de secteur ne « protège »
 * plus sa voisine de l'autre côté. Ce qu'on gagne : plus aucune direction ne
 * peut être confisquée, et l'ordre d'arrivée ne décide plus rien.
 *
 * PRINCIPE 34 — ON NE PLANCHE PAS LES PORTES D'AXE. Décision produit :
 * « si on trouve une départementale (importance 2-3) à moins de 2 km je vois
 * mal l'intérêt d'aller chercher plus loin. 13 boulevard Témoin Paris 16, on n'a
 * pas du tout besoin de perdre du temps sur les calculs d'itinéraires. » La
 * porte est le PREMIER point du réseau structurant rencontré en remontant du
 * point de livraison, même à 300 m — exactement ce que fait l'engine. Le
 * plancher `gates.minReachM` reste la règle des jambes R0 et découvertes
 * (/415); il ne choisit aucune porte ici. Ce que le principe 1 exige en
 * échange : une porte posée sous le cercle porte
 * `approach_uncontrolled_beyond_gate` et ses mètres non étudiés, et l'onglet
 * les écrit en clair.
 */
import type { AxisGate, UncontrolledApproach } from '@teneolog/domain';
import { bearingDeltaDeg } from '@teneolog/topology';

/** Les quotas successifs, comme les plans d'essai de l'engine (`sector_12 → sector_24 → rescue_36`). */
export const SECTOR_QUOTAS = [1, 2, 3] as const;

export interface AxisSelection {
  /** Toutes les portes, dans l'ordre de la sélection, chacune avec son sort. */
  readonly gates: readonly AxisGate[];
  /** Les retenues, triées par azimut — la forme de `GateSearch.retained`. */
  readonly retained: readonly AxisGate[];
}

/**
 * Les `gateCount` portes retenues, et le sort de toutes les autres.
 *
 * L'ordre d'entrée est celui de `findAxisGates` : distance croissante à
 * l'adresse. Une porte non retenue porte `sector_full` (son secteur avait
 * atteint son quota au tour où elle a été vue) ou `slots_full` (les places
 * étaient prises avant qu'on la regarde). Une porte retenue sous `minReachM`
 * porte `approach_uncontrolled_beyond_gate` : elle est bien l'ancre, et les
 * mètres qui la séparent du cercle ne seront étudiés par personne.
 */
export function selectAxisGates(
  gates: readonly AxisGate[],
  gateCount: number,
  sectorCount: number,
  minReachM: number,
): AxisSelection {
  const ordered = [...gates].sort((a, b) => a.distanceM - b.distanceM || a.id.localeCompare(b.id));
  const slots = emptySlots(sectorCount);
  fillByQuotas(ordered, gateCount, sectorCount, slots);
  return decide(ordered, slots, minReachM);
}

/**
 * LES PORTES DE BANDE : LE TOUR DU CERCLE, tous
 * les 60°, puis les quotas de secteur.
 *
 * POURQUOI PAS LA RÈGLE DE `selectAxisGates`. Une porte de bande est posée SUR
 * le cercle (`axes-band.ts`) : elles sont toutes entre 1 800 et 2 000 m, donc
 * la distance ne les départage pas, et **c'est l'identifiant qui finissait par
 * décider** — le défaut H4/H3 de la fiche S3, que cet étage existe justement
 * pour supprimer. Mesuré à Thairé le 2026-09-14 au soir : sur vingt candidates,
 * la porte de la D113 (56,3°) perdait sa place au profit d'une voisine à 45,4°
 * du même secteur, sur l'ordre du `cleabs` BD TOPO, et la porte de la D203E5
 * (272,6°) tombait parce qu'une porte à 309,3° — 36,7° plus loin, la même
 * approche — avait pris la sienne.
 *
 * LA RÈGLE : on fait LE TOUR DU CERCLE en azimut et on garde une porte tous les
 * `minDirectionSeparationDeg` (60°). C'est **exactement la règle qui COMPTE les
 * directions** (`distinctDirections`, `axes-geometry.ts`) — même écart, même
 * départ canonique (le point qui suit le plus grand vide, pour que le tour ne
 * dépende pas de l'origine des azimuts, qui est le nord) — appliquée aux
 * AZIMUTS plutôt qu'aux bacs de 30°. Deux raisons de compter en azimut ici :
 * une frontière de bac sépare deux portes à 2° d'écart, et deux portes à 11°
 * d'écart tombent dans le même bac, où seul l'identifiant peut alors trancher.
 * Ce que la sélection retient et ce que le critère d'arrêt compte disent donc
 * la même chose, mesuré de la même façon.
 *
 * Les places qui restent après le tour vont aux quotas de secteur, la règle
 * commune : le reste est partagé mot pour mot avec `selectAxisGates`
 * (principe 23) — les quotas, les motifs de non-rétention, et la mesure de
 * l'approche non étudiée.
 */
export function selectBandGates(
  gates: readonly AxisGate[],
  gateCount: number,
  sectorCount: number,
  minDirectionSeparationDeg: number,
  minReachM: number,
): AxisSelection {
  const ordered = [...gates].sort((a, b) => b.distanceM - a.distanceM || a.azimuthDeg - b.azimuthDeg);
  const slots = emptySlots(sectorCount);
  for (const gate of spreadByAzimuth(gates, gateCount, minDirectionSeparationDeg)) {
    take(slots, gate, sectorIn(gate, sectorCount));
  }
  fillByQuotas(ordered, gateCount, sectorCount, slots);
  return decide(ordered, slots, minReachM);
}

/**
 * Le tour du cercle : une porte, puis la suivante à au moins `minSeparationDeg`,
 * en partant du point qui suit le plus grand vide.
 *
 * La même mécanique que `distinctDirections`, sur des azimuts. Le cercle se
 * referme à la fin : si la dernière gardée touche la première, elle tombe —
 * sinon deux « directions » se toucheraient par le bord, et le quota de secteur
 * lui rendra sa place s'il en reste une.
 */
function spreadByAzimuth(
  gates: readonly AxisGate[],
  gateCount: number,
  minSeparationDeg: number,
): readonly AxisGate[] {
  const sorted = [...gates].sort((a, b) => a.azimuthDeg - b.azimuthDeg || a.id.localeCompare(b.id));
  if (sorted.length <= 1) return sorted.slice(0, gateCount);
  const from = widestGapIndex(sorted);
  const kept: AxisGate[] = [];
  for (const gate of [...sorted.slice(from), ...sorted.slice(0, from)]) {
    if (kept.length >= gateCount) break;
    const last = kept[kept.length - 1];
    if (last === undefined || bearingDeltaDeg(last.azimuthDeg, gate.azimuthDeg) >= minSeparationDeg) {
      kept.push(gate);
    }
  }
  const last = kept[kept.length - 1];
  const first = kept[0];
  if (kept.length > 1 && last !== undefined && first !== undefined) {
    if (bearingDeltaDeg(last.azimuthDeg, first.azimuthDeg) < minSeparationDeg) kept.pop();
  }
  return kept;
}

/** Par où commencer le tour : la porte qui SUIT le plus grand vide d'azimut. */
function widestGapIndex(sorted: readonly AxisGate[]): number {
  let index = 0;
  let widest = -1;
  for (let i = 0; i < sorted.length; i += 1) {
    const here = sorted[i] as AxisGate;
    const previous = sorted[(i - 1 + sorted.length) % sorted.length] as AxisGate;
    const gap = (((here.azimuthDeg - previous.azimuthDeg) % 360) + 360) % 360;
    if (gap > widest) {
      widest = gap;
      index = i;
    }
  }
  return index;
}

/** Ce que la sélection a décidé pendant qu'elle décidait. */
interface Slots {
  readonly occupancy: number[];
  /** Porte retenue → son rang, dans l'ordre où elle a été prise. */
  readonly chosen: Map<string, number>;
  /** Porte écartée → pourquoi, tant qu'aucune passe ne l'a reprise. */
  readonly blocked: Map<string, string>;
}

function emptySlots(sectorCount: number): Slots {
  return {
    occupancy: new Array<number>(sectorCount).fill(0),
    chosen: new Map<string, number>(),
    blocked: new Map<string, string>(),
  };
}

function sectorIn(gate: AxisGate, sectorCount: number): number {
  return Math.min(Math.max(gate.sector, 0), sectorCount - 1);
}

function take(slots: Slots, gate: AxisGate, sector: number): void {
  slots.occupancy[sector] = (slots.occupancy[sector] ?? 0) + 1;
  slots.chosen.set(gate.id, slots.chosen.size + 1);
  slots.blocked.delete(gate.id);
}

/** Les quotas de secteur, 1 puis 2 puis 3 — la règle commune aux deux sélections. */
function fillByQuotas(
  ordered: readonly AxisGate[],
  gateCount: number,
  sectorCount: number,
  slots: Slots,
): void {
  for (const quota of SECTOR_QUOTAS) {
    for (const gate of ordered) {
      if (slots.chosen.size >= gateCount) break;
      if (slots.chosen.has(gate.id)) continue;
      const sector = sectorIn(gate, sectorCount);
      if ((slots.occupancy[sector] ?? 0) >= quota) {
        slots.blocked.set(gate.id, 'sector_full');
        continue;
      }
      take(slots, gate, sector);
    }
    if (slots.chosen.size >= gateCount) break;
  }
}

/** Le sort de chaque porte, écrit sur elle — et les retenues, par azimut. */
function decide(
  ordered: readonly AxisGate[],
  slots: Slots,
  minReachM: number,
): AxisSelection {
  return decideSelection(ordered, slots.chosen, slots.blocked, minReachM);
}

/**
 * LE SORT ÉCRIT SUR CHAQUE PORTE — la seule et même mise en forme pour toutes
 * les sélections (principe 23).
 *
 * Trois sélections l'utilisent : les quotas de secteur (`selectAxisGates`), le
 * tour du cercle des portes de bande (`selectBandGates`) et,,
 * l'ancre par axe du mode `axes` (`axes-scale.ts`). Ce qui les distingue est
 * QUI est pris et POURQUOI les autres ne le sont pas ; ce qui ne change jamais
 * est la forme du résultat — le rang, le motif, les mètres d'approche non
 * étudiés (principe 34) et l'ordre par azimut des retenues. Le recopier
 * ailleurs serait le défaut que le principe 23 nomme.
 */
export function decideSelection(
  ordered: readonly AxisGate[],
  chosen: ReadonlyMap<string, number>,
  blocked: ReadonlyMap<string, string>,
  minReachM: number,
): AxisSelection {
  const decided = ordered.map((gate) => {
    const rank = chosen.get(gate.id) ?? null;
    const uncontrolledBeyondM = rank === null ? null : uncontrolledOf(gate, minReachM);
    const reasonCodes =
      rank === null
        ? [blocked.get(gate.id) ?? 'slots_full']
        : uncontrolledBeyondM === null
          ? []
          : ['approach_uncontrolled_beyond_gate'];
    return { ...gate, rank, reasonCodes, uncontrolledBeyondM };
  });

  return {
    gates: decided,
    retained: decided
      .filter((gate) => gate.rank !== null)
      .sort((a, b) => a.azimuthDeg - b.azimuthDeg),
  };
}

/**
 * Les mètres d'approche qu'une porte retenue laisse hors étude, ou `null`.
 *
 * Arrondis au mètre : c'est une phrase à l'écran, pas une mesure de verdict.
 */
function uncontrolledOf(gate: AxisGate, minReachM: number): number | null {
  const beyond = minReachM - gate.distanceM;
  return beyond > 0 ? Math.round(beyond) : null;
}

/**
 * Les approches qu'aucune jambe n'étudiera, une ligne par porte retenue posée
 * sous le cercle — la matière de la phrase de l'onglet (principe 1).
 */
export function uncontrolledApproaches(
  retained: readonly AxisGate[],
  axisLabelOf: (gate: AxisGate) => string,
  minReachM: number,
): readonly UncontrolledApproach[] {
  return retained
    .filter((gate) => gate.uncontrolledBeyondM !== null)
    .map((gate) => ({
      gateId: gate.id,
      axisLabel: axisLabelOf(gate),
      importance: gate.importance,
      gateDistanceM: Math.round(gate.distanceM),
      uncontrolledM: gate.uncontrolledBeyondM ?? 0,
      minReachM,
    }));
}
