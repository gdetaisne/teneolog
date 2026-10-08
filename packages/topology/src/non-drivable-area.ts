/**
 * LES AIRES OÙ UN CAMION NE MANŒUVRE PAS : une place
 * piétonne, un parc, une pelouse. LA LISTE DES ÉTIQUETTES, une fois (principe
 * 23) : la requête Overpass des aires interdites au planificateur
 * (`@teneolog/adapters`, `overpass-non-drivable.ts`) la lit, et les lieux de
 * demi-tour de S1 (`egress-candidates.ts`) aussi.
 *
 * Elle vit ici, et non dans les adaptateurs, parce que S1 en a besoin et que
 * les adaptateurs dépendent de ce paquet, jamais l'inverse.
 *
 * `highway=pedestrian|footway` ne compte qu'en aire (`area=yes`) : fermé sans
 * `area=yes`, c'est une boucle de rue piétonne, pas une surface — et une rue
 * piétonne reste circulable pour S1 (Rue Voisine LBE, BUG-037b,
 * `continuity.ts`).
 *
 * Le constat de la place
 * Voisine JC (OSM way 117624157, highway=pedestrian, area=yes) et sa voisine (way
 * 225761835) étaient servies comme options de demi-tour « boucle », Ø 30,5 m
 * « mesuré », sol public — alors que le planificateur,, ne peut
 * pas y manœuvrer.
 */

/** Ce qui n'est pas roulable pour une manœuvre : une clé OSM, ses valeurs, et si elle ne compte qu'en aire. */
export const NON_DRIVABLE_AREA_TAGS: readonly {
  readonly key: string;
  readonly values: readonly string[];
  readonly areaOnly: boolean;
}[] = [
  { key: 'highway', values: ['pedestrian', 'footway'], areaOnly: true },
  { key: 'area:highway', values: ['pedestrian', 'footway', 'cycleway'], areaOnly: false },
  { key: 'leisure', values: ['park', 'garden', 'playground', 'pitch'], areaOnly: false },
  { key: 'landuse', values: ['grass', 'flowerbed'], areaOnly: false },
];

/** Un chemin OSM (fermé) qui décrit une aire où le camion ne manœuvre pas, d'après la liste. */
export function isNonDrivableAreaWay(tags: Readonly<Record<string, string>>): boolean {
  return NON_DRIVABLE_AREA_TAGS.some(({ key, values, areaOnly }) => {
    const value = tags[key];
    if (value === undefined || !values.includes(value)) return false;
    return !areaOnly || tags['area'] === 'yes';
  });
}
