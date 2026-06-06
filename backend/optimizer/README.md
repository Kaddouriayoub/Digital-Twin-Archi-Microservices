# Modèle Mathématique — Module d'Optimisation

## 1. Modèle de File d'Attente M/M/c

### Principe

Chaque microservice est modélisé comme une file d'attente **M/M/c** :
- **M** (arrivées) : les requêtes arrivent selon un processus de Poisson (taux λ)
- **M** (service) : le temps de traitement suit une loi exponentielle (taux μ)
- **c** : nombre de serveurs (replicas) traitant en parallèle

### Paramètres

| Symbole | Signification | Source |
|---------|---------------|--------|
| λ (lambda) | Taux d'arrivée (requêtes/sec = RPS) | Prometheus : `rate(traces_span_metrics_calls_total[10m])` |
| μ (mu) | Taux de service par replica (req/sec) | Calibré par service : `1000 / processing_time_ms` |
| c | Nombre de replicas | Configuration actuelle du déploiement |
| ρ (rho) | Taux d'utilisation = λ / (c × μ) | Calculé |

### Formule de la latence moyenne (M/M/1 simplifié)

Pour un seul replica (c=1) :

```
W = 1/μ × 1/(1 - ρ)    où ρ = λ/μ
```

En millisecondes :

```
latence_ms = processing_time_ms / (1 - ρ)
```

Pour c replicas :

```
ρ = λ / (c × μ)
latence_ms = processing_time_ms / max(1 - ρ, 0.001)
```

### Condition de stabilité

Le système est stable si et seulement si **ρ < 1**. Quand ρ → 1, la latence diverge vers l'infini (saturation).

En pratique, on maintient **ρ < 0.8** (seuil empirique standard en ingénierie de performance).

```
         Latence
           │
           │          ╱
           │         ╱
           │        ╱
           │      ╱
           │    ╱
           │__╱___________
           └──────────────── ρ
           0   0.5  0.8  1.0
                     ↑
              Zone dangereuse
```

### Référence

- Kleinrock, L. (1975). *Queueing Systems, Volume 1: Theory*. Wiley.
- Gross, D., Shortle, J. F. (2008). *Fundamentals of Queueing Theory*. 4th Ed.

---

## 2. Calcul du Nombre Optimal de Replicas

### Problème d'optimisation

```
Minimiser : c (nombre de replicas = coût)
Sous contraintes :
  - ρ = λ/(c×μ) < 0.8          (stabilité)
  - latence_prédite < 500ms      (SLA)
```

### Algorithme

```
function computeOptimalReplicas(λ, μ, SLA_latency, target_ρ):
    pour c = 1, 2, 3, ... , 20:
        ρ = λ / (c × μ)
        latence = processing_time / (1 - ρ)
        si ρ < target_ρ ET latence < SLA_latency:
            retourner c
    retourner 20  // cap de sécurité
```

### Exemple numérique

Service `order-service` :
- processing_time = 80ms → μ = 12.5 req/s par replica
- RPS actuel (λ) = 48 req/s

| Replicas (c) | ρ = λ/(c×μ) | Latence prédite | Respecte SLA ? |
|:---:|:---:|:---:|:---:|
| 1 | 48/12.5 = 3.84 | ∞ (saturé) | ❌ |
| 2 | 48/25 = 1.92 | ∞ (saturé) | ❌ |
| 3 | 48/37.5 = 1.28 | ∞ (saturé) | ❌ |
| 4 | 48/50 = 0.96 | 2000ms | ❌ |
| 5 | 48/62.5 = 0.77 | 348ms | ❌ (ρ > 0.7) |
| **6** | **48/75 = 0.64** | **222ms** | **✅** |

→ Recommandation : **6 replicas** pour `order-service` à 48 RPS.

---

## 3. Règles de Recommandation (Niveau 1)

Basées sur les principes du **Google SRE Book** (chapitre SLOs & Error Budgets).

### Règle 1 : Scale Up (saturation)

```
SI ρ > 80% ET latence_P99 > SLA:
    replicas_optimal = min(c) tel que ρ < 70%
    gain = (latence_actuelle - latence_prédite) / latence_actuelle
    → RECOMMANDER scale up
```

**Justification** : Au-delà de 80% d'utilisation, le temps d'attente en file croît de façon non-linéaire (loi de Little + M/M/c). Le seuil de 70% comme cible laisse une marge pour les pics.

### Règle 2 : Problème de dépendance

```
SI latence_P99 > SLA ET ρ < 30%:
    → Le service n'est pas surchargé mais lent
    → Le problème vient d'une dépendance (downstream)
    → Identifier via le graphe de topologie
```

**Justification** : Si l'utilisation est faible mais la latence élevée, le goulot d'étranglement est ailleurs dans la chaîne d'appels.

### Règle 3 : Taux d'erreur

```
SI error_rate > 1%:
    → Alerte + identification des dépendances impactées
```

**Justification** : L'Error Budget (Google SRE) définit 99% comme SLO standard. Au-delà de 1% d'erreurs, le budget est consommé.

### Règle 4 : Scale Down (sur-provisionnement)

```
SI ρ < 30% ET latence < SLA/2:
    → Ressources gaspillées, réduction possible
```

**Justification** : Sous 30% d'utilisation avec une latence confortablement sous le SLA, on peut réduire le nombre de replicas sans risque.

---

## 4. Seuils (SLA) utilisés

| Paramètre | Valeur | Justification |
|-----------|--------|---------------|
| Latence max (P99) | 500ms | Standard industrie pour services user-facing (Google, Amazon) |
| Erreur max | 1% | Error budget SRE (SLO 99%) |
| Utilisation max (ρ) | 80% | Seuil de stabilité M/M/c (Kleinrock) |
| Utilisation cible | 70% | Marge pour absorption des pics |
| Utilisation min | 30% | En-dessous = sur-provisionné |

---

## 5. Références

1. Kleinrock, L. (1975). *Queueing Systems, Volume 1: Theory*. Wiley-Interscience.
   - Résumé du modèle M/M/c : https://en.wikipedia.org/wiki/M/M/c_queue
2. Gunther, N. J. (2007). *Guerrilla Capacity Planning*. Springer. — Universal Scalability Law.
   - Article explicatif : http://www.perfdynamics.com/Manifesto/USLscalability.html
3. Beyer, B. et al. (2016). *Site Reliability Engineering*. O'Reilly. — Chapitres SLOs, Error Budgets.
   - Livre gratuit en ligne : https://sre.google/sre-book/table-of-contents/
   - Chapitre Service Level Objectives : https://sre.google/sre-book/service-level-objectives/
4. Burns, B. (2018). *Designing Distributed Systems*. O'Reilly. — Patterns de scaling.
5. Kubernetes Documentation. *Horizontal Pod Autoscaler*.
   - https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale/
6. Google Cloud. *Queueing Theory and Practical Applications to Server Systems*.
   - https://research.google/pubs/pub44830/
7. Utilisation target 70-80% — AWS Well-Architected Framework :
   - https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/design-your-workload-to-adapt-to-changes-in-demand.html
8. Little's Law (fondement de la relation latence/throughput) :
   - https://en.wikipedia.org/wiki/Little%27s_law
9. Erlang C Formula (modèle M/M/c généralisé pour centres d'appels et serveurs) :
   - https://en.wikipedia.org/wiki/Erlang_(unit)#Erlang_C_formula
