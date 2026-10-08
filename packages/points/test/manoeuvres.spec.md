# Manœuvres — l'attendu chiffré, cas par cas

**Ce fichier est une spécification, pas un test.** Il dit ce que les fixtures de
`test/fixtures/manoeuvres/` doivent produire quand le modèle de la note de conception interne sera
écrit. La tâche qui l'implémentera le transformera en `manoeuvres.test.ts` ; il est en Markdown
parce que la moitié de l'attendu porte sur des sorties qui **n'existent pas encore** (le rayon
ajusté sur la voie, les largeurs par bras, la fusion par longueur de camion) et qu'un `.test.ts`
qui les nomme ne compilerait pas.

Chaque cas donne, dans l'ordre : **ce que 408 produit aujourd'hui** (mesuré, pas supposé), puis
**ce que le modèle attend**. L'écart est le travail.

## Les conventions

- Coordonnées des fixtures : **mètres locaux** `[est, nord]` depuis `origine`. Conversion dans
  chaque fichier (`noteCoordonnees`) : `lat = 46 + nord/111320`, `lon = est/77327,6`.
- Marge = largeur disponible − largeur requise. `band` (`projection/src/evaluators.ts`) :
  `< 0` → **NON**, `[0 ; 0,40[` → **HUMAIN** (doute), `≥ 0,40` → **OK**.
- **Toutes les largeurs des fixtures sont déclarées** (`width=*`), donc **tout NON de largeur
  devient un doute** (`unmeasured_width_cannot_refuse`). Les tableaux donnent la marge brute et le
  verdict « si mesurée » ; ajouter mentalement « → doute » partout où la largeur reste déclarée.
  Seul le NON **de rayon** (R sous le braquage) ne se convertit pas : il ne dépend d'aucune largeur.
- Gabarits : Fourgon (2,10 / 3,70 / R 7 / 6,0 m), Porteur 19 t (2,50 / 6,10 / R 11 / 9,0 m),
  Semi 44 t **catalogue** (2,55 / 3,90 / R 15 / 16,5 m) et Semi 44 t **avec remorque**
  (empattement de déport 7,70 m — la bonne valeur, `kingPinToRearAxleMeters` de l'engine).
- Marge de manœuvre : `turnSweptClearanceM` = 1,0 m (valeur d'aujourd'hui ; question 1 de la fiche).
- Tolérances : angles ±1°, rayons ±2 %, largeurs ±0,02 m.

---

## M1 — l'angle au nœud · `m1-carrefour.json`

Trois variantes au même nœud N (0,0), degré 3, entrée 5,2 m. Le tracé du routeur **chanfreine**
le coin sur 6 m : trois sommets, aucun ne porte seul la déflexion.

### Aujourd'hui (408)

| variante | genre | angle net | apexShare | rayon publié |
|---|---|---|---|---|
| M1-a 45° | **courbe** ✗ | 45,0° | **0,42** | 38,6 m (corde) |
| M1-b 90° | **courbe** ✗ | 90,0° | **0,48** | 16,0 m (corde) |
| M1-c 135° | carrefour ✓ | 135,0° | 0,83 | aucun ✓ |

> Deux vrais carrefours sur trois sont lus comme des courbes, et « courbe » est la lecture
> clémente. `apexShare` mesure combien le routeur a arrondi le coin, pas s'il y a un carrefour.

### Attendu

| | M1-a | M1-b | M1-c |
|---|---|---|---|
| genre | `junction` | `junction` | `junction` |
| angle net | 45° ± 1 | 90° ± 1 | 135° ± 1 |
| rayon publié | **aucun** | **aucun** | **aucun** |
| largeur d'entrée | 5,2 m (Rue d'Arrivée) | 5,2 m | 5,2 m |
| largeur de sortie | **5,0 m** (Rue de Sortie) | **4,0 m** | **4,0 m** |
| degré du nœud | 3 | 3 | 3 |
| jugé contre | la **sortie** | la **sortie** | la **sortie** |
| inconnues | aucune | aucune | aucune |

| gabarit | M1-a requis / marge | M1-b requis / marge | M1-c requis / marge |
|---|---|---|---|
| Fourgon | 3,63 / **+1,37** OK | 4,16 / −0,16 NON | 4,16 / −0,16 NON |
| **19 t** | 4,42 / **+0,58** OK | 5,35 / **−1,35** NON | 5,35 / **−1,35** NON |
| Semi (catalogue) | 3,81 / +1,19 OK | 4,07 / −0,07 NON | 4,07 / −0,07 NON |
| Semi (remorque) | 4,61 / +0,39 doute | 5,68 / −1,68 NON | 5,68 / −1,68 NON |

M1-c doit rendre **exactement** M1-b : au-delà de 90° le déport plafonne.

---

## M2 — la courbe entre nœuds · `m2-courbe.json`

Arc de **30 m** de rayon, 60° balayés, une seule voie de 4,5 m, sommets tous les 4 m, tangentes
exactes aux deux bouts.

### Aujourd'hui (408)

genre `courbe` ✓ (apexShare 0,50), angle net 60,0°, **rayon 47,3 m** par la corde de la fenêtre.
Requis 19 t **3,89 m** → marge **+0,61 → OK**. Le rayon est 58 % trop grand et le doute disparaît.

### Attendu

| | valeur |
|---|---|
| genre | `curve` |
| angle balayé | 60° ± 1 — **publié, et n'entre dans aucun calcul de largeur** |
| rayon | **30,00 m ± 0,5**, par ajustement de cercle sur les **sommets de la voie**, sur l'étendue de la courbure (indices 2 à 10) |
| rms de l'ajustement | ≤ 0,05 m (mesuré : 0,002 m) |
| sommets utilisés | 9 |
| largeur | 4,5 m, déclarée |
| inconnues | aucune |

| gabarit | requis | marge | verdict si mesurée |
|---|---|---|---|
| Fourgon | 3,33 m | +1,17 | OK |
| **19 t** | **4,13 m** | **+0,37** | **doute** |
| Semi (catalogue) | 3,80 m | +0,70 | OK |
| Semi (remorque) | 4,56 m | −0,06 | NON |

**Garde à tester** : un ajustement sur une **fenêtre fixe de 50 m autour de l'apex** (la règle
telle quelle de `fitCurveRadiusFromIgnGeometry`) attrape les droites voisines, rend 11 m avec un
rms de 9,7 m, et se fait rejeter par sa propre garde des 8 m. Le fenêtrage doit suivre **l'étendue
de la courbure**, pas une distance.

---

## M3 — courbe serrée, épingle, demi-tour · `m3-epingle.json`

### Aujourd'hui (408)

| variante | genre | angle net | rayon | verdict 19 t |
|---|---|---|---|---|
| M3-a épingle R = 8 m, 170° | courbe ✓ | 170,0° | 8,87 m (corde) | NON, marge −2,13 m |
| M3-b demi-tour R = 3 m, 180° | courbe ✓ | **180,0°** | **`null`** — la garde `net ≥ 180` | **HUMAIN**, « rayon non établi » |
| M3-c coin 150° chanfreiné | carrefour ✓ | 150,0° | aucun ✓ | NON, marge −1,35 m ✓ |

> M3-b est le piège : à 180,0° le rayon est `null` et le demi-tour devient une inconnue ; à 179°
> il vaut 3,0 m et devient un NON à −8 m. Le verdict bascule sur un dixième de degré.

### Attendu

| | M3-a | M3-b | M3-c |
|---|---|---|---|
| genre | `curve` | `curve` | `junction` |
| angle net / balayé | 170° | 180° | 150° |
| rayon | **8,00 m ± 0,2** (17 sommets, rms 0,002 m) | **3,00 m ± 0,1** (13 sommets, rms 0,002 m) | **aucun** |
| ajustement sur la voie | propre | propre | **impossible** — la voie n'a aucun sommet dans le coin |
| largeur | 4,0 m | 4,0 m | sortie 4,0 m |

| gabarit | M3-a | M3-b | M3-c |
|---|---|---|---|
| Fourgon | requis 4,01 / **−0,01** NON | **R < 7 m → NON**, marge **−4,0 m** (rayon) | requis 4,16 / −0,16 NON |
| **19 t** | **R < 11 m → NON**, marge **−3,0 m** (rayon) | **R < 11 m → NON**, marge **−8,0 m** (rayon) | requis **5,35** / −1,35 NON |
| Semi (catalogue) | R < 15 → NON, −7,0 m | R < 15 → NON, −12,0 m | 4,07 / −0,07 NON |
| Semi (remorque) | R < 15 → NON, −7,0 m | R < 15 → NON, −12,0 m | 5,68 / −1,68 NON |

**La réponse à « un U-turn de 3 m »**, en une ligne par objet :
- M3-b (vrai lacet, mesuré sur la voie) → **NON à −8,0 m** pour un 19 t, et c'est un vrai NON ;
- M3-c (le même « rayon » vu au coin d'un carrefour) → **carrefour 150°, aucun rayon**, jugé à
  5,35 m contre la rue de sortie ; **jamais** un NON à −8 m ;
- un demi-tour **à l'arrêt** n'est pas ici : c'est `TURNAROUND`, diamètre utilisable contre
  2 × R_braquage + 2,0 m (16,0 / **24,0** / 32,0 m).

**Garde** : un rayon sous le braquage n'est un NON que si l'ajustement est propre — ≥ 5 sommets,
rms sous le seuil, rayon sous le plafond. Sinon, **inconnue** (principe 5). Le test doit couvrir
les deux branches : une épingle propre refuse, un zigzag à trois sommets escalade.

---

## M4 — deux virages rapprochés · `m4-enchainements.json`

### Aujourd'hui (408)

| variante | écart | ce qui est posé |
|---|---|---|
| M4-a 45° + 45°, même sens | 8 m | **une** manœuvre, angle net 90° ✓, mais genre **courbe** ✗ (apexShare 0,50), rayon 15,7 m |
| M4-b 60° + 60°, sens opposés (S) | 7 m | **rien du tout** — chaque cap de sortie est lu 10 m plus loin, donc au-delà du second virage, et le net retombe à 43° < 45° |
| M4-c 70° + 70°, même sens | 30 m | deux carrefours 70° ✓, `chainedWithPreviousM = 30` **calculé et lu par personne** |

### Attendu

**La borne de fusion est la longueur du camion.** S4 publie l'écart, S5 fusionne.

| écart | Fourgon (6,0 m) | 19 t (9,0 m) | Semi (16,5 m) |
|---|---|---|---|
| M4-b, 7 m | 2 manœuvres | **1 manœuvre** | **1 manœuvre** |
| M4-a, 8 m | 2 manœuvres | **1 manœuvre** | **1 manœuvre** |
| M4-c, 30 m | 2, chaînées | 2, chaînées | 2, chaînées |

**M4-a — même sens, fusionné à 90°** (sortie 4,5 m). Additionner les déports revient à cumuler
les angles : `déport(45°) + déport(45°) = déport(90°)`.

| gabarit | fusionné | non fusionné (2× 45°) |
|---|---|---|
| Fourgon | — | 3,63 m ; marges +1,37 (sortie 5,0) et **+0,87** (sortie 4,5) → OK |
| **19 t** | requis **5,35 m**, marge **−0,85** | *(n'existe pas : 8 m < 9 m)* |
| Semi (catalogue) | 4,07 m, +0,43 OK | — |
| Semi (remorque) | 5,68 m, **−1,18** | — |

**M4-b — le S** (voie 5,0 m des deux côtés). Déflexion **nette nulle** : une fusion par angle net
efface la manœuvre. La fusion se fait sur la **somme des déports en valeur absolue**, et le signe
dit seulement qu'il faut la place des **deux côtés**.

| gabarit | lecture | requis | marge |
|---|---|---|---|
| Fourgon | 2 manœuvres de 60° | 3,81 m chacune | +1,19 → OK |
| **19 t** | **1 manœuvre**, ΣOT = 1,23 + 1,23 | **5,96 m** | **−0,96** |
| Semi (catalogue) | 1 manœuvre | 4,24 m | +0,76 OK |
| Semi (remorque) | 1 manœuvre | **6,39 m** | **−1,39** |

Un S serré demande **plus** qu'un angle droit (5,96 contre 5,35 pour un 19 t) : c'est la seule
exception à « dix petits virages sont plus sûrs qu'un 90° ».

**M4-c — chaînées** (sorties 5,0 m). Deux manœuvres de 70°, `chainedWithPreviousM = 30 m` (< 40 m).
La largeur requise **ne change pas** ; c'est la sévérité qui monte (R-S, facteur à trancher).

| gabarit | requis (chacune) | marge |
|---|---|---|
| Fourgon | 3,92 m | +1,08 OK |
| **19 t** | **4,94 m** | **+0,06** doute |
| Semi (catalogue) | 3,95 m | +1,05 OK |
| Semi (remorque) | 5,20 m | −0,20 NON |

---

## M5 — le giratoire réel · `m5-giratoire.json`

Anneau `junction=roundabout`, rayon d'axe **12,00 m**, quatre bras de 5,0 m, anneau **déclaré à
4,0 m**.

| | M5 (sud → ouest) | M5-c (sud → est) | M5-b (sans `width`) |
|---|---|---|---|
| rayon d'axe | 12,00 m ± 0,1 | 12,00 m | 12,00 m |
| balayage | **265°** ± 2 | **95°** ± 2 | 265° |
| largeur d'anneau | 4,0 m, **déclarée** | 4,0 m | **inconnue** |
| nombre de bras | 4 | 4 | 4 |
| virages posés sur l'anneau | **aucun** (absorbés) | aucun | aucun |

| gabarit | rayon roulé | anneau requis | marge (M5 **et** M5-c) | M5-b |
|---|---|---|---|---|
| Fourgon | 12,0 m | 3,68 m | **+0,32** doute | HUMAIN `roundabout_annulus_unmeasured` |
| **19 t** | 12,0 m | **5,17 m** | **−1,17** → doute (déclarée) | HUMAIN |
| Semi (catalogue) | 15,0 m | 4,07 m | −0,07 → doute | HUMAIN |
| Semi (remorque) | 15,0 m | 5,68 m | −1,68 → doute | HUMAIN |

**Les deux invariants du cas** : (1) M5 et M5-c ont des balayages qui vont du simple au triple et
**la même largeur requise** — le balayage n'entre pas dans la largeur ; (2) M5-b ne refuse
personne — une inconnue n'est jamais un refus.

---

## M6 — ce qui n'est pas une manœuvre · `m6-artefacts.json`

**Attendu, pour les quatre : zéro point posé.**

| variante | aujourd'hui | attendu | par quelle règle |
|---|---|---|---|
| M6-a raccordement au départ (segment de 4 m à 90°, sommet à 4 m de l'origine) | **manœuvre de −90° posée** ✗ | rien | segment < 8 m **et** déplacement cumulé < 12 m depuis l'origine, **dans les deux sens** |
| M6-b sommet répété | rien ✓ | rien | `withoutDegenerateSegments` (5 cm) |
| M6-c zigzag ±1,5 m tous les 5 m | rien ✓ | rien | déflexions alternées, aucun run ; et un ajustement au rms trop grand n'est pas un rayon |
| M6-d courbe R = 150 m, 50° balayés | rien ✓ **mais pour la mauvaise raison** (la fenêtre de 40 m coupe le run avant 45°) | rien | **rayon ajusté 149,99 m** (rms 0,002 m) > seuil d'indifférence → aucun point |

M6-d est le test qui compte : il doit rester muet **après** que la fenêtre ait cessé de tronquer
les longues courbes, c'est-à-dire pour la bonne raison. Si le seuil d'indifférence passe de 60 à
75 m (fiche §11), M6-d reste muet et une courbe de 60 m ne l'est plus pour le semi.

---

## Les invariants transversaux

À vérifier sur **toutes** les fixtures, pas cas par cas :

1. **Un virage de carrefour ne publie jamais de rayon ; une courbe en publie toujours un.**
   (Déjà tenu par `jury-thaire.test.ts`.)
2. **Une largeur déclarée ou estimée ne refuse jamais.** Tout NON de largeur sur une fixture
   (elles sont toutes déclarées) doit ressortir en HUMAIN avec
   `unmeasured_width_cannot_refuse`. Un NON **de rayon** n'est pas concerné.
3. **Symétrie arrivée / départ.** Chaque fixture jouée à l'envers doit rendre les mêmes
   manœuvres, aux mêmes endroits — sauf l'artefact de raccordement, qui doit être écarté **aux
   deux bouts**.
4. **Aucune valeur ne vient d'une adresse.** Ces six fixtures sont synthétiques ; Thairé sert à
   voir (`jury-thaire.test.ts`), jamais à régler un seuil (principe 30).
