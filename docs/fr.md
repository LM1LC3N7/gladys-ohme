# Ohme pour Gladys

Affiche votre borne de recharge **Ohme** (Home, Home Pro, ePod ; Royaume-Uni
et Europe) dans Gladys, par le cloud Ohme, avec le compte de l'application
Ohme.

> **API non officielle, jamais testée avec un vrai compte ni une vraie
> borne.** L'intégration parle à l'API de l'application Ohme, comme la
> bibliothèque ohmepy et l'intégration Home Assistant. Ohme peut la changer
> sans prévenir. Sans lien avec Ohme.

## Ce que vous obtenez

Un appareil par compte (la première borne du compte) avec :

| Fonctionnalité              | Contenu                                                                                      |
| --------------------------- | -------------------------------------------------------------------------------------------- |
| État                        | Débranché, Branché, En charge, En pause, Terminé, En attente d'approbation, Borne hors ligne |
| Connecteur                  | Libre, occupé ou indisponible (catégorie « borne de recharge » de Gladys)                    |
| État de charge              | En charge, véhicule branché, en pause, inactif                                               |
| Puissance                   | En W                                                                                         |
| Courant                     | En A                                                                                         |
| Tension                     | En V, quand Ohme la donne                                                                    |
| Énergie de la session       | En kWh : l'énergie de la session en cours, puis de la dernière session                       |
| Batterie du véhicule        | En %, seulement quand Ohme la donne                                                          |
| Cible de batterie           | En %, de la session en cours ou de la suivante                                               |
| Fin de charge prévue        | Fin du dernier créneau planifié, ex. « 2026-10-18 06:30 », sinon « — »                       |
| Mode de charge              | Liste : charge intelligente, charge maximale, en pause                                       |
| Régler la cible de batterie | Liste : 10 % à 100 % par pas de 5 %                                                          |

Lecture **toutes les minutes en charge**, toutes les 5 minutes sinon ; le
compte (modèle, version) toutes les 30 minutes.

**Énergie** : Ohme ne donne aucun compteur cumulé, seulement l'énergie de la
session. L'intégration ne publie donc **aucun index** ni consommation
journalière : l'énergie de la session est un simple capteur, elle n'entre pas
dans le suivi d'énergie de Gladys (la borne est déjà comptée par votre
compteur principal).

## Installation

1. Installez l'intégration depuis le store de Gladys.
2. Dans sa configuration, saisissez l'**e-mail** et le **mot de passe** de
   l'application Ohme. Le mot de passe est gardé par Gladys dans sa base,
   jamais réaffiché, envoyé seulement au service de connexion d'Ohme (Google
   Firebase, comme le fait l'application).
3. Vérifiez le **fuseau horaire** (Europe/Paris par défaut) : il sert à la fin
   de charge prévue.
4. Enregistrez, puis ajoutez la borne depuis l'onglet **Découverte**.

Le bouton **Tester la connexion** lit la borne une fois (au plus toutes les
30 secondes).

## Commandes (désactivées par défaut)

Les fonctionnalités « Mode de charge » et « Régler la cible de batterie »
refusent toute commande tant que l'option **Autoriser les commandes** est
désactivée. Activée :

- **Charge maximale** : charge tout de suite à pleine puissance ;
- **Charge intelligente** : revient au planning d'Ohme ; depuis une pause,
  reprend la charge ;
- **En pause** : met la charge en pause. Depuis une pause, choisissez d'abord
  « Charge intelligente » (la charge maximale est refusée) ;
- **Cible de batterie** : change la cible de la session en cours, ou de la
  suivante si rien n'est branché.

Ce sont des listes, jamais des interrupteurs : un « éteins tout » ne les
touche pas. Google Home, Alexa et HomeKit ne les voient pas, et le serveur MCP
de Gladys les lit seulement. Une scène peut les changer, mais seulement par
une action explicite sur cette liste, et seulement si les commandes sont
autorisées.

Avant chaque commande, l'intégration relit l'état de la borne (et la règle
de la session suivante pour une cible) ; une commande inutile (déjà dans ce
mode) n'est pas envoyée, une commande sans véhicule branché, borne hors
ligne ou charge en attente d'approbation est refusée. Une commande qui ne
peut pas partir dans les 3,5 secondes est refusée sans être envoyée. Gladys
reçoit une réponse au bout de 4,3 secondes au plus, même si Ohme n'a pas
encore confirmé : l'état réel s'affiche environ 10 secondes plus tard. Une
commande à la fois.

## Erreurs et limites

- **E-mail ou mot de passe refusé** : l'intégration s'arrête et le dit ; un
  seul nouvel essai après 6 h, puis toutes les 24 h (pour ne pas bloquer le
  compte). Enregistrer de nouveaux identifiants ou le bouton de test
  réessaient tout de suite.
- **Jeton refusé** : renouvelé une fois ; refusé de nouveau, pause puis un
  essai après 1 h, 6 h, puis toutes les 24 h.
- **429 (trop de requêtes)** : pause de 1 minute à 6 heures (15 minutes sans
  indication), pour tout (lectures, bouton, commandes), gardée après un
  redémarrage. **403** de la lecture principale : pause d'une heure ; 403 sur
  une commande : cette commande seule est refusée ; 403 sur une lecture
  secondaire : cet endpoint est sauté une heure.
- **Réseau, 5xx** : nouvel essai après 2, 5, 10, 15 puis 30 minutes, jamais
  plus vite que l'intervalle.
- Les arrêts et pauses sont gardés dans `/data`, au plus 24 h. `/data` garde
  aussi le jeton de session Ohme, en clair, dans un fichier réservé à
  l'utilisateur du conteneur (0600), donc lisible aussi par l'administrateur
  de la machine et dans les sauvegardes du volume ; jamais l'e-mail ni le mot
  de passe.
- **Borne hors ligne** : le connecteur passe à « indisponible » ; puissance,
  courant, tension et état de charge gardent leur dernière valeur.
- **Une seule borne** : avec plusieurs bornes, seule la première est montrée
  (comme ohmepy).
- Ni l'approbation d'une charge, ni le planning (heure cible), ni le mode
  solaire, ni le plafond de prix ne sont pris en charge.
- Les journaux ne contiennent jamais le mot de passe, les jetons, ni le texte
  des réponses d'Ohme.

## Crédits

Portage de [ohmepy](https://github.com/dan-r/ohmepy) (Daniel Raper, MIT) et
de l'[intégration Ohme de Home Assistant](https://github.com/home-assistant/core/tree/dev/homeassistant/components/ohme)
(Apache-2.0). Licence Apache-2.0.
