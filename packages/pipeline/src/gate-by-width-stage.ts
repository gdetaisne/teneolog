/**
 * L'ANCRE PAR LARGEUR, en silence : la poser, et la rejouer.
 *
 * Sortie de `full.ts`, pour la raison du principe 26 : « ce qui
 * dépasse se découpe quand on y touche ». La coupure est celle du sujet — ici
 * on mesure une largeur d'approche et on en déduit un point, `full.ts`
 * orchestre S3 → S6 et ne fait qu'appeler.
 *
 * La règle elle-même n'a pas bougé d'une ligne : l'ancre par largeur est
 * TOUJOURS calculée et ne déplace JAMAIS une ancre (principe 22, inventaire du
 * 2026-09-12). Elle se lit dans l'onglet Ancres, et c'est tout.
 */
import type { Discovery, GeoPoint, TruckProfile } from '@teneolog/domain';
import { comfortableWidthM, type ProjectionPolicy } from '@teneolog/projection';
import { anchorFromProfile, placeGatesByWidth, type CorridorPort, type DiscoveryDraft } from '@teneolog/routes';

/**
 * Ce que l'ancre par largeur lit de la policy, et rien de plus.
 *
 * Un sous-ensemble nommé de `FullParams` plutôt que `FullParams` lui-même :
 * l'import croisé serait circulaire, et surtout la liste dit exactement de quoi
 * cette règle dépend.
 */
export interface GateByWidthParams {
  readonly gates: {
    readonly searchRadiusM: number;
    readonly byWidth?: { readonly enabled: boolean; readonly maxApproaches: number };
  };
  readonly candidates: {
    readonly corridorMarginM: number;
    readonly sampleStepM: number;
    readonly snapM: number;
    readonly laneWidthM: number;
    readonly maxConcurrentFetches: number;
  };
  readonly projection: ProjectionPolicy;
}

/**
 * Le brouillon de la découverte, chaque approche portant son ancre par largeur.
 *
 * Le seuil n'est pas inventé ici : c'est `comfortableWidthM`
 * (`@teneolog/projection`), la borne au-dessus de laquelle `widthFit` rend OK
 * plutôt que HUMAIN — largeur du camion + `lateralClearanceM` +
 * `comfortMarginM`. L'ancre marque la fin du réseau qu'on n'a pas besoin de
 * contrôler : c'est donc bien ce niveau-là, et pas celui du simple passage.
 *
 * Le corridor est celui des itinéraires (`candidates.corridorMarginM`,
 * `sampleStepM`, `snapM`, `laneWidthM`) : mêmes voies, même échelle de
 * largeur, même greffe BD TOPO. Deux réglages feraient deux largeurs pour la
 * même rue.
 */
export async function withGatesByWidth(
  draft: DiscoveryDraft,
  stop: GeoPoint,
  truck: TruckProfile,
  corridor: CorridorPort,
  params: GateByWidthParams,
  fetchedAt: string,
): Promise<DiscoveryDraft> {
  const byWidth = params.gates.byWidth;
  if (byWidth === undefined || !byWidth.enabled) return draft;
  const placed = await placeGatesByWidth(
    {
      stop,
      approachesIn: draft.approaches,
      approachesOut: draft.approachesOut,
      requiredWidthM: comfortableWidthM(truck, params.projection),
      truckId: truck.id,
      // Le même cercle que R0 et que la découverte : trois règles qui ne
      // partiraient pas du même anneau ne seraient pas comparables.
      radiusM: params.gates.searchRadiusM,
      corridorMarginM: params.candidates.corridorMarginM,
      sampleStepM: params.candidates.sampleStepM,
      snapM: params.candidates.snapM,
      laneWidthM: params.candidates.laneWidthM,
      maxApproaches: byWidth.maxApproaches,
      maxConcurrent: params.candidates.maxConcurrentFetches,
      fetchedAt,
    },
    corridor,
  );
  return {
    ...draft,
    approaches: placed.approachesIn,
    approachesOut: placed.approachesOut,
    byWidth: placed.byWidth,
  };
}

/**
 * rejouer les ancres par largeur pour un autre camion, SANS RÉSEAU.
 *
 * Chaque approche mesurée porte son `widthProfile` : les voies traversées, du
 * point de livraison vers l'extérieur, avec leur largeur et leur classe. Le
 * profil ne dépend d'aucun véhicule ; le SEUIL, lui, en dépend entièrement
 * (`comfortableWidthM`). Servir à un 19 t les ancres placées pour un fourgon
 * serait la même faute que servir les verdicts d'un camion sous le nom d'un
 * autre.
 *
 * Une approche sans profil — au-delà du plafond, ou mesure éteinte — reste
 * telle quelle : on ne fabrique pas une ancre pour une jambe qu'on n'a jamais
 * regardée.
 */
export function replaceGatesByWidth(
  discovery: Discovery,
  stop: GeoPoint,
  truck: TruckProfile,
  params: GateByWidthParams,
): Discovery {
  if (discovery.byWidth === null) return discovery;
  const requiredWidthM = comfortableWidthM(truck, params.projection);
  if (discovery.byWidth.requiredWidthM === requiredWidthM && discovery.byWidth.truckId === truck.id) {
    return discovery;
  }
  const replay = <T extends { readonly widthProfile: Discovery['approaches'][number]['widthProfile'] }>(
    approach: T,
  ): T =>
    approach.widthProfile === null
      ? approach
      : {
          ...approach,
          gateByWidth: anchorFromProfile(approach.widthProfile, stop, requiredWidthM),
        };
  return {
    ...discovery,
    approaches: discovery.approaches.map(replay),
    approachesOut: discovery.approachesOut.map(replay),
    byWidth: { ...discovery.byWidth, requiredWidthM, truckId: truck.id },
  };
}
