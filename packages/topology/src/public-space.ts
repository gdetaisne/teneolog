/**
 * L'ESPACE PUBLIC D'UNE VUE DU CIEL : dans le cadre d'une photo (une
 * scène de virage du deck, la vue de l'adresse), ce que ne couvre aucune
 * parcelle du cadastre, moins le bâti BD TOPO, RELIÉ à la route du camion — et
 * coupé aux liens qu'aucun véhicule ne prend. Le responsable produit, sur le pointillé de la
 * carte du demi-tour : « tu peux ajouter ces éléments sur toutes les
 * vues du ciel ? ». Le domaine public donne l'espace réel, de mur à mur, là où
 * la BD TOPO ne donne qu'une largeur de chaussée — surtout dans un virage
 * (principe 27).
 *
 * Même calcul que le bout de l'impasse (`open-space-served.ts`, une source) ;
 * seules la zone et les graines changent : la zone est le cadre de la vue, les
 * graines sont le trajet du camion qui la traverse. Ce qui ne touche pas ce
 * trajet (une cour enclavée, une place qu'on ne rejoint que par un passage
 * piéton) n'est pas servi.
 *
 * Un FAIT dessiné, jamais un verdict (principes 17 et 42) : « non cadastré »
 * n'est pas « roulable » — trottoirs, passages piétons, espaces verts
 * communaux en sont —, et le cadastre peut être décalé d'un mètre ou deux sur
 * la photo. L'opérateur tranche sur la photo.
 */
import type { GeoPoint } from '@teneolog/domain';

import { frameOf, type GeoBox } from './open-space-grid.js';
import {
  blockedMask,
  MAX_CELLS,
  OPEN_SPACE_CELL_M,
  SEED_BAND_M,
  servedSpace,
  stampPolyline,
  type OpenSpace,
  type OpenSpaceLinks,
  type OpenSpaceParcel,
} from './open-space-served.js';

export type { GeoBox } from './open-space-grid.js';

export interface PublicSpaceInput {
  /**
   * Le cadre de la vue, en degrés : l'espace se cherche dedans et s'y arrête.
   * Les parcelles, le bâti et les tronçons doivent y avoir été lus EN ENTIER —
   * une parcelle manquante se lirait publique.
   */
  readonly box: GeoBox;
  /**
   * Le trajet du camion dans la vue : des polylignes (un point seul en est une),
   * à `SEED_BAND_M` près. Ce qui dépasse du cadre est ignoré.
   */
  readonly seeds: readonly (readonly GeoPoint[])[];
  /** Toutes les parcelles qui touchent le cadre. */
  readonly parcels: readonly OpenSpaceParcel[];
  /** L'anneau extérieur de chaque bâti qui touche le cadre. */
  readonly buildings: readonly (readonly GeoPoint[])[];
  /** Les tronçons BD TOPO du cadre ; absents, pas de coupe aux liens fermés. */
  readonly links?: OpenSpaceLinks;
}

/**
 * Une inconnue nommée, jamais un espace vide (principe 14) : `empty_box` (cadre
 * dégénéré), `area_too_large` (garde du calcul), `no_seed` (le trajet ne passe
 * pas dans le cadre), `seed_on_parcels` (le trajet court sur des parcelles :
 * voie privée cadastrée, ou calage de l'axe).
 */
export type PublicSpaceResult =
  | { readonly known: true; readonly value: OpenSpace }
  | {
      readonly known: false;
      readonly why: 'empty_box' | 'area_too_large' | 'no_seed' | 'seed_on_parcels';
    };

/** L'espace public du cadre relié au trajet du camion. Pur. */
export function computePublicSpace(input: PublicSpaceInput): PublicSpaceResult {
  const { box } = input;
  if (!(box.south < box.north && box.west < box.east)) return { known: false, why: 'empty_box' };
  const frame = frameOf(box, OPEN_SPACE_CELL_M);
  if (frame.cols * frame.rows > MAX_CELLS) return { known: false, why: 'area_too_large' };
  const seeds = new Uint8Array(frame.cols * frame.rows);
  for (const line of input.seeds) if (line.length > 0) stampPolyline(seeds, frame, line, SEED_BAND_M);
  if (!seeds.includes(1)) return { known: false, why: 'no_seed' };
  const free = blockedMask(frame, input.parcels, input.buildings).map((b) => (b === 1 ? 0 : 1));
  const space = servedSpace(frame, free, seeds, input.links);
  return space === null ? { known: false, why: 'seed_on_parcels' } : { known: true, value: space };
}
