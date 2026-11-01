# Rainbow Filter

Userscript qui filtre les résultats de recherche Vinted par **combinaisons de couleurs** : le filtre du site fait « bleu OU rouge », le script garde seulement « bleu ET rouge ».

Projet personnel, non affilié à Vinted.

## Installation

1. Installer [Tampermonkey](https://www.tampermonkey.net/) (Chrome 138+ : `chrome://extensions` → Tampermonkey → Détails → « Autoriser les scripts utilisateur »).
2. Ouvrir [rainbow-filter.user.js](https://raw.githubusercontent.com/Timi-Duban/rainbow-filter/main/rainbow-filter.user.js) et cliquer sur **Installer**. Tampermonkey vérifie ensuite les mises à jour tout seul.

## Utilisation

Sur une page de recherche, un onglet 🌈 sur le bord droit affiche le nombre d'articles trouvés et la progression. Un clic ouvre le tiroir ; ✕, Échap ou un clic sur la page le replie.

- **Filtrer** (interrupteur en haut) : active ou désactive le filtre.
- **Combinaisons** : un article est affiché s'il a toutes les couleurs d'*au moins une* combinaison (2 couleurs max : un vendeur en renseigne au plus 2). Les grilles Couleur 1 × Couleur 2 créent toutes les paires : {Rouge, Bordeaux} × {Vert, Jaune} = 4 combinaisons. Entrée ajoute. Sans combinaison, les 2 couleurs cochées sur le site servent de combinaison.
- **Inclure les nuances** : une couleur accepte aussi ses nuances (Bleu → Bleu clair, Marine, Turquoise…). « Modifier » permet de les changer pour chaque couleur.

Chaque nouvel onglet repart de zéro : filtre désactivé, aucune combinaison. Ajouter une combinaison active le filtre ; un rechargement de l'onglet le conserve. Seuls les réglages de nuances sont mémorisés (dans le navigateur, propres à chaque ordinateur).

## Limites

- Les couleurs sont lues sur chaque page article (`itemprop="color"`), une requête par article. Le site renvoie 429 après ~55 requêtes : pause d'une minute, puis reprise automatique. Compter plusieurs minutes par page de 100 résultats.
- Libellés de couleur en français : fonctionne sur les sites .fr / .be / .lu.

## Licence

MIT
