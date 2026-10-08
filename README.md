# Teneolog — le moteur

**Teneolog dit à un commercial, pendant l'appel, si un camion (fourgon, porteur 19 t, semi)
peut livrer une adresse.** Réponse : *oui*, *non* ou *à vérifier*, toujours avec la raison.
Le moteur est déterministe — aucun modèle d'IA dans le verdict : il reproduit en code le
raisonnement d'un logisticien. → [teneolog.com](https://teneolog.com)

Ce dépôt est un **instantané public du moteur** (12 paquets TypeScript et leurs tests). L'API,
le front et les seuils calibrés restent privés.

---

## Ce que ce dépôt montre

**1. Une culture large : géométrie, cartographie, graphes routiers, données publiques.**

| Domaine | Où le voir |
|---|---|
| Géocodage BAN (Géoplateforme) | [`adapters/src/ban-geocoder.ts`](packages/adapters/src/ban-geocoder.ts) |
| IGN BD TOPO (PostGIS + WFS), greffe de ses largeurs sur le graphe OSM | [`adapters/src/bdtopo.ts`](packages/adapters/src/bdtopo.ts), [`topology/src/attribution.ts`](packages/topology/src/attribution.ts), [`adapters/src/grafted.ts`](packages/adapters/src/grafted.ts) |
| OpenStreetMap / Overpass (cache, dédoublonnage en vol, erreurs typées) | [`adapters/src/overpass.ts`](packages/adapters/src/overpass.ts), [`adapters/test/network-failures.test.ts`](packages/adapters/test/network-failures.test.ts) |
| Routage OSRM, puis annotation légale tronçon par tronçon | [`adapters/src/osrm.ts`](packages/adapters/src/osrm.ts), [`routes/src/annotate.ts`](packages/routes/src/annotate.ts) |
| Zones à faibles émissions (BNZFE) vs vignette Crit'Air | [`adapters/src/bnzfe.ts`](packages/adapters/src/bnzfe.ts) |
| Orthophotos IGN, millésime de prise de vue, altimétrie RGE ALTI | [`adapters/src/ign-ortho.ts`](packages/adapters/src/ign-ortho.ts), [`ign-ortho-capture.ts`](packages/adapters/src/ign-ortho-capture.ts), [`ign-altimetry.ts`](packages/adapters/src/ign-altimetry.ts) |
| Cadastre (domaine public), RPG | [`adapters/src/cadastre-parcels.ts`](packages/adapters/src/cadastre-parcels.ts), [`rpg-fields.ts`](packages/adapters/src/rpg-fields.ts) |
| Street View / Elevation (revue humaine, pente) | [`adapters/src/google-street-view.ts`](packages/adapters/src/google-street-view.ts), [`google-elevation.ts`](packages/adapters/src/google-elevation.ts) |
| Réseau structurant par classe d'importance, anneaux et secteurs | [`routes/src/axes-network.ts`](packages/routes/src/axes-network.ts), [`axes-select.ts`](packages/routes/src/axes-select.ts), [`axes-rings.ts`](packages/routes/src/axes-rings.ts) |

**2. Des modules creusés jusqu'au détail.** Trois exemples, chacun avec ses tests :

- **Balayage du camion et demi-tour** — modèle bicyclette exact à l'essieu arrière
  (Rr = √(R² − L²)), tractrice pour l'articulé (sellette → essieu), demi-tour en trois temps à
  contact en forme close, planificateur A\* avec heuristique de Dubins dans un espace de forme
  quelconque.
  [`kinematics.ts`](packages/swept-path/src/kinematics.ts) ·
  [`chain-tracking.ts`](packages/swept-path/src/chain-tracking.ts) ·
  [`three-point.ts`](packages/swept-path/src/three-point.ts) ·
  [`turnaround-plan.ts`](packages/swept-path/src/turnaround-plan.ts) —
  tests : [`three-point.test.ts`](packages/swept-path/src/three-point.test.ts),
  [`turnaround-plan.test.ts`](packages/swept-path/src/turnaround-plan.test.ts),
  [`chain-tracking.test.ts`](packages/swept-path/src/chain-tracking.test.ts).
- **Projection pure camion × route** — un évaluateur par type de point, gate de confiance
  symétrique (un NON douteux devient une question, comme un OUI douteux), légalité positionnelle
  (« sauf desserte » légal en approche, illégal en transit), plans entrée × sortie classés par le
  pire virage.
  [`evaluators.ts`](packages/projection/src/evaluators.ts) ·
  [`legal.ts`](packages/projection/src/legal.ts) ·
  [`plans.ts`](packages/projection/src/plans.ts) ·
  [`ranking.ts`](packages/projection/src/ranking.ts) —
  tests d'or : [`thaire-corner-golden.test.ts`](packages/projection/test/thaire-corner-golden.test.ts)
  (même coin, deux jambes, trois gabarits, verdicts au dixième),
  [`semi-articulated.test.ts`](packages/projection/test/semi-articulated.test.ts).
- **Mesure de la largeur de chaussée sur orthophoto (D10)** — profil transversal, candidats de
  bordure pondérés, garde-fous de plateau saturé, recalage sur la BD TOPO ; et la fusion des
  limites légales de toutes les sources (la plus petite gagne, chaque source reste visible).
  [`d10v2-simple.ts`](packages/road-width/src/d10v2-simple.ts) ·
  [`kerb-candidate-score.ts`](packages/road-width/src/kerb-candidate-score.ts) ·
  [`plateau-safety.ts`](packages/road-width/src/plateau-safety.ts) ·
  [`legal-bands.ts`](packages/constraints/src/legal-bands.ts) —
  tests : [`d10v2-simple.test.ts`](packages/road-width/src/d10v2-simple.test.ts),
  [`plateau-safety.test.ts`](packages/road-width/src/plateau-safety.test.ts),
  [`legal-bands.test.ts`](packages/constraints/test/legal-bands.test.ts).

**3. Des contrôles structurés, tenus par la CI.**

- TypeScript strict avec `exactOptionalPropertyTypes` et `noUncheckedIndexedAccess`
  ([`tsconfig.base.json`](tsconfig.base.json)) ; build par références de projets.
- **Cliquet de taille et de complexité** : fichier ≤ 600 lignes, fonction ≤ 80, complexité ≤ 12,
  imbrication ≤ 4 ; l'existant est gelé et ne peut que maigrir
  ([`scripts/lint-ratchet.mjs`](scripts/lint-ratchet.mjs), [`eslint-baseline.json`](eslint-baseline.json)).
- **Cliquet des exports morts** (knip) ([`scripts/knip-ratchet.mjs`](scripts/knip-ratchet.mjs)).
- **Inventaire des modes en silence** : tout drapeau éteint doit être nommé et daté
  ([`scripts/silence-inventory.mjs`](scripts/silence-inventory.mjs)).
- **Tests d'or et tests de silence** : une règle livrée éteinte ne change rien en aval, au bit
  près ([`pipeline/test/full-discovery.test.ts`](packages/pipeline/test/full-discovery.test.ts),
  [`fallback-stop-silence.test.ts`](packages/pipeline/test/fallback-stop-silence.test.ts)).
- **Déterminisme** : un seul instant d'acquisition par run
  ([`pipeline/test/full.test.ts`](packages/pipeline/test/full.test.ts)), identités de points
  stables par type et lieu ([`points/src/point-ref.ts`](packages/points/src/point-ref.ts)).
- Workflow : [`.github/workflows/ci.yml`](.github/workflows/ci.yml). Dans l'application complète
  s'ajoutent un budget de poids du bundle front et un build Docker avec test de santé.

**4. Du métier, pas seulement du code généré.** [`docs/METIER.md`](docs/METIER.md) explique le
problème de terrain, pourquoi les camions échouent (gabarit, virages, largeur, poids, accès
conditionnel, ZFE, impasse), ce qu'est une ancre, les huit étages, les limites de chaque source
de données, et chaque décision de conception avec sa raison de terrain. Les commentaires du code
renvoient à ces principes et aux cas réels (anonymisés) qui les ont imposés.

---

## Architecture

> **Mesurer la route une fois, sans camion. Projeter le camion purement.**

Huit étages, un paquet par étage. Chaque étage consomme et produit des **faits** typés
(`Fact<T>` : valeur, provenance, fiabilité — ou `known: false` avec la raison). Un inconnu reste
un inconnu jusqu'au verdict, où il devient une question, jamais un refus.

```
S0 point de livraison ─ S1 forme de la rue ─ S2 l'arrêt ─ S3 itinéraires (ancres)
        topology             topology          constraints        routes
                                                                     │
S7 revue humaine ◄── S6 conclusion ◄── S5 projection (pure) ◄── S4 points critiques
     scenes          projection·report       projection                points

domain    : le vocabulaire, sans dépendance          pipeline : l'enchaînement, sur ports injectés
adapters  : le SEUL paquet qui fait du réseau         swept-path, road-width : cœurs de calcul
```

- **S0–S4 ne connaissent pas le camion** : elles sont coûteuses (réseau, imagerie) et mises en
  cache par lieu. **S5–S6 sont pures** : changer de camion rejoue la projection, rien d'autre.
- **Les adaptateurs isolent les E/S** : chaque source est un port (`RoadGraphPort`,
  `RoutingPort`, `GeocodePort`…) avec une implémentation réelle et des doublures en test.
- **Une seule policy versionnée** porte les paramètres métier ; chaque run enregistre sa
  version. Exemple de forme : [`config/policy.example.json`](config/policy.example.json)
  (valeurs d'exemple, les seuils calibrés restent privés).

---

## Chiffres

| | Cet instantané (mesuré) | Application complète (privée) |
|---|---|---|
| Lignes de code produit (TS) | 45 566 (201 fichiers, `packages/*/src`) | ~130 600 |
| Lignes de tests (TS) | 32 665 (133 fichiers) | ~67 700 |
| Ratio tests / produit | 0,72 | ~0,52 |
| Cas de test | 1 408, tous verts | ~3 800 |
| Paquets | 12 | 13 paquets + API + front + service « chargeur » |
| Historique | un seul commit (instantané) | 1 017 commits, août → octobre 2026 |

L'application complète ajoute l'API (Fastify), le front opérateur (Next.js), la génération du
PDF de preuve et le service de fiche pour les chargeurs.

---

## Lancer les tests

```bash
npm ci && npm test        # compile tout le graphe (tsc -b), puis Vitest dans chaque paquet
npm run lint              # cliquet de taille et de complexité
npm run knip:check        # cliquet des exports morts
npm run silence:check     # inventaire des modes en silence
```

Node ≥ 22. Aucun test n'appelle le réseau : les fixtures sont des extraits enregistrés
(OSM, BAN, BD TOPO), anonymisés — noms de voies remplacés, numéros changés, longitudes décalées
d'une constante, ce qui laisse distances et caps intacts.

---

## Comment c'est construit

Construit avec des agents IA, sous ma direction : spécifications, revue, tests.

---

**Guillaume Stehelin de Taisne** · [teneo-services.com](https://teneo-services.com)
Ancien DAF puis directeur général d'une entreprise d'e-commerce (10 M€), j'accompagne aujourd'hui
des dirigeants de PME. Teneolog est né d'un problème que j'ai vécu chez Ligerio.

Licence : tous droits réservés, lecture et évaluation seulement — voir [LICENSE](LICENSE).
