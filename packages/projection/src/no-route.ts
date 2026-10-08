/**
 * le garde-fou de portée : détecter, jamais juger.
 *
 * la note de conception interne, après avoir mesuré que le
 * plancher de 1 800 m (`gates.minReachM`) ne vide aucune des huit adresses du
 * corpus : « ce qui reste à faire n'est pas de recalibrer le nombre mais de
 * DIRE à l'écran qu'il n'y a plus d'ancre, quand cela arrivera. »
 *
 * `detectNoLegReachesRing` répond à une seule question, sur `GateSearch` —
 * ce que S3 a déjà mesuré, rien de plus : aucune ancre R0 ET aucune jambe
 * découverte n'atteint le cercle ? Si oui, le meilleur sommet mesuré (R0 et
 * découverte confondus) devient le motif que la conclusion attache à HUMAIN
 * (principe 5 : un inconnu n'est jamais un refus). Si non, `null` — et rien
 * en aval ne change, `concludePairs` retombe sur `no_viable_pair` ou
 * `router_unavailable` comme.
 *
 * Pure et sans jugement : ni verdict, ni ordre, ni marge n'est lu ici.
 */
import type { GateSearch, NoLegReachesRingMotif } from '@teneolog/domain';

/** Un sommet mesuré, R0 ou découverte, ramené à une seule forme comparable. */
interface RingVertex {
  readonly reachM: number;
  readonly wayId: string | null;
  readonly wayName: string | null;
  readonly azimuthDeg: number | null;
}

export function detectNoLegReachesRing(gateSearch: GateSearch): NoLegReachesRingMotif | null {
  if (gateSearch.retained.length > 0) return null;

  const discovery = gateSearch.discovery;
  const legsKept = discovery === null ? 0 : discovery.approaches.length + discovery.approachesOut.length;
  if (legsKept > 0) return null;

  const best = bestVertex(vertices(gateSearch, discovery));
  // Rien n'a même été mesuré sous le plancher : le voisinage était vide, pas
  // seulement hors de portée. Un cas d'école, jamais vu sur le corpus — pas
  // de meilleur sommet à raconter, donc pas de motif (un autre reasonCode
  // dira l'absence de réseau).
  if (best === null) return null;

  return {
    minReachM: gateSearch.minReachM,
    bestReachM: best.reachM,
    bestWayId: best.wayId,
    bestWayName: best.wayName,
    bestAzimuthDeg: best.azimuthDeg,
  };
}

/**
 * R0 d'abord, découverte ensuite — l'ORDRE porte le sens : `bestVertex`
 * préfère le premier à égalité de portée (comparaison stricte), donc un
 * sommet R0 nommé l'emporte sur un sommet de découverte anonyme
 * (`ApproachShortOfRing` ne porte ni id ni azimut, principe 14).
 */
function vertices(gateSearch: GateSearch, discovery: GateSearch['discovery']): readonly RingVertex[] {
  const fromR0 = gateSearch.shortOfRing.map((way) => ({
    reachM: way.reachM,
    wayId: way.wayId,
    wayName: way.name,
    azimuthDeg: way.azimuthDeg,
  }));
  const fromDiscovery = (discovery?.shortOfRing ?? []).map((approach) => ({
    reachM: approach.reachM,
    wayId: null,
    wayName: null,
    azimuthDeg: null,
  }));
  return [...fromR0, ...fromDiscovery];
}

function bestVertex(candidates: readonly RingVertex[]): RingVertex | null {
  let best: RingVertex | null = null;
  for (const candidate of candidates) {
    if (best === null || candidate.reachM > best.reachM) best = candidate;
  }
  return best;
}
