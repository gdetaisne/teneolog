/**
 * S3 — le tronc commun : ce que TOUTES les jambes partagent.
 *
 * Décision produit : « analyser les itinéraires en partant de l'endroit
 * le plus risqué (destination) ». L'endroit le plus risqué est aussi le seul
 * que personne ne peut éviter : entre le point de livraison et la première
 * divergence, chaque jambe passe par la même rue.
 *
 * **Définition, volontairement simple.** On oriente chaque jambe vers
 * l'extérieur (une entrante est retournée) ; la plus courte sert de référence,
 * parce que le tronc ne peut pas être plus long que la plus courte des
 * jambes ; on avance le long de la référence et on s'arrête au premier
 * échantillon dont une jambe s'écarte de plus de `toleranceM`. La tolérance
 * est celle que la découverte emploie déjà pour dire que deux jambes sont la
 * même approche (`SNAP_TOLERANCE_M`, 15 m) — en poser une deuxième ferait deux
 * définitions de « la même rue ».
 *
 * Ce que le tronc vaut, en pratique : quelques dizaines de mètres sur une rue
 * de livraison, et **zéro** dès que deux jambes abordent l'adresse par des
 * côtés opposés — ce qui est le cas courant d'une rue traversante. Ce n'est
 * pas un défaut de la mesure, c'est la mesure : il n'y a alors rien de commun
 * à tout le monde, et un refus commun n'aurait aucun sens.
 *
 * Pur : aucune requête, aucun corridor. Le pipeline lui donne des lignes et en
 * reçoit une.
 */
import type { GeoPoint } from '@teneolog/domain';
import { closestPointOnPolyline, haversineM } from '@teneolog/topology';

export interface CommonTrunkInput {
  readonly stop: GeoPoint;
  /** Les jambes, chacune dans son sens de parcours. */
  readonly legs: readonly { readonly direction: 'in' | 'out'; readonly polyline: readonly GeoPoint[] }[];
  /** Écart au-delà duquel deux jambes ne sont plus sur la même rue. */
  readonly toleranceM: number;
  /** Pas d'avancée le long de la référence. */
  readonly stepM: number;
  /** Plafond : au-delà, on ne cherche plus — le tronc n'est pas un itinéraire. */
  readonly maxLengthM: number;
}

export interface CommonTrunkGeometry {
  /** Du point de livraison vers l'extérieur. Vide quand il n'y a rien de commun. */
  readonly polyline: readonly GeoPoint[];
  readonly lengthM: number;
  readonly legsCompared: number;
}

export function commonTrunkOf(input: CommonTrunkInput): CommonTrunkGeometry {
  const outward = input.legs
    .map((leg) => (leg.direction === 'in' ? [...leg.polyline].reverse() : [...leg.polyline]))
    .filter((line) => line.length >= 2);
  if (outward.length === 0) return { polyline: [], lengthM: 0, legsCompared: 0 };

  const reference = outward.reduce((shortest, line) =>
    lengthOf(line) < lengthOf(shortest) ? line : shortest,
  );
  const others = outward.filter((line) => line !== reference);
  const limitM = Math.min(input.maxLengthM, lengthOf(reference));

  let keptM = 0;
  for (let travelled = 0; travelled <= limitM; travelled += input.stepM) {
    const at = pointAtM(reference, travelled);
    if (at === null) break;
    // Le point de livraison lui-même appartient à tout le monde par
    // construction : on ne le fait pas voter, sinon un arrondi du routeur
    // suffirait à annuler le tronc.
    if (travelled > 0 && others.some((line) => distanceToM(line, at) > input.toleranceM)) break;
    keptM = travelled;
  }

  // Un tronc plus court que la tolérance n'est pas un tronc : à cette échelle,
  // « les jambes partagent la rue » ne se distingue pas de « les jambes partent
  // du même point », qui est vrai par construction. Sur une rue traversante
  // abordée des deux côtés, c'est exactement ce qui arrive — et la bonne
  // réponse est alors qu'il n'y a rien de commun.
  if (keptM <= input.toleranceM) return { polyline: [], lengthM: 0, legsCompared: outward.length };
  return {
    polyline: prefixOf(reference, keptM),
    lengthM: keptM,
    legsCompared: outward.length,
  };
}

function distanceToM(line: readonly GeoPoint[], point: GeoPoint): number {
  const closest = closestPointOnPolyline(line, point);
  return closest === null ? Number.POSITIVE_INFINITY : closest.distanceM;
}

function pointAtM(polyline: readonly GeoPoint[], distanceM: number): GeoPoint | null {
  if (distanceM <= 0) return polyline[0] ?? null;
  let travelled = 0;
  for (let i = 0; i + 1 < polyline.length; i += 1) {
    const a = polyline[i] as GeoPoint;
    const b = polyline[i + 1] as GeoPoint;
    const lengthM = haversineM(a, b);
    if (travelled + lengthM >= distanceM) {
      const t = lengthM === 0 ? 0 : (distanceM - travelled) / lengthM;
      return { lat: a.lat + t * (b.lat - a.lat), lon: a.lon + t * (b.lon - a.lon) };
    }
    travelled += lengthM;
  }
  return null;
}

/** Le début de la ligne jusqu'à `distanceM`, dernier point interpolé. */
function prefixOf(polyline: readonly GeoPoint[], distanceM: number): readonly GeoPoint[] {
  const kept: GeoPoint[] = [polyline[0] as GeoPoint];
  let travelled = 0;
  for (let i = 0; i + 1 < polyline.length; i += 1) {
    const a = polyline[i] as GeoPoint;
    const b = polyline[i + 1] as GeoPoint;
    const lengthM = haversineM(a, b);
    if (travelled + lengthM >= distanceM) {
      const t = lengthM === 0 ? 0 : (distanceM - travelled) / lengthM;
      if (t > 0) kept.push({ lat: a.lat + t * (b.lat - a.lat), lon: a.lon + t * (b.lon - a.lon) });
      break;
    }
    travelled += lengthM;
    kept.push(b);
  }
  return kept.length < 2 ? [] : kept;
}

function lengthOf(polyline: readonly GeoPoint[]): number {
  let sum = 0;
  for (let i = 0; i + 1 < polyline.length; i += 1) {
    sum += haversineM(polyline[i] as GeoPoint, polyline[i + 1] as GeoPoint);
  }
  return sum;
}
