/**
 * S3 — UNE JAMBE QUI TRAVERSE UNE AUTRE ANCRE.
 *
 * Divergence relevée le 2026-09-12 (« Une jambe qui traverse une autre ancre »,
 * effort M) : côté app, `grep -rn "other_gate|passes_through"` ne rendait rien,
 * et « deux ancres alignées sur la même pénétrante produisent deux itinéraires
 * quasi identiques, comptés et classés comme deux options distinctes ».
 *
 * LA RÈGLE VIENT DE L'ENGINE (principe 29) — `detectPassesThroughOtherGate`,
 * `itinerary-fast-filters.ts` l.292-360, avec ses trois nombres l.12-18 :
 *
 *  - `GATE_SITE_PROXIMITY_M = 30` — « Max distance (m) from a gate site to
 *    count as "passing through" that gate » ;
 *  - `GATE_DEPARTURE_CLEARANCE_M = 15` — on ignore les points encore dans le
 *    voisinage immédiat de l'origine de la jambe (et, pour une sortante, du
 *    point de livraison), sans quoi une jambe traverserait sa propre ancre ;
 *  - `GATE_PASS_PROGRESS_EPS_M = 5` — le départage quand deux ancres sont à la
 *    même distance du point de livraison.
 *
 * CE QU'ON GARDE : les trois nombres, la règle directionnelle (pour une
 * entrante, seule une ancre STRICTEMENT plus proche du point de livraison peut
 * être traversée — « the nearer gate is the real port »), le dégagement au
 * départ, et surtout la mesure PAR ARÊTE : l'engine a dû y venir parce qu'un
 * balayage sommet par sommet « misses the closest approach when it falls
 * mid-edge between two sparse vertices », et faisait alors dépendre le résultat
 * de la décimation d'OSRM.
 *
 * CE QU'ON CHANGE, ET POURQUOI :
 *
 *  - la zone d'une ancre est ici un POINT, pas un segment. L'engine a des
 *    ancres de jonction qui portent une corde « site d'axe → entrée locale » ;
 *    une ancre de R0 est un sommet du réseau structurant, et rien d'autre.
 *  - on rend l'ancre traversée LA PLUS PROCHE, quand l'engine rend la première
 *    de sa liste. Il élimine, donc la première suffit ; ici la marque est une
 *    lecture, et la plus proche est celle qui veut dire quelque chose. Le
 *    résultat ne dépend alors plus de l'ordre des ancres.
 *  - le dégagement s'applique au POINT DE CONTACT, quand l'engine l'applique
 *    aux sommets de l'arête. Détaillé plus bas, là où il joue.
 *  - AUCUNE ÉLIMINATION. L'engine écarte parfois la jambe (`eliminatedByGatePass`,
 *    `approach-routing.ts` l.235 et l.570), sauf `allowedForwardGatePass` — qui
 *    demande de savoir si la rue de livraison est en sens unique. L'app ne sait
 *    pas cela (divergence « Côté de livraison et sens unique de la rue
 *    d'arrivée » : `wrong_side` est déclaré et jamais émis), et l'engine
 *    lui-même a relâché cette famille de règles en informatif le 2026-07-01,
 *    BUG-057 classé `wontfix`. Éliminer sans la condition qui la borne
 *    refuserait sur du non-mesuré (principe 5) et casserait l'indépendance de
 *    l'entrée et de la sortie (principe 8). Donc : on marque, on montre, et on
 *    tranche plus tard sur ce que l'A/B aura compté.
 */
import type { GatePassMark, GeoPoint } from '@teneolog/domain';
import { closestPointOnPolyline, haversineM } from '@teneolog/topology';

import type { Gate } from './gates.js';

/** Distance maximale au point d'une autre ancre pour la « traverser ». */
export const GATE_SITE_PROXIMITY_M = 30;

/** Voisinage immédiat de l'origine d'une jambe, où l'on ne regarde rien. */
export const GATE_DEPARTURE_CLEARANCE_M = 15;

/** Départage entre deux ancres à distance égale du point de livraison. */
export const GATE_PASS_PROGRESS_EPS_M = 5;

/**
 * `wayId@azimut` — la clé d'une ancre, celle que portent déjà les identifiants
 * de jambe (`candidateIdOf`) et l'appariement entrante/sortante.
 *
 * Ici et non dans `gates.ts` parce que c'est le premier lecteur qui en avait
 * besoin ailleurs que pour frapper un identifiant ; la définition reste unique.
 */
export function gateKeyOf(gate: Pick<Gate, 'wayId' | 'azimuthDeg'>): string {
  return `${gate.wayId}@${gate.azimuthDeg.toFixed(0)}`;
}

export interface GatePassInput {
  readonly polyline: readonly GeoPoint[];
  /** L'ancre d'où part (entrante) ou vers laquelle va (sortante) cette jambe. */
  readonly gate: Gate;
  /** Les autres ancres retenues du run — celle de la jambe comprise, elle est écartée ici. */
  readonly gates: readonly Gate[];
  readonly stop: GeoPoint;
  readonly direction: 'in' | 'out';
}

/**
 * L'ancre retenue la plus proche que cette jambe traverse, ou null.
 *
 * Pure et sans réseau : quelques centaines de points contre quatre ancres.
 */
export function detectGatePass(input: GatePassInput): GatePassMark | null {
  const { polyline, gate, gates, stop, direction } = input;
  if (polyline.length < 2) return null;

  const selfKey = gateKeyOf(gate);
  const terminal = direction === 'in' ? stop : gate.at;
  const progressOrigin = direction === 'in' ? gate.at : stop;
  const originToTerminalM = haversineM(progressOrigin, terminal);

  const others = gates.filter((other) => {
    if (gateKeyOf(other) === selfKey) return false;
    // Règle directionnelle de l'engine : pour une entrante, seule une ancre
    // strictement plus proche du point de livraison peut être « la vraie
    // porte ». Pour une sortante, toutes sont candidates.
    if (direction === 'out') return true;
    return other.distanceM + GATE_PASS_PROGRESS_EPS_M < gate.distanceM;
  });
  if (others.length === 0) return null;

  const eligible = (point: GeoPoint): boolean => {
    if (haversineM(point, gate.at) < GATE_DEPARTURE_CLEARANCE_M) return false;
    if (direction === 'out' && haversineM(point, stop) < GATE_DEPARTURE_CLEARANCE_M) return false;
    // `hasLeftLegOrigin`, appliqué par l'engine à la seule entrante
    // (`minDistanceToGateTraversalSegment` : `leg === 'inbound' && …`).
    if (direction === 'out') return true;
    return haversineM(point, terminal) + GATE_PASS_PROGRESS_EPS_M < originToTerminalM;
  };

  let best: GatePassMark | null = null;
  for (let i = 0; i + 1 < polyline.length; i += 1) {
    const edge = [polyline[i] as GeoPoint, polyline[i + 1] as GeoPoint];
    for (const other of others) {
      // Par ARÊTE, jamais par sommet : la mesure ne doit pas dépendre du
      // nombre de points qu'OSRM a rendus (engine, même commentaire).
      const closest = closestPointOnPolyline(edge, other.at);
      if (closest === null || closest.distanceM > GATE_SITE_PROXIMITY_M) continue;
      // L'engine teste ses deux SOMMETS et garde l'arête dès que l'un des deux
      // passe ; on teste le POINT DE CONTACT lui-même. C'est ce que dit son
      // commentaire — « ignore polyline points still in the immediate
      // neighbourhood of the leg origin » — et ce que son code ne fait pas :
      // un contact à 3 m du départ y survit dès que l'autre bout de l'arête
      // est sorti du dégagement. Plus strict, donc, et dans le sens qui compte
      // ici : la marque dit « en chemin », pas « en sortant de chez soi ».
      // Sans effet sur R0, où deux ancres sont séparées d'au moins 36°
      // d'azimut, donc de centaines de mètres à deux kilomètres.
      if (!eligible(closest.point)) continue;
      if (best === null || closest.distanceM < best.distanceM) {
        best = { gateId: gateKeyOf(other), distanceM: closest.distanceM };
      }
    }
  }
  return best;
}
