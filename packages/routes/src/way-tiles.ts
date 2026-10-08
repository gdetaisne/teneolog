/**
 * S3 — charger les voies UNE FOIS par adresse, par tuile.
 *
 * Aujourd'hui chaque corridor redemande Overpass le long de sa propre
 * polyligne, puis regreffe la BD TOPO dessus. Or les jambes d'une même adresse
 * partagent leurs derniers centaines de mètres et, en ville, des tronçons
 * entiers : à Paris 11e, 16 corridors coûtent 92,7 s cumulées, 5,8 s chacun
 * (la note de conception interne). Le même travail, fait une fois
 * par tuile, se partage entre toutes les jambes.
 *
 * **L'invariant, et ce qui le tient.** Le corridor assemblé depuis les tuiles
 * doit contenir exactement les mêmes voies que le corridor demandé
 * directement. Trois règles s'en chargent :
 *
 *  1. **Une tuile est un sur-ensemble prouvé.** Elle est chargée sur sa boîte
 *     élargie de `marginM`, donc toute voie qui passe à moins de `marginM`
 *     d'un point de la tuile y est.
 *  2. **Le filtre est la distance exacte segment à segment**, pas un
 *     échantillonnage : c'est la sémantique de `around:` d'Overpass et de
 *     `ST_DWithin` de la BD TOPO, qui sont les deux requêtes remplacées.
 *  3. **La greffe reste par corridor.** `graftDeclaredWidth` est rappelé sur
 *     l'étendue du corridor (`corridorExtent`), avec les mêmes voies primaires
 *     et les mêmes tronçons donneurs — parce que la largeur retenue dépend de
 *     l'étendue jugée, donc du corridor, et pas seulement de la voie. Mettre
 *     en cache une voie DÉJÀ greffée donnerait une largeur juste pour la
 *     première jambe rencontrée et fausse pour les suivantes — exactement le
 *     défaut n° 2 de l'annexe de l'A/B.
 *
 * **La limite connue, et elle n'est pas neuve.** Quand un échantillon d'une
 * voie tombe EXACTEMENT à la jonction de deux tronçons donneurs, les deux sont
 * à la même distance et c'est l'ordre du tableau qui les départage
 * (`matchAxis`, `attribution.ts`) — puis « la plus étroite gagne » peut
 * créditer la largeur du tronçon d'à côté. Cet ordre n'a jamais été garanti :
 * la requête BD TOPO du corridor n'a pas d'`ORDER BY`, donc deux exécutions de
 * la version directe pouvaient déjà se contredire. Ici il est au moins
 * DÉTERMINISTE (tri par identifiant). En pratique le cas ne se présente pas
 * sur le terrain : l'axe BD TOPO est décalé de 0,71 m en médiane de l'axe OSM
 * (policy `pipeline.roadAttributes`) et ses coupures ne tombent pas sur les
 * sommets d'OSM — c'est le juge de paix du corpus qui le dit, pas ce
 * commentaire.
 *
 * Ce fichier ne fait aucune requête : il reçoit un `WayTilePort` et compte ce
 * qu'il lui a demandé.
 */
import type { GeoPoint } from '@teneolog/domain';
import {
  corridorExtent,
  graftDeclaredWidth,
  haversineM,
  type GraftOptions,
  type RoadWay,
} from '@teneolog/topology';

import type { CorridorPort } from './ports.js';

/**
 * Ce que le cache demande au monde : les deux sources, séparées — et posées
 * chacune à sa façon.
 *
 * Séparées, parce que la greffe se refait par corridor (règle 3 ci-dessus) :
 * un port qui rendrait des voies déjà greffées ne pourrait plus la rejouer.
 *
 * **Le graphe se tuile, le donneur non, et c'est mesuré.** Une tuile est une
 * boîte ; un corridor est une bande de 60 m de large. La boîte est le bon
 * grain pour Overpass, qui est cher, lent et partagé entre toutes les jambes.
 * Elle est le mauvais grain pour la BD TOPO : relevé du 2026-09-11, une tuile
 * de 500 m à Paris 11e rend des milliers de tronçons là où la bande d'un
 * corridor entier en rend quelques centaines, et le `ST_DWithin` dépasse alors
 * `roadAttributes.donorTimeoutMs` (2,5 s) — trois dépassements ouvrent le
 * disjoncteur, qui prive l'adresse de ses largeurs pendant une minute. Une
 * largeur perdue est un verdict changé. Le donneur garde donc EXACTEMENT la
 * requête qu'il avait : une bande par corridor, 8 à 70 ms côté serveur
 * (la note de conception interne), et le même résultat qu'avant, au tronçon près.
 */
export interface WayTilePort {
  /** Les voies du graphe (OSM) dans la boîte — jamais greffées ici. */
  fetchGraphWays(box: TileBox): Promise<readonly RoadWay[]>;
  /** Les tronçons du donneur le long d'UN corridor. Vide = donneur muet. */
  fetchDonorCorridor(polyline: readonly GeoPoint[], marginM: number): Promise<readonly RoadWay[]>;
}

export interface TiledCorridorOptions {
  readonly tiles: WayTilePort;
  /** Côté d'une tuile de graphe, en mètres. Policy `phase2.wayTiles.tileM`. */
  readonly tileM: number;
  /**
   * Requêtes de tuiles en vol, **pour toute l'adresse**.
   *
   * Globale, et il le faut. Relevé du 2026-09-11 : borner la concurrence à
   * l'intérieur d'un seul `fetchCorridor` ne borne rien du tout — huit
   * corridors partent de front, chacun ouvre sa propre fenêtre de huit, et
   * Overpass reçoit soixante-quatre requêtes simultanées. La médiane d'une
   * tuile passe alors à 30,9 s à Paris 11e, contre 1,4 s à Thairé où les
   * jambes se chevauchent moins. Ce n'était pas le grain qui était mauvais,
   * c'était la vanne qui n'existait pas.
   */
  readonly maxConcurrent: number;
  /**
   * Requêtes de DONNEUR en vol. Bien plus serré que les tuiles, et il y a une
   * raison mécanique, mesurée le 2026-09-11.
   *
   * Quand la greffe abandonne une requête au bout de `donorTimeoutMs` (2,5 s),
   * elle n'annule rien : la connexion reste occupée jusqu'au
   * `statement_timeout` de la pool (5 s, l'API (hors instantané)). Quelques
   * abandons suffisent donc à immobiliser les huit connexions, après quoi
   * chaque nouvelle requête attend plus de deux secondes pour en obtenir une
   * et échoue à son tour — un engrenage, pas une lenteur. Trois échecs ouvrent
   * le disjoncteur, qui prive l'adresse de ses largeurs pendant une minute, et
   * une largeur perdue est un verdict changé.
   *
   * Le cache par tuile rend l'engrenage plus facile à amorcer, parce qu'il
   * supprime l'attente d'Overpass qui espaçait les requêtes : à Paris 11e,
   * vingt-huit bandes partaient en quelques secondes au lieu de quarante.
   * Deux de front bornent le nombre de connexions immobilisables à deux. En
   * production la question ne se pose pas — la BD TOPO répond en 8 à 70 ms sur
   * le réseau docker — mais la mesure, elle, passe par un tunnel.
   */
  readonly donorConcurrent: number;
  /** Les tolérances de la greffe — celles de `pipeline.roadAttributes`. */
  readonly graft: GraftOptions;
  /**
   * LA RELECTURE D'UNE TUILE EN ÉCHEC, policy
   * `phase2.wayTiles.retryMissingTiles`.
   *
   * Absente : le comportement d'avant la tâche, une tuile muette coûte ses
   * voies et on n'en reparle pas.
   */
  readonly retryMissingTiles?: TileRetryPolicy;
}

/**
 * « un tronçon de corridor
 * non lu se relit avant de conclure — on n'est pas à une seconde près (2) — et,
 * s'il reste muet, il devient une question. »
 *
 * UN seul ré-essai, jamais une boucle : une tuile qui échoue deux fois est une
 * tuile qu'on ne sait pas lire aujourd'hui, et l'insistance coûterait le run
 * sans rien apprendre. Le budget est en policy parce qu'il borne une attente
 * que l'opérateur subit.
 */
export interface TileRetryPolicy {
  readonly enabled: boolean;
  /** Plafond du SECOND essai, en millisecondes. */
  readonly timeoutMs: number;
}

export interface WayTileStats {
  readonly tilesLoaded: number;
  readonly corridorsBuilt: number;
  readonly waysHeld: number;
  readonly tileHits: number;
  readonly ms: number;
  /** tuiles relues après un premier échec. */
  readonly tilesRetried: number;
  /** tuiles restées muettes après la relecture : le run le DIT. */
  readonly tilesFailed: number;
}

const METRES_PER_DEG_LAT = 111_320;

/**
 * Une vanne : au plus `limit` travaux en vol, quel que soit le nombre
 * d'appelants.
 *
 * `mapWithConcurrency` borne une liste ; elle ne borne pas huit listes lancées
 * en même temps. C'est la différence entre « huit tuiles de front » et
 * « soixante-quatre », et elle se mesure en dizaines de secondes.
 */
class Gate {
  private inFlight = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly limit: number) {}

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.inFlight >= this.limit) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.inFlight += 1;
    try {
      return await work();
    } finally {
      this.inFlight -= 1;
      this.waiting.shift()?.();
    }
  }
}

/**
 * Un cache de voies par tuile, **portée : une adresse**.
 *
 * Il n'est pas construit au démarrage du serveur mais à chaque phase 2 : les
 * voies d'une adresse n'ont rien à faire dans l'analyse de la suivante, et un
 * cache de processus serait un cache à invalider. Le partage recherché est
 * celui des jambes entre elles, et il tient tout entier dans une adresse.
 */
export class TiledCorridorSource implements CorridorPort {
  private readonly graphTiles = new Map<string, Promise<readonly RoadWay[]>>();
  private readonly waysSeen = new Set<string>();
  private readonly gate: Gate;
  private readonly donorGate: Gate;
  private tilesLoaded = 0;
  private tileHits = 0;
  private corridorsBuilt = 0;
  private ms = 0;
  private tilesRetried = 0;
  /** les tuiles muettes après relecture, par clé. */
  private readonly failedTiles = new Set<string>();

  constructor(private readonly options: TiledCorridorOptions) {
    this.gate = new Gate(Math.max(1, options.maxConcurrent));
    this.donorGate = new Gate(Math.max(1, options.donorConcurrent));
  }

  /**
   * Précharger une zone — la destination d'abord ( §2).
   *
   * Les derniers mètres appartiennent à toutes les jambes : les charger avant
   * la première, et de front, est ce qui fait que la première jambe ne paie
   * pas pour les quinze autres. Le donneur n'a rien à précharger : sa requête
   * est par corridor, et une bande ne se partage pas.
   */
  async preloadAround(centre: GeoPoint, radiusM: number): Promise<void> {
    await this.load(tilesAroundPoint(centre, radiusM, this.options.tileM));
  }

  async fetchCorridor(polyline: readonly GeoPoint[], marginM: number): Promise<readonly RoadWay[]> {
    const startedAt = Date.now();
    if (polyline.length < 2) return [];

    // Les deux moitiés partent ensemble : le donneur ne dépend pas du graphe.
    const [tiles, donorWays] = await Promise.all([
      this.load(tilesAlongPolyline(polyline, marginM, this.options.tileM)),
      this.donorGate
        .run(() => this.options.tiles.fetchDonorCorridor(polyline, marginM))
        // Un donneur muet coûte les largeurs de ce corridor, jamais le run.
        .catch((): readonly RoadWay[] => []),
    ]);

    // Dédoublonnage par identifiant : une voie vue par trois tuiles est une
    // voie. Overpass rend la géométrie entière quelle que soit la requête, donc
    // les trois exemplaires sont identiques.
    const primary = new Map<string, RoadWay>();
    for (const tile of tiles) for (const way of tile) if (!primary.has(way.id)) primary.set(way.id, way);

    const near = nearPolylineFilter(polyline, marginM);
    // Triées par identifiant : l'ordre d'Overpass est celui des identifiants,
    // et deux voies à égalité de distance d'un échantillon se départagent par
    // l'ordre du tableau (`nearestDrivableWay`). Un ordre stable est donc une
    // condition de l'invariant, pas une coquetterie.
    const primaryNear = byId([...primary.values()].filter((way) => near(way.geometry)));

    this.corridorsBuilt += 1;
    this.ms += Date.now() - startedAt;

    // Les tronçons du donneur arrivent DÉJÀ taillés à la bande du corridor :
    // c'est la même requête qu'avant, donc le même ensemble, donc la même
    // greffe. Rien à filtrer ici.
    if (donorWays.length === 0) return primaryNear;
    return graftDeclaredWidth(
      primaryNear,
      donorWays,
      this.options.graft,
      corridorExtent(polyline, marginM),
    );
  }

  stats(): WayTileStats {
    return {
      tilesLoaded: this.tilesLoaded,
      corridorsBuilt: this.corridorsBuilt,
      waysHeld: this.waysSeen.size,
      tileHits: this.tileHits,
      ms: this.ms,
      tilesRetried: this.tilesRetried,
      tilesFailed: this.failedTiles.size,
    };
  }

  /** les tuiles restées muettes, nommées. Vide quand tout a été lu. */
  missingTiles(): readonly string[] {
    return [...this.failedTiles];
  }

  private async load(keys: readonly string[]): Promise<readonly (readonly RoadWay[])[]> {
    for (const key of keys) {
      if (this.graphTiles.has(key)) {
        this.tileHits += 1;
        continue;
      }
      this.tilesLoaded += 1;
      this.graphTiles.set(key, this.fetchTile(key));
    }
    return Promise.all(keys.map((key) => this.graphTiles.get(key) as Promise<readonly RoadWay[]>));
  }

  /**
   * UNE tuile, et UNE relecture si la première tentative échoue.
   *
   * Avant, l'échec était avalé sur place (`.catch(() => [])`) : le corridor
   * devenait plus pauvre, sa couverture tombait, S5 posait `corridor_partial`,
   * et personne ne savait jamais que la carte avait simplement manqué. Le
   * premier geste de la tâche est donc de FAIRE REMONTER l'échec — sans jeter
   * le run (principe 5, un inconnu n'est pas un refus) — et de relire une fois
   * avant que la jambe ne soit jugée.
   *
   * La relecture passe par la même vanne que le premier essai : on ne double
   * pas la charge d'Overpass pour rattraper une tuile.
   */
  private async fetchTile(key: string): Promise<readonly RoadWay[]> {
    const box = tileGeometry(key, this.options.tileM);
    const once = (): Promise<readonly RoadWay[]> =>
      this.gate.run(() => this.options.tiles.fetchGraphWays(box));
    try {
      return this.keep(await once());
    } catch {
      const retry = this.options.retryMissingTiles;
      if (retry?.enabled !== true) {
        this.failedTiles.add(key);
        return [];
      }
      this.tilesRetried += 1;
      try {
        return this.keep(await withTimeout(once(), retry.timeoutMs));
      } catch {
        // Deux fois muette : le tronçon devient une QUESTION (`annotate.ts`
        // nomme les échantillons non lus), jamais un OK silencieux.
        this.failedTiles.add(key);
        return [];
      }
    }
  }

  private keep(ways: readonly RoadWay[]): readonly RoadWay[] {
    for (const way of ways) this.waysSeen.add(way.id);
    return ways;
  }
}

/**
 * Le budget du second essai. Il ne coupe pas la requête — rien ne l'annule côté
 * fournisseur — il coupe l'ATTENTE, pour que la relecture ne tienne pas le run
 * plus longtemps que ce que la policy autorise.
 */
async function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('way-tiles: relecture hors budget')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function byId(ways: readonly RoadWay[]): readonly RoadWay[] {
  return [...ways].sort((a, b) => {
    const na = Number(a.id);
    const nb = Number(b.id);
    if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

// ---------------------------------------------------------------------------
// La grille
// ---------------------------------------------------------------------------

/**
 * La grille est ancrée sur (0, 0) et non sur l'adresse : deux analyses
 * voisines partagent alors leurs tuiles, et le cache disque d'Overpass aussi.
 * Le pas en longitude est celui du MILIEU de la rangée, pour qu'une rangée
 * soit un rectangle et non un trapèze.
 */
function latStepOf(tileM: number): number {
  return tileM / METRES_PER_DEG_LAT;
}

function lonStepOf(tileM: number, row: number): number {
  const latMid = (row + 0.5) * latStepOf(tileM);
  const cos = Math.max(Math.cos((latMid * Math.PI) / 180), 0.1);
  return tileM / (METRES_PER_DEG_LAT * cos);
}

export function tileKeyOf(point: GeoPoint, tileM: number): string {
  const row = Math.floor(point.lat / latStepOf(tileM));
  const col = Math.floor(point.lon / lonStepOf(tileM, row));
  return `${row}:${col}`;
}

/**
 * L'emprise d'une tuile : son carré, élargi de la garde de marge.
 *
 * Un RECTANGLE et non un cercle, et ce n'est pas un détail. Le cercle qui
 * couvre un carré de 500 m en fait 0,54 km² pour 0,25 km² utiles : on
 * demandait à Overpass deux fois plus de terrain que la tuile n'en couvre, et
 * `way(around:R, lat, lon)` est en plus la forme la plus chère de son filtre
 * spatial. La boîte est exactement ce dont le cache a besoin, et c'est la
 * requête qu'Overpass sert le mieux.
 */
export interface TileBox {
  readonly south: number;
  readonly west: number;
  readonly north: number;
  readonly east: number;
}

export function tileGeometry(key: string, tileM: number): TileBox {
  const [rowText, colText] = key.split(':');
  const row = Number(rowText);
  const col = Number(colText);
  const latStep = latStepOf(tileM);
  const lonStep = lonStepOf(tileM, row);
  // La garde de marge, plus un mètre : toute voie à moins de `marginM` d'un
  // point de la tuile est dans cette boîte. C'est la règle 1, et elle se relit
  // ici.
  const padLat = (CORRIDOR_MARGIN_GUARD_M + 1) / METRES_PER_DEG_LAT;
  const padLon = ((CORRIDOR_MARGIN_GUARD_M + 1) * lonStep) / tileM;
  return {
    south: row * latStep - padLat,
    west: col * lonStep - padLon,
    north: (row + 1) * latStep + padLat,
    east: (col + 1) * lonStep + padLon,
  };
}

/**
 * La marge jusqu'à laquelle une tuile est chargée.
 *
 * Fixe, et volontairement : la taille du disque chargé décide de la clé du
 * cache, et une clé qui dépendrait de la marge demandée ferait deux tuiles au
 * même endroit dès qu'un appelant demande 30 m et un autre 40. 60 m couvre
 * largement `candidates.corridorMarginM` (30 m) ; un appelant qui demanderait
 * plus se verrait refuser plutôt que mal servi (`assertMarginFits`).
 */
const CORRIDOR_MARGIN_GUARD_M = 60;

export function assertMarginFits(marginM: number): void {
  if (marginM > CORRIDOR_MARGIN_GUARD_M) {
    throw new Error(
      `way-tiles: marge ${marginM} m au-delà de la garde ${CORRIDOR_MARGIN_GUARD_M} m — le cache ne peut pas la promettre`,
    );
  }
}

/** Toutes les tuiles à moins de `radiusM` du point, sa propre tuile comprise. */
export function tilesAroundPoint(
  centre: GeoPoint,
  radiusM: number,
  tileM: number,
): readonly string[] {
  return tilesInBox(centre, radiusM, tileM);
}

/**
 * Les tuiles traversées par la polyligne, marge comprise.
 *
 * La ligne est reprise sommet par sommet ET jalonnée tous les `step` mètres,
 * puis chaque jalon ouvre la boîte `marge + step/2` autour de lui. Deux jalons
 * consécutifs étant à `step` au plus l'un de l'autre, tout point de la ligne
 * est à `step/2` d'un jalon : aucune tuile à moins de `marginM` de la ligne ne
 * peut donc manquer. C'est la démonstration de la règle 1, côté ligne.
 */
export function tilesAlongPolyline(
  polyline: readonly GeoPoint[],
  marginM: number,
  tileM: number,
): readonly string[] {
  assertMarginFits(marginM);
  const step = Math.min(tileM / 2, 50);
  const keys = new Set<string>();
  const add = (point: GeoPoint, reachM: number): void => {
    for (const key of tilesInBox(point, reachM, tileM)) keys.add(key);
  };
  const reachM = marginM + step / 2;

  for (let i = 0; i + 1 < polyline.length; i += 1) {
    const a = polyline[i] as GeoPoint;
    const b = polyline[i + 1] as GeoPoint;
    add(a, reachM);
    const lengthM = haversineM(a, b);
    for (let travelled = step; travelled < lengthM; travelled += step) {
      const t = travelled / lengthM;
      add({ lat: a.lat + t * (b.lat - a.lat), lon: a.lon + t * (b.lon - a.lon) }, reachM);
    }
  }
  const last = polyline[polyline.length - 1];
  if (last !== undefined) add(last, reachM);
  return [...keys];
}

function tilesInBox(centre: GeoPoint, reachM: number, tileM: number): readonly string[] {
  const latStep = latStepOf(tileM);
  const dLat = reachM / METRES_PER_DEG_LAT;
  const rowMin = Math.floor((centre.lat - dLat) / latStep);
  const rowMax = Math.floor((centre.lat + dLat) / latStep);
  const keys: string[] = [];
  for (let row = rowMin; row <= rowMax; row += 1) {
    const lonStep = lonStepOf(tileM, row);
    const cos = Math.max(Math.cos((centre.lat * Math.PI) / 180), 0.1);
    const dLon = reachM / (METRES_PER_DEG_LAT * cos);
    const colMin = Math.floor((centre.lon - dLon) / lonStep);
    const colMax = Math.floor((centre.lon + dLon) / lonStep);
    for (let col = colMin; col <= colMax; col += 1) keys.push(`${row}:${col}`);
  }
  return keys;
}

// ---------------------------------------------------------------------------
// « à moins de marginM de la ligne » — la distance exacte, indexée
// ---------------------------------------------------------------------------

interface PlanarPoint {
  readonly x: number;
  readonly y: number;
}

/**
 * Le prédicat que remplacent `around:` (Overpass) et `ST_DWithin` (PostGIS) :
 * une géométrie est dans le corridor dès qu'un de ses segments passe à moins
 * de `marginM` d'un segment de la ligne.
 *
 * Exact — distance segment à segment, croisements compris — et non
 * échantillonné : une avenue rectiligne peut longer la route sans qu'aucun de
 * ses sommets en soit proche, et l'échantillonner reviendrait à décider de
 * l'appartenance d'une voie à la finesse du pas choisi.
 *
 * La projection est plane locale, centrée sur le premier point de la ligne.
 * Sur les 4 km d'un corridor, l'erreur est de l'ordre du centimètre pour une
 * marge de 30 m.
 */
export function nearPolylineFilter(
  polyline: readonly GeoPoint[],
  marginM: number,
): (geometry: readonly GeoPoint[]) => boolean {
  const origin = polyline[0];
  if (origin === undefined || polyline.length < 2) return () => false;
  const latScale = Math.cos((origin.lat * Math.PI) / 180);
  const project = (p: GeoPoint): PlanarPoint => ({
    x: (p.lon - origin.lon) * latScale * METRES_PER_DEG_LAT,
    y: (p.lat - origin.lat) * METRES_PER_DEG_LAT,
  });

  const line = polyline.map(project);
  const CELL_M = 100;
  const cells = new Map<string, number[]>();
  const cellKey = (cx: number, cy: number): string => `${cx},${cy}`;
  for (let i = 0; i + 1 < line.length; i += 1) {
    const a = line[i] as PlanarPoint;
    const b = line[i + 1] as PlanarPoint;
    const cxMin = Math.floor(Math.min(a.x, b.x) / CELL_M);
    const cxMax = Math.floor(Math.max(a.x, b.x) / CELL_M);
    const cyMin = Math.floor(Math.min(a.y, b.y) / CELL_M);
    const cyMax = Math.floor(Math.max(a.y, b.y) / CELL_M);
    for (let cx = cxMin; cx <= cxMax; cx += 1) {
      for (let cy = cyMin; cy <= cyMax; cy += 1) {
        const key = cellKey(cx, cy);
        const held = cells.get(key);
        if (held === undefined) cells.set(key, [i]);
        else held.push(i);
      }
    }
  }

  return (geometry) => {
    if (geometry.length === 0) return false;
    const pts = geometry.map(project);
    if (pts.length === 1) {
      const only = pts[0] as PlanarPoint;
      return nearSegments(only, only, marginM);
    }
    for (let i = 0; i + 1 < pts.length; i += 1) {
      if (nearSegments(pts[i] as PlanarPoint, pts[i + 1] as PlanarPoint, marginM)) return true;
    }
    return false;
  };

  function nearSegments(a: PlanarPoint, b: PlanarPoint, reachM: number): boolean {
    const cxMin = Math.floor((Math.min(a.x, b.x) - reachM) / CELL_M);
    const cxMax = Math.floor((Math.max(a.x, b.x) + reachM) / CELL_M);
    const cyMin = Math.floor((Math.min(a.y, b.y) - reachM) / CELL_M);
    const cyMax = Math.floor((Math.max(a.y, b.y) + reachM) / CELL_M);
    const seen = new Set<number>();
    for (let cx = cxMin; cx <= cxMax; cx += 1) {
      for (let cy = cyMin; cy <= cyMax; cy += 1) {
        const held = cells.get(cellKey(cx, cy));
        if (held === undefined) continue;
        for (const i of held) {
          if (seen.has(i)) continue;
          seen.add(i);
          const p = line[i] as PlanarPoint;
          const q = line[i + 1] as PlanarPoint;
          if (segmentDistance(a, b, p, q) <= reachM) return true;
        }
      }
    }
    return false;
  }
}

/** Distance minimale entre deux segments du plan, croisement = 0. */
function segmentDistance(a: PlanarPoint, b: PlanarPoint, c: PlanarPoint, d: PlanarPoint): number {
  if (segmentsCross(a, b, c, d)) return 0;
  return Math.min(
    pointToSegment(a, c, d),
    pointToSegment(b, c, d),
    pointToSegment(c, a, b),
    pointToSegment(d, a, b),
  );
}

function pointToSegment(p: PlanarPoint, a: PlanarPoint, b: PlanarPoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function segmentsCross(a: PlanarPoint, b: PlanarPoint, c: PlanarPoint, d: PlanarPoint): boolean {
  const side = (p: PlanarPoint, q: PlanarPoint, r: PlanarPoint): number =>
    (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const d1 = side(a, b, c);
  const d2 = side(a, b, d);
  const d3 = side(c, d, a);
  const d4 = side(c, d, b);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}
