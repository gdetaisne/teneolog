# Le métier derrière le moteur

Ce document explique le problème de terrain que Teneolog résout, la façon dont un logisticien
raisonne, et comment ce raisonnement est devenu du code. Chaque décision de conception est donnée
avec la raison de terrain qui l'a imposée : « on fait X parce que, sur le terrain, Y ».

---

## 1. Le problème de terrain

Un commercial vend un meuble, une cuve, une palette de carrelage. Le client donne une adresse. La
question qui coûte cher arrive **pendant l'appel** : *le camion passe-t-il ?*

Quand la réponse est fausse, l'addition est concrète :

- un 19 t arrive devant un virage qu'il ne peut pas prendre et repart chargé (le transport est
  payé deux fois, le client est perdu) ;
- un semi s'engage dans une impasse sans aire de retournement et doit ressortir en marche arrière
  sur 200 m, ce qu'un semi fait très mal ;
- par prudence, on envoie un petit porteur là où un gros passait : deux rotations au lieu d'une.

Le problème est né chez Ligerio (e-commerce, livraison d'objets lourds et volumineux). Le
logisticien d'expérience répond en deux minutes avec une carte et une vue aérienne. Le commercial,
lui, ne sait pas lire une carte comme un chauffeur. Teneolog met le raisonnement du logisticien
dans du code, pour que la réponse tombe pendant l'appel : **oui**, **non**, ou **à vérifier**,
toujours avec la raison.

Le moteur est **déterministe** : aucun modèle d'IA ne participe au verdict. Même adresse, même
version de policy, mêmes données mesurées → même verdict, au bit près.

---

## 2. Pourquoi un camion ne passe pas

Sur le terrain, les échecs se rangent en un petit nombre de familles. Le moteur a un mécanisme
dédié pour chacune.

| Cause | Ce qui se passe sur place | Où c'est traité |
|---|---|---|
| **Le gabarit** (hauteur, largeur, longueur) | Un pont bas, un porche, une rue plus étroite que la caisse plus les rétroviseurs. | Limites légales lues dans la BD TOPO et OSM (`maxheight`, `maxwidth`, `maxlength`), largeur mesurée ou déclarée de la voie. |
| **Les virages** | La cause n°1. En tournant, l'essieu arrière coupe à l'intérieur du virage (le *déport*). Un 19 t qui tourne à angle droit occupe bien plus que ses 2,55 m de large. | Cinématique du « modèle bicyclette » (`swept-path`), détection des virages sur l'itinéraire (`points`), jugement par gabarit (`projection`). |
| **La largeur** | Rarement seule en cause sur une ligne droite : un chauffeur passe un 19 t dans 3 m en sens unique. Elle devient décisive *dans* un virage ou un giratoire. | Largeur lue par bandes sur une droite, par la géométrie dans une courbe (voir §6). |
| **Les limites de poids** | Un pont limité à 12 t, un village interdit aux plus de 3,5 t. | Limites légales fusionnées BD TOPO ∪ OSM, la plus petite gagne. |
| **L'accès conditionnel** | « Sauf desserte locale » : interdit en transit, autorisé pour livrer. Le même panneau est légal au bout de l'itinéraire et illégal au milieu. | Lecture **positionnelle** de l'accès (approche, sortie ou transit). |
| **Les zones à faibles émissions (ZFE)** | Un camion trop ancien (vignette Crit'Air) n'a pas le droit d'entrer dans le périmètre, même s'il passe physiquement. | Base nationale consolidée des ZFE (BNZFE), comparée à la vignette du camion. |
| **L'impasse et le demi-tour** | Arriver n'est que la moitié du problème : il faut repartir. Sans aire de retournement mesurée, la marche arrière ou l'arrêt en amont deviennent la vraie question. | Topologie terminale (`topology`), planification de demi-tour (`swept-path`), arrêt de repli. |
| **L'approche, pas la route principale** | La départementale est presque toujours praticable. C'est le dernier kilomètre — le lotissement, le centre-bourg, le chemin rural — qui décide. | L'**ancre** (§3) : tout ce qui est en aval est contrôlé, point par point. |
| **La pente** | Un tire-palette ne retient pas une palette de 600 kg dans une pente à 10 %. | Pente mesurée à l'arrêt et sur le chemin à pied (altimétrie IGN) — un avertissement, jamais un refus. |

---

## 3. L'ancre : là où le camion quitte la route sûre

Un logisticien ne regarde pas l'itinéraire de bout en bout. Il cherche **l'endroit où le camion
quitte le réseau qu'on sait praticable** (une départementale, une route d'importance régionale)
pour entrer dans la desserte locale. À partir de là, tout compte ; avant, presque rien.

Cet endroit, c'est **l'ancre**. Le moteur reproduit ce geste :

1. il cherche autour de l'adresse le **réseau structurant** — une *classe* de route (importance
   BD TOPO), pas une largeur : une route large peut cacher un virage serré, une classe dit
   l'usage réel ;
2. il pose des ancres dans **plusieurs directions** réellement différentes (le camion peut venir du
   nord comme du sud) ;
3. de chaque ancre il dérive un **aller** (ancre → adresse) et un **retour** (adresse → ancre) ;
4. il mesure la rue de livraison, puis projette le balayage du camion sur chaque point critique
   de chaque jambe.

Entrée et sortie sont indépendantes : le camion peut arriver par une ancre et repartir par une
autre. La conclusion porte donc sur un **plan** (une entrante × une sortante, et la manœuvre à
l'arrêt entre les deux), pas seulement sur des allers-retours symétriques.

Si l'adresse est elle-même sur le réseau structurant, il n'y a pas d'itinéraire à chercher : le
point de livraison, la rue et l'arrêt suffisent.

---

## 4. Les huit étages, simplement

Un étage consomme des faits et produit des faits. Aucun étage n'appelle un autre ; le pipeline
les enchaîne et enregistre chaque sortie. Les étages S0 à S4 ne connaissent pas le camion.

| Étage | Question posée | Ce qu'un logisticien ferait | Paquet |
|---|---|---|---|
| **S0** Point de livraison | Où livre-t-on, et sur quelle rue ? | Il place le point sur la carte et choisit la bonne rue — pas la contre-allée, pas l'antenne en impasse qui porte le même nom. | `topology` (`street-selection.ts`), `pipeline` (`analyse.ts`) |
| **S1** Forme de la rue | La rue continue-t-elle, finit-elle en impasse, en boucle ? Où fait-on demi-tour ? | Il suit la rue au-delà de l'adresse pour voir si elle débouche. | `topology` (`dead-end.ts`, `turnaround.ts`, `handoff.ts`) |
| **S2** L'arrêt | Que mesure-t-on là où le camion s'arrête : largeur, pente, interdictions, ZFE ? | Il regarde la vue aérienne au point d'arrêt. | `constraints` |
| **S3** Itinéraires | Par où arrive-t-on, par où repart-on ? | Il cherche les ancres et trace les approches. | `routes` |
| **S4** Points critiques | Où, sur chaque itinéraire, la réponse peut-elle basculer ? | Il repère virages, giratoires, rues étroites, le demi-tour. | `points` |
| **S5** Projection | Ce camion-là passe-t-il à chacun de ces points ? | Il « pose » mentalement le camion dans chaque virage. | `projection` (pur, sans E/S) |
| **S6** Conclusion | Quelle est la réponse, et pourquoi ? | Il retient le meilleur plan et dit ce qui le décide. | `projection` (`plans.ts`, `ranking.ts`), `report` |
| **S7** Revue | Que demander à un humain, sur quelle image ? | Pour ce qu'il ne peut pas trancher sur carte, il demande une photo. | `scenes` |

**S5 est pur.** Demander « et avec un semi ? » ne refait aucune mesure : seule la projection est
rejouée sur les faits déjà acquis. C'est le test d'acceptation de l'architecture.

---

## 5. Les sources de données, et leurs limites

Toutes publiques, sauf deux services Google utilisés pour l'image et l'altitude.

| Source | Ce qu'on y lit | Limite connue, et ce qu'on en fait |
|---|---|---|
| **BAN** (Base Adresse Nationale, Géoplateforme) | Géocodage, suggestions d'adresse. | Un score bas peut désigner une autre ville : sous un seuil, le moteur refuse de deviner et s'arrête. |
| **IGN BD TOPO** (PostGIS auto-hébergé, WFS Géoplateforme) | Tronçons avec largeur, nombre de voies, importance, sens unique, limites légales, bâti. | Largeur *déclarée*, parfois ancienne ; tracé décalé d'OSM. Greffée sur OSM par correspondance géométrique, avec sa provenance. |
| **OpenStreetMap** (Overpass auto-hébergé) | Graphe routier, noms, `maxweight`, `hgv`, `access`, nœuds de retournement, giratoires. | Les étiquettes sont inégales ; une étiquette seule ne court-circuite jamais la mesure. |
| **OSRM** (auto-hébergé, profil voiture) | Les itinéraires candidats. | Un profil poids lourd élague les voies « sauf desserte » — celles où l'on livre. On garde le profil voiture : le routeur **propose**, la mesure **dispose**. |
| **BNZFE** | Périmètres et règles des zones à faibles émissions. | Une base indisponible rend un **inconnu**, jamais un « pas de zone ». |
| **IGN orthophotos** (WMS/WMTS) | Vue aérienne pour mesurer la chaussée et montrer la scène. | Date de prise de vue variable (lue et affichée) ; arbres, ombres, voitures garées. |
| **IGN RGE ALTI** | Altitudes pour la pente. | Résolution métrique : un avertissement, pas une mesure de chantier. |
| **Cadastre** (PCI vecteur), **RPG** | Domaine public au bout d'une impasse, parcelles agricoles. | Peut être décalé d'un ou deux mètres : dessiné, jamais lu pour décider. |
| **Google Street View / Elevation** | Vue « chauffeur » pour la revue humaine ; altitude de secours. | Coût par appel : utilisé seulement là où une question est posée. |

---

## 6. Les décisions de conception, et leur raison de terrain

| On fait… | … parce que, sur le terrain… |
|---|---|
| **Un inconnu n'est jamais un refus** : ce qui n'est pas mesuré devient une question (une photo à prendre), pas un « non ». | Un refus sur une donnée absente fait perdre une vente qui était possible. Un « oui » sur une donnée absente fait perdre un camion. Les deux sont des erreurs ; seule la question est honnête. |
| **On mesure la route une fois, sans camion ; on projette le camion à part.** | Le client demande souvent « et avec un plus gros ? ». La route n'a pas changé : refaire la mesure serait payer deux fois la même chose. |
| **Le routeur propose, la mesure dispose.** | Un profil poids lourd supprime les rues « sauf desserte locale », précisément celles où l'on livre. Un seul routage agnostique sert tous les camions ; la légalité est vérifiée ensuite, tronçon par tronçon. |
| **L'accès conditionnel se lit selon la position dans l'itinéraire.** | « Sauf desserte » est légal pour arriver chez le client, illégal pour couper par le village. |
| **Les limites légales de plusieurs sources : la plus petite gagne, chaque source reste visible.** | Une limite de poids présente dans OSM et absente de la BD TOPO existe quand même sur le panneau. Un désaccord entre sources est un fait, pas une moyenne. |
| **Une voie privée n'est pas une interdiction.** | Livrer dans une allée privée, à la demande du destinataire, est le cas normal. |
| **La largeur d'une droite se lit par bandes ; celle d'un virage, par la géométrie.** | Un chauffeur passe un 19 t dans 3 m en sens unique ; c'est dans les virages que les camions restent coincés. Douter sur une droite, c'est du bruit pour le commercial. |
| **Dans une manœuvre, la largeur requise est caisse + déport, sans marge de sécurité ajoutée ; le doute vient d'une bande de confort.** | Les marges de bordure et de stationnement sont faites pour une ligne droite : on ne se gare pas dans un carrefour. Ajouter un mètre partout faisait douter de virages que tout chauffeur prend. |
| **Le semi a sa propre bande de confort, plus large.** | Sortir un semi bloqué est très compliqué : on dégrade plus tôt. Il se juge tracteur + remorque (pivot de sellette), pas comme un porteur long. |
| **Les itinéraires se classent par le pire virage, pas par le nombre de points.** | Dix petits virages sont plus sûrs qu'un seul angle droit. Et à égalité, on préfère l'itinéraire sans inconnue. |
| **Quatre objets distincts : virage de carrefour, courbe, giratoire, section étroite.** | Un angle net se lit sur le tracé du routeur, un rayon sur la géométrie de la voie, une largeur par bras. Le routeur arrondit les coins : un rayon lu sur son tracé est inventé. |
| **La liste des manœuvres dépend du camion.** | Deux virages à 12 m sont deux manœuvres pour un fourgon et une seule pour un semi de 16,5 m. |
| **L'ancre est définie par une classe de route, pas par une largeur.** | Une largeur juste ne voit pas un virage. Mesuré en A/B : définir l'ancre par la largeur faisait taire des questions, dont une majorité portait sur des virages et des giratoires. Règle rejetée. |
| **Impasse : on établit toutes les issues avant de demander** (rue traversante proche, aire de retournement, marche arrière, arrêt de repli). | Le chauffeur ne choisit pas une issue au hasard ; l'opérateur non plus. On calcule tout, on ne choisit pas à sa place. |
| **L'arrêt de repli se mesure à pied, le long de la voie.** | À vol d'oiseau, une rue « à 100 m » peut être à 250 m de marche avec un chariot. Le portage se dit en clair au client. |
| **Un semi ne recule pas** dans le planificateur de demi-tour. | Un semi en marche arrière dans une rue étroite est une manœuvre que l'on n'impose pas. |
| **La pente est un avertissement pour le tire-palette, jamais un refus.** | Le camion arrive ; c'est la palette qui pose problème. |
| **Un jugement humain est enregistré par lieu, par sens et par gabarit — pas par analyse.** | La même adresse revient. Un virage validé une fois n'a pas à être redemandé. |
| **Une adresse de jury sert à voir, jamais à régler un seuil.** | Un seuil choisi pour faire passer une adresse casse les autres. Il vient de la physique, de la règle déjà éprouvée, ou d'une distribution mesurée sur tout le corpus. |
| **Tout changement de règle passe en silence, puis en A/B sur corpus, puis en activation, avec retour arrière en policy.** | Un verdict de production ne change jamais sans qu'on sache combien d'adresses basculent, lesquelles, et dans quel sens. |

---

## 7. Comment on vérifie

- **Le jury.** Des adresses réelles, relues avec la carte par quelqu'un qui connaît le terrain.
  Chaque désaccord devient un défaut nommé et un test. Les fixtures de ce dépôt (`thaire`, `la-creche`,
  `sevremoine`, `clichy`, `auxerre`, `clamart`) en sont issues — anonymisées : noms de voies remplacés,
  numéros changés, longitudes décalées d'une constante (ce qui laisse distances et caps
  rigoureusement intacts).
- **Les tests d'or.** Un comportement validé sur le terrain est figé : par exemple, sur le même coin
  de rue, le fourgon passe, le 19 t reste une question, le semi doute
  (`packages/projection/test/thaire-corner-golden.test.ts`).
- **Les tests de silence.** Un mécanisme livré éteint ne doit rien changer en aval, au bit près
  (`packages/pipeline/test/*-silence.test.ts`, `full-*.test.ts`).
- **L'A/B sur corpus.** Avant d'activer une règle, on la joue sur tout le corpus et on lit chaque
  verdict qui bascule. Critère d'activation : *aucun OK → NON inexpliqué*.
- **Le déterminisme.** Un seul instant d'acquisition par run, des identités de points stables
  (type + lieu arrondi), aucune source non déterministe dans le verdict.

---

## 8. Mécanismes en silence

Un mécanisme « en silence » est livré éteint : il tourne à côté, ou attend son A/B. Chacun doit
être nommé ici avec sa décision, sinon la CI refuse (`npm run silence:check`).

| Drapeau (policy) | État | Décision |
|---|---|---|
| `routes.dedup` | éteint | Dédoublonnage géométrique des itinéraires candidats. A/B du 2026-09-14 : levé seul, il ne change rien (le routeur ne rend jamais deux fois exactement le même tracé). Gardé éteint, à retirer ou à fondre dans la variante suivante. |
| `routes.dedup.approach` | éteint | Dédoublonnage par la *signature d'approche* (deux ancres qui arrivent par la même rue). A/B du 2026-09-14 : −25 % de temps de phase 2, aucun verdict changé — mais des centaines de questions et des dizaines de refus *documentés* disparaîtraient. Ne pas lever en l'état : ce qui disparaît, ce sont les questions qui justifient le verdict. |
| `phase2.stopBetweenBatches` | éteint | Arrêter la phase 2 entre deux lots dès qu'un plan est sûr. Éteint le 2026-09-12 : on n'est pas à une seconde près, la qualité prime. |

---

## 9. Vocabulaire

| Mot | Sens |
|---|---|
| **point de livraison** | le point géocodé (ou cliqué) où l'on livre |
| **rue de livraison** | la voie sur laquelle on livre, choisie parmi les voies étudiées |
| **ancre** | point du réseau structurant par lequel le camion entre dans le secteur ou en sort |
| **jambe** | un trajet entre une ancre et le point de livraison, dans un sens |
| **paire / plan** | aller + retour par la même ancre / par deux ancres différentes |
| **point critique** (point de passage) | un lieu où la réponse peut basculer : virage, courbe, giratoire, rue étroite, demi-tour, destination |
| **déport** | l'écart entre la trajectoire de l'avant et celle de l'arrière dans un virage |
| **bande de confort** | la marge sous laquelle une géométrie qui passe « sur le papier » devient une question |
| **arrêt de repli** | s'arrêter avant l'impasse et porter à pied |
| **portage** | la distance à pied de l'arrière du camion au seuil du bâtiment |

### Principes cités dans le code

Les commentaires du code renvoient à des principes numérotés. Les plus fréquents :

| N° | Principe |
|---|---|
| 5 | Un inconnu n'est jamais un refus, et ne devient jamais un verdict à l'écran. |
| 7 | L'ancre est le point du réseau sûr ; toute l'approche en aval est contrôlée. |
| 10 | Impasse : on établit toutes les issues avant de demander. |
| 14 | Une donnée absente s'affiche comme absente : pas de confiance fabriquée. |
| 17 | En silence → A/B sur corpus → activation → retour arrière en policy. |
| 22 | Tout mécanisme « en silence » a une date de décision (§8). |
| 23 | Une seule source de vérité par règle : une formule vit à un endroit et s'exporte. |
| 25 | Des gardes mécaniques plutôt que de la vigilance (cliquets de CI). |
| 26 | Construire pour le long terme : fichier ≤ 600 lignes, fonction ≤ 80, complexité ≤ 12, imbrication ≤ 4 ; l'existant est gelé et ne peut que maigrir. |
| 27 | La largeur seule n'est presque jamais le problème ; les virages, si. |
| 28 | Classer les itinéraires par le pire virage, puis par l'absence d'inconnue. |
| 29 | Le moteur d'origine est la spécification de ce qui a déjà été pensé : on le relit avant de changer une règle. |
| 30 | Une adresse sert à voir, jamais à régler un seuil. |
| 31 | Dans une manœuvre, marge de sécurité nulle ; le doute vient de la bande de confort. Le semi a la sienne. |
| 32 | Largeur d'une droite par bandes, d'une courbe par la géométrie. |
| 33 | La liste des manœuvres est propre au camion. |
| 34 | Le réseau structurant (une classe, pas une largeur) définit l'ancre. |
| 39 | Impasse : on demande d'abord le lieu de demi-tour s'il n'est pas certain. |
| 41 | Valider un virage valide la largeur des rues qui y entrent et en sortent. |
| 42 | La carte donne l'échelle, l'opérateur tranche. |
