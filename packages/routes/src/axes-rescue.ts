/**
 * LE SAUVETAGE DES JONCTIONS TRONQUÉES, porté de
 * l'engine (BUG-045, principe 29).
 *
 * LE DÉFAUT. Les rues locales d'un axe se demandent par disques de
 * `localFetchRadiusM` (1 500 m) le long de sa corde, triés par distance et
 * plafonnés à `maxLocalSegmentsPerFetch` (500) lignes. Sur un axe long, la
 * rue qui le rejoint là où il est le plus près de l'adresse peut tomber
 * au-delà de la 500ᵉ ligne : la jonction n'est jamais évaluée, et l'axe ne
 * porte aucune porte. Vérifié sur Thairé le 2026-09-30, avant ce code
 * (hypothèse 4 ; script jetable `packages/pipeline/scripts/out/diag-thaire-bug045.ts`,
 * non versionné — les chiffres sont ici et au journal ) : l'axe
 * d'importance 3 au nord, à 3 663 m, rendait 0 porte à l'anneau de 5 000 m ;
 * les dix disques de 300 m de CET axe (treize en tout sur les trois axes de
 * l'anneau) ont rapporté 157 rues locales absentes du pool, aucun n'était
 * tronqué, et l'axe a porté 19 portes, la plus proche à 3 717 m au nord (15°).
 * C'est le « nord à 3,7 km manqué » du rapport du 2026-09-15 (§5.2).
 *
 * CE QU'ON GARDE DE L'ENGINE, mot pour mot (`discover-gates-for-axis.ts`
 * l. 143-172, `select-uncovered-endpoints.ts`, constantes
 * `AXIS_JUNCTION_RESCUE_*`) : pour chaque axe, les bouts de ses tronçons qu'AUCUNE
 * porte de CET axe ne couvre à moins de 350 m, espacés d'au moins 400 m,
 * dix au plus ; un disque de 300 m de rues locales autour de chacun — assez
 * petit pour tenir sous le plafond de lignes — puis les jonctions sont
 * réévaluées sur le pool enrichi. Le sauvetage tourne même quand l'axe porte
 * déjà des portes ailleurs : c'est ce qui le distingue des autres replis.
 * L'engine dit lui-même ces quatre nombres provisoires, « à calibrer sur le
 * corpus » (la note de conception interne de l'engine, 2026-07-07); ils viennent de lui
 * et de nulle part ailleurs (principe 30).
 *
 * CE QU'ON CHANGE — ÉCART AU PRINCIPE 29, validé par Décision produit
 * (hypothèse 6, « oui go ») : l'engine prend ses dix points dans l'ordre des
 * latitudes puis des longitudes, un ordre qui ne veut rien dire pour un
 * camion ; on les prend **les plus proches de l'arrêt d'abord**. C'est le
 * principe 34 — l'ancre est le premier point du réseau fiable rencontré en
 * remontant du point de livraison — appliqué au choix des disques.
 *
 * DEUX DIFFÉRENCES DE FORME avec l'engine, relevées à la relecture du
 * 2026-09-30, sans perte de rue : (a) la couverture se lit sur les portes
 * APRÈS les six filtres et le dédoublonnage (l'engine prend ses jonctions
 * avant) — un bout couvert par une jonction refusée est donc sauvé, une
 * requête de plus au pire ; (b) le sauvetage tourne à CHAQUE anneau sondé,
 * parce que l'étage juge chaque anneau jusqu'au bout (`axes-rings.ts`), là où
 * l'engine le fait une fois, au rayon de recherche. La mémoire du pool
 * (`LocalWayPool.rescueAt`) empêche qu'un même centre soit demandé deux fois.
 *
 * CE QUE ÇA COÛTE AU PIRE, nommé : dix disques par axe distinct rencontré, sur
 * tous les anneaux sondés — sans plafond en NOMBRE (l'engine n'en a pas non
 * plus) ; le TEMPS est borné par `gates.axes.stageTimeoutMs` (20 s), au-delà
 * duquel l'étage rend `timeout` et R0 sert. Le relevé du corpus le chiffre
 * (`AxisFetchReport.rescue`, rapport du 2026-09-30).
 *
 * OÙ IL TOURNE : dans le mode `axes` seulement (`axes-scale.ts`), en silence
 * comme lui. La règle de secteurs servie en prod n'en sait rien : `sweep`
 * ne passe ni `rescue` ni `select` à `probeRing` (relecture du 2026-09-30), et
 * le relevé du corpus en mode `sectors` est identique à celui de main.
 */
import type { AxisCorridor, AxisGate, GeoPoint } from '@teneolog/domain';
import { haversineM, type RoadWay } from '@teneolog/topology';

/** Le rayon d'un disque de sauvetage (engine : `AXIS_JUNCTION_RESCUE_RADIUS_M`). */
export const RESCUE_RADIUS_M = 300;
/** Un bout d'axe à moins de ça d'une porte du même axe est couvert (engine : `AXIS_JUNCTION_RESCUE_COVERAGE_M`). */
const RESCUE_COVERAGE_M = 350;
/** Deux disques de sauvetage du même axe sont espacés d'au moins ça (engine : `AXIS_JUNCTION_RESCUE_POINT_SPACING_M`). */
const RESCUE_SPACING_M = 400;
/** Au plus tant de disques par axe (engine : `AXIS_JUNCTION_RESCUE_MAX_POINTS`). */
export const RESCUE_MAX_POINTS_PER_AXIS = 10;
/**
 * Combien de disques partent ensemble. L'engine en lance autant que sa pool a
 * de connexions; ici trois, validé par Décision produit (hypothèse 8,
 * « trois par trois ») : la pool BD TOPO de l'API (l'API (hors instantané),
 * 8 connexions) sert aussi les autres lecteurs du run et une seconde analyse
 * lancée en même temps — la contention nommée.
 */
export const RESCUE_PARALLEL = 3;

/**
 * Les bouts de tronçon d'un axe qu'aucune porte DE CET AXE ne couvre, les plus
 * proches de l'arrêt d'abord, espacés et plafonnés.
 *
 * « De cet axe » : c'est la couverture de l'engine (`junctions` de
 * `discoverGatesForAxis`, qui ne voit que les portes de l'axe en cours). Une
 * porte d'un autre axe posée au même endroit ne dit rien des rues locales qui
 * rejoignent celui-ci.
 */
export function uncoveredAxisEnds(
  axis: AxisCorridor,
  axisWays: ReadonlyMap<string, RoadWay>,
  gates: readonly AxisGate[],
  stop: GeoPoint,
): readonly GeoPoint[] {
  const covering = gates.filter((gate) => gate.axisId === axis.id).map((gate) => gate.at);
  const ends: GeoPoint[] = [];
  for (const wayId of axis.wayIds) {
    const geometry = axisWays.get(wayId)?.geometry ?? [];
    const first = geometry[0];
    const last = geometry[geometry.length - 1];
    if (first !== undefined) ends.push(first);
    if (last !== undefined && geometry.length > 1) ends.push(last);
  }
  ends.sort((a, b) => haversineM(stop, a) - haversineM(stop, b) || a.lat - b.lat || a.lon - b.lon);

  const picked: GeoPoint[] = [];
  for (const end of ends) {
    if (covering.some((at) => haversineM(at, end) < RESCUE_COVERAGE_M)) continue;
    if (picked.some((held) => haversineM(held, end) < RESCUE_SPACING_M)) continue;
    picked.push(end);
    if (picked.length >= RESCUE_MAX_POINTS_PER_AXIS) break;
  }
  return picked;
}

/** Tous les disques de sauvetage d'un anneau, axe par axe. */
export function rescuePointsOf(
  axes: readonly AxisCorridor[],
  axisWays: ReadonlyMap<string, RoadWay>,
  gates: readonly AxisGate[],
  stop: GeoPoint,
): readonly GeoPoint[] {
  return axes.flatMap((axis) => uncoveredAxisEnds(axis, axisWays, gates, stop));
}
