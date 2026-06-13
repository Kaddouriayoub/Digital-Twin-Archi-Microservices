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

## 5. Niveau 3 — Détection d'Anomalies

### 5.1 Z-score (détection instantanée)

Mesure combien d'écarts-types la valeur actuelle dévie de la moyenne historique :

```
z = (x - μ) / σ

Si |z| > 2 → anomalie (probabilité < 5% sous distribution normale)
Si |z| > 3 → anomalie sévère (probabilité < 0.3%)
```

**Implémentation :** On garde les 30 dernières valeurs par service. La valeur actuelle est comparée à la distribution de cet historique.

### 5.2 EWMA — Exponentially Weighted Moving Average

Moyenne mobile qui pondère plus fortement les valeurs récentes (Roberts, 1959) :

```
S_t = α × x_t + (1 - α) × S_{t-1}

α = 0.3 (facteur de lissage, plus élevé = plus réactif)
```

**Détection :** Si la valeur actuelle dépasse l'EWMA de plus de 50%, c'est une déviation significative.

**Propriété :** La demi-vie d'un point passé est `ln(2) / ln(1/(1-α))` ≈ 2 points. Donc les valeurs vieilles de ~7 points ne comptent presque plus.

### 5.3 Régression linéaire — Prédiction de tendance

Méthode des moindres carrés sur les N derniers points :

```
ŷ = a × t + b

a = (n×Σ(t×y) - Σt×Σy) / (n×Σ(t²) - (Σt)²)    (pente)
b = (Σy - a×Σt) / n                               (ordonnée à l'origine)
```

**Prédiction :** On extrapole pour estimer quand la métrique dépassera le SLA :

```
temps_avant_SLA = (SLA_max - valeur_actuelle) / pente_par_minute
```

Si ce temps est < 30 minutes → alerte préventive.

### 5.4 Combinaison des 3 méthodes

| Méthode | Détecte quoi | Temps de réaction |
|---------|-------------|-------------------|
| Z-score | Saut brutal (spike) | Immédiat |
| EWMA | Déviation progressive | ~2-3 points |
| Régression | Tendance à la hausse | ~5 points minimum |

---

## 6. Références

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
10. Roberts, S.W. (1959). *Control Chart Tests Based on Geometric Moving Averages*. Technometrics.
    - EWMA expliqué : https://en.wikipedia.org/wiki/EWMA_chart
11. Netflix Technology Blog. *RAD — Outlier Detection on Big Data* (2015).
    - https://netflixtechblog.com/rad-outlier-detection-on-big-data-d6b0ff32fb44
12. Twitter Engineering. *Anomaly Detection for Time Series* (2015).
    - https://blog.twitter.com/engineering/en_us/a/2015/introducing-practical-and-robust-anomaly-detection-in-a-time-series
13. Google SRE Book. *Practical Alerting from Time-Series Data*.
    - https://sre.google/sre-book/practical-alerting/
