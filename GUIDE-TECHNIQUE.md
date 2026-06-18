# Guide Technique — Digital Twin for Microservices

## Architecture du Projet

```
digital-twin-microservices/
├── backend/
│   ├── metrics-collector/          # Phase 1: Collecte de données
│   │   ├── api-server.js              # Point d'entrée principal (REST + WebSocket)
│   │   ├── prometheus-client.js       # Requêtes PromQL vers Prometheus
│   │   ├── jaeger-client.js           # Client API Jaeger (traces + dépendances)
│   │   ├── topology-discovery.js      # Auto-découverte du graphe de services
│   │   └── data-transformer.js        # Normalisation des métriques brutes
│   ├── src/
│   │   ├── kafka/                  # Phase 2: Digital Thread (fil numérique)
│   │   │   ├── KafkaPublisher.js      # Publie événements vers topics Kafka
│   │   │   └── KafkaConsumer.js       # Consomme métriques pour maj d'état
│   │   ├── state/
│   │   │   └── StateManager.js        # Persistance (Redis + TimescaleDB)
│   │   └── control/
│   │       └── ControlService.js      # Phase 4: Boucle de contrôle fermée
│   ├── optimizer/                  # Phase 3: Détection d'anomalies
│   │   ├── anomaly-detector.js        # Z-score, EWMA, régression linéaire
│   │   └── optimization-engine.js     # Recommandations de scaling
│   └── simulator/                  # Simulation What-If
│       ├── scenario-engine.js         # 6 scénarios (load spike, failure, etc.)
│       ├── performance-model.js       # Modèle de file d'attente M/M/c
│       └── load-injector.js           # Données synthétiques (demo mode)
├── frontend/                       # Dashboard React
│   └── src/
│       ├── App.jsx                    # Layout principal + navigation
│       ├── components/
│       │   ├── ServiceMap.jsx         # Graphe de topologie (D3.js force-directed)
│       │   ├── MetricsPanel.jsx       # Métriques golden signals
│       │   ├── PerformanceChart.jsx   # Graphiques temps-réel (Recharts)
│       │   ├── SimulatorControl.jsx   # Interface simulation what-if
│       │   ├── OptimizePanel.jsx      # Panneau anomalies + recommandations
│       │   └── ControlPanel.jsx       # Panneau contrôle (scaling actions)
│       ├── hooks/
│       │   ├── useMetrics.js          # State management (polling + WebSocket)
│       │   └── useWebSocket.js        # Connexion WebSocket temps-réel
│       └── api/
│           └── client.js              # Client HTTP vers le backend
├── ml-service/                     # Service ML (Python)
│   ├── main.py                        # API FastAPI
│   ├── detector.py                    # Isolation Forest
│   └── trainer.py                     # Entraînement auto sur historique
├── docker-compose.yml              # Déploiement standalone (tout inclus)
└── docker-compose.otel-demo.yml    # Connexion à l'OTel Demo existant
```

---

## Comment le Digital Twin se connecte à l'architecture réelle

Le Digital Twin ne fait **pas partie** de l'architecture des microservices — il est un **observateur externe** qui se branche sur l'infrastructure d'observabilité existante :

```
┌─────────────────────────────────────────────────────────┐
│           Architecture Réelle (OTel Demo)                │
│                                                         │
│  frontend → checkout → payment                          │
│               ↓          ↓                              │
│            cart      currency                           │
│               ↓                                         │
│         product-catalog → recommendation                │
│                                                         │
│  Chaque service est instrumenté avec OpenTelemetry      │
│  → envoie métriques à Prometheus                        │
│  → envoie traces à Jaeger                               │
└────────────┬──────────────────────┬─────────────────────┘
             │                      │
        Port 9090              Port 16686
             │                      │
┌────────────▼──────────────────────▼─────────────────────┐
│              DIGITAL TWIN (notre projet)                  │
│                                                         │
│  prometheus-client.js ←── Prometheus (PromQL)           │
│  jaeger-client.js     ←── Jaeger (REST API)             │
│                                                         │
│  → Collecte → Kafka → Anomalies → Control → Dashboard  │
└─────────────────────────────────────────────────────────┘
```

**Point clé** : Le Digital Twin ne modifie pas les microservices. Il lit leurs métriques via Prometheus et Jaeger qui sont déjà en place dans toute architecture OpenTelemetry.

---

## Phase 1 : Collecte des Métriques (Scraping)

### Cycle de collecte

Toutes les **15 secondes**, `api-server.js` exécute la fonction `collectMetrics()` :

**Fichier : `backend/metrics-collector/api-server.js`** (lignes 63–160)

```javascript
async function collectMetrics() {
  // ── Real Prometheus + Jaeger path ─────────────────────
  const [services, latencyRaw, rpsRaw, errorsRaw, cpuRaw, memRaw] = await Promise.all([
    prometheus.getServiceList(),
    prometheus.getLatencyP99(),
    prometheus.getThroughput(),
    prometheus.getErrorRates(),
    prometheus.getCpuUsage(),
    prometheus.getMemoryUsage(),
  ]);

  const latency = transformer.transformLatencyP99(latencyRaw);
  const rps     = transformer.transformThroughput(rpsRaw);
  const errors  = transformer.transformErrorRates(errorsRaw);

  // Topology from Jaeger
  let topology;
  const jaegerAvailable = await topologyDiscovery.isAvailable();
  if (jaegerAvailable) {
    topology = await topologyDiscovery.discoverTopology();
  }

  const serviceSnapshots = transformer.buildServiceSnapshots(
    services, latency, rps, errors, cpuPods, memPods
  );

  latestSnapshot = { collectedAt: Date.now(), services: serviceSnapshots, topology };
  cache.set('snapshot', latestSnapshot);
  broadcast({ type: 'METRICS_UPDATE', payload: latestSnapshot }); // WebSocket push
}

// Lancé au démarrage, répété toutes les 15s
setInterval(collectMetrics, SCRAPE_INTERVAL);
```

### 1.1 — Découverte des services

**Fichier : `backend/metrics-collector/prometheus-client.js`**

```javascript
async function getServiceList() {
  // Interroge Prometheus pour tous les service_name uniques
  const resp = await axios.get(`${PROMETHEUS_URL}/api/v1/label/service_name/values`);
  const exclude = ['otelcol-contrib', 'jaeger', 'load-generator', 'frontend-proxy', 'frontend-web'];
  return resp.data.data.filter(s => !exclude.includes(s));
}
```

→ Prometheus retourne tous les `service_name` qu'il a reçu via OpenTelemetry. On filtre les services d'infrastructure.

### 1.2 — Golden Signals (PromQL)

**Fichier : `backend/metrics-collector/prometheus-client.js`**

```javascript
// P99 Latence (ms) — combine HTTP + gRPC
async function getLatencyP99() {
  const [http, rpc] = await Promise.all([
    queryInstant(
      `histogram_quantile(0.99, sum(rate(http_server_request_duration_seconds_bucket[10m])) by (service_name, le)) * 1000`
    ),
    queryInstant(
      `histogram_quantile(0.99, sum(rate(rpc_server_call_duration_seconds_bucket[10m])) by (service_name, le)) * 1000`
    ),
  ]);
  return mergeResults(http, rpc);
}

// Throughput (requêtes/seconde)
async function getThroughput() {
  const [http, rpc] = await Promise.all([
    queryInstant(`sum(rate(http_server_request_duration_seconds_count[10m])) by (service_name)`),
    queryInstant(`sum(rate(rpc_server_call_duration_seconds_count[10m])) by (service_name)`),
  ]);
  return mergeResults(http, rpc);
}

// Taux d'erreur (%)
async function getErrorRates() {
  const [http, rpc] = await Promise.all([
    queryInstant(`
      sum(rate(http_server_request_duration_seconds_count{http_status_code=~"5.."}[10m])) by (service_name)
      / sum(rate(http_server_request_duration_seconds_count[10m])) by (service_name)
    `),
    queryInstant(`
      sum(rate(rpc_server_call_duration_seconds_count{rpc_grpc_status_code!="0"}[10m])) by (service_name)
      / sum(rate(rpc_server_call_duration_seconds_count[10m])) by (service_name)
    `),
  ]);
  return mergeResults(http, rpc);
}
```

**Explication des Golden Signals** :
| Signal | PromQL | Signification |
|--------|--------|---------------|
| Latence P99 | `histogram_quantile(0.99, ...)` | 99% des requêtes répondent en moins de X ms |
| Throughput | `rate(..._count[10m])` | Nombre de requêtes/seconde sur 10 min |
| Erreurs | `5xx_count / total_count` | Pourcentage de réponses en erreur |

### 1.3 — Découverte de topologie (Jaeger)

**Fichier : `backend/metrics-collector/jaeger-client.js`**

```javascript
// Récupère le graphe de dépendances calculé par Jaeger
async function getDependencies(lookbackMinutes = 60) {
  const endTs = Date.now();
  const resp = await axios.get(`${JAEGER_URL}/api/dependencies`, {
    params: { endTs, lookback: lookbackMinutes * 60 * 1000 },
  });
  return resp.data.data || [];
  // Retourne: [{ parent: "checkout", child: "payment", callCount: 150 }, ...]
}
```

**Fichier : `backend/metrics-collector/topology-discovery.js`**

```javascript
async function discoverTopology(lookbackMinutes = 60) {
  const deps = await jaeger.getDependencies(lookbackMinutes);

  const nodeSet = new Set();
  const edges = [];
  deps.forEach(({ parent, child, callCount }) => {
    nodeSet.add(parent);
    nodeSet.add(child);
    edges.push({
      source: parent,
      target: child,
      rps: Math.round(callCount / (lookbackMinutes * 60) * 10) / 10
    });
  });

  return { nodes: Array.from(nodeSet).map(id => ({ id })), edges };
}
```

→ Jaeger analyse les traces distribuées et sait que `checkout` appelle `payment`, `cart`, `currency`, etc. On transforme ça en graphe de nœuds/arêtes.

### 1.4 — Normalisation des données

**Fichier : `backend/metrics-collector/data-transformer.js`**

```javascript
// Assemble toutes les métriques en un snapshot par service
function buildServiceSnapshots(services, latency, rps, errors, cpuPods, memPods) {
  return services.map(name => ({
    name,
    latencyP99Ms: latency[name] || 0,
    throughputRps: rps[name] || 0,
    errorRatePct: errors[name] || 0,
    cpuMillicores: cpuPods[name] || 0,
    memoryMib: memPods[name] || 0,
    health: computeHealthScore(latency[name], errors[name], rps[name]),
    updatedAt: Date.now(),
  }));
}

// Score de santé simple (0 = critique, 100 = sain)
function computeHealthScore(latencyMs, errorPct, rps) {
  let score = 100;
  if (latencyMs > 500) score -= 30;
  else if (latencyMs > 200) score -= 15;
  if (errorPct > 5) score -= 35;
  else if (errorPct > 1) score -= 15;
  if (rps === 0) score -= 10;
  return Math.max(0, score);
}
```

---

## Phase 2 : Digital Thread (Kafka)

Le **Digital Thread** est un fil numérique immuable qui enregistre tout ce qui se passe dans le système. Chaque métrique, anomalie, et action est publiée comme événement Kafka.

### Flux de données

```
collectMetrics() 
    │
    ├──→ kafkaPublisher.publishMetrics(service, metrics)  →  twin.metrics.{service}
    ├──→ kafkaPublisher.publishAnomaly(anomaly)           →  twin.anomalies
    ├──→ kafkaPublisher.publishAction(action)             →  twin.actions
    └──→ kafkaPublisher.publishSimulation(result)         →  twin.simulations
                                                                    │
                                                              KafkaConsumer
                                                                    │
                                                                    ▼
                                                              StateManager
                                                              (Redis + DB)
```

### 2.1 — Publication (Producer)

**Fichier : `backend/src/kafka/KafkaPublisher.js`**

```javascript
class KafkaPublisher {
  constructor() {
    this.kafka = new Kafka({
      clientId: 'digital-twin-publisher',
      brokers: BROKERS,   // kafka:9092
    });
    this.producer = this.kafka.producer();
  }

  async publishMetrics(service, metrics) {
    const topic = `twin.metrics.${service}`;  // 1 topic par service
    await this.publish(topic, service, {
      service,
      latency_p99_ms: metrics.latencyP99Ms,
      error_rate: metrics.errorRatePct,
      throughput_rps: metrics.throughputRps,
      cpu_percent: metrics.cpuPercent || 0,
      memory_mb: metrics.memoryMib || 0,
      replica_count: metrics.replicaCount || 1,
    });
  }

  async publishAnomaly(anomaly) {
    await this.publish('twin.anomalies', anomaly.service, {
      service: anomaly.service,
      severity: anomaly.severity,
      method: anomaly.type,         // 'anomaly', 'trend', 'ewma_deviation'
      score: anomaly.details?.zScore || 0,
      triggered_by: anomaly.metric, // 'latency', 'errors'
      recommendation: anomaly.message,
    });
  }
}
```

### 2.2 — Consommation (Consumer)

**Fichier : `backend/src/kafka/KafkaConsumer.js`**

```javascript
class KafkaConsumer {
  async start(handler) {
    await this.consumer.connect();
    // S'abonne à TOUS les topics twin.metrics.*
    await this.consumer.subscribe({ topics: [/^twin\.metrics\..+/], fromBeginning: false });
    await this.consumer.run({
      eachMessage: async ({ topic, message }) => {
        const value = JSON.parse(message.value.toString());
        this._handler(topic, value);  // → StateManager.setState()
      },
    });
  }
}
```

### 2.3 — Persistance d'état

**Fichier : `backend/src/state/StateManager.js`**

```javascript
class StateManager {
  // Redis = état courant (lecture rapide)
  // TimescaleDB = historique time-series (INSERT par cycle)

  async setState(serviceName, metrics) {
    // Redis: HSET twin:state:{service} pour l'état actuel
    await this.redis.hset(`twin:state:${serviceName}`, flat);

    // TimescaleDB: INSERT pour l'historique
    await this.pg.query(
      `INSERT INTO service_metrics (time, service_name, latency_p99, error_rate, throughput_rps, ...)
       VALUES ($1, $2, $3, $4, $5, ...)`,
      [now, serviceName, metrics.latencyP99Ms, metrics.errorRatePct, metrics.throughputRps, ...]
    );
  }
}
```

### Topics Kafka

| Topic | Contenu | Produit par |
|-------|---------|-------------|
| `twin.metrics.checkout` | Métriques du service checkout | collectMetrics() |
| `twin.metrics.payment` | Métriques du service payment | collectMetrics() |
| `twin.anomalies` | Événements d'anomalie détectés | anomaly-detector |
| `twin.actions` | Actions de contrôle exécutées | ControlService |
| `twin.simulations` | Résultats de simulation what-if | scenario-engine |

---

## Phase 3 : Détection d'Anomalies

### 3 méthodes statistiques + 1 ML

**Fichier : `backend/optimizer/anomaly-detector.js`**

#### 3.1 — Z-Score (détection de pics)

```javascript
// Z-score: combien d'écarts-types la valeur actuelle est de la moyenne
function zScore(arr, current) {
  const m = mean(arr);
  const s = stdDev(arr);
  if (s === 0) return 0;
  return (current - m) / s;
}

// Utilisation dans detectAnomalies():
const latencyZ = zScore(h.latency.slice(0, -1), svc.latencyP99Ms);
if (Math.abs(latencyZ) > 2.0 && svc.latencyP99Ms > 50) {
  alerts.push({
    service: svc.name,
    type: 'anomaly',
    severity: Math.abs(latencyZ) > 3 ? 'critical' : 'warning',
    message: `Latence anormale (${svc.latencyP99Ms}ms, z-score: ${latencyZ})`,
  });
}
```

→ Si la latence actuelle est à plus de **2 écarts-types** de la moyenne historique → **warning**. Plus de 3 → **critical**.

#### 3.2 — Régression linéaire (prédiction de tendance)

```javascript
function linearRegression(arr) {
  // Calcul des moindres carrés sur les derniers points
  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
  return { slope, intercept };
}

// Si la latence monte, prédit quand le SLA sera dépassé
const { slope } = linearRegression(window);
const slopePerMin = slope / (15 / 60); // convertit en ms/minute
const timeToSLA = (500 - currentLatency) / slopePerMin;

if (timeToSLA > 0 && timeToSLA < 30) {
  alerts.push({
    type: 'trend',
    severity: timeToSLA < 5 ? 'critical' : 'warning',
    message: `Latence en hausse (+${slopePerMin}ms/min) — dépassement SLA dans ~${timeToSLA} min`,
  });
}
```

→ Prédit quand la latence va dépasser le SLA (500ms). Si c'est dans moins de 5 min → **critical**.

#### 3.3 — EWMA (moyenne mobile exponentielle)

```javascript
function ewma(arr, alpha = 0.3) {
  let s = arr[0];
  for (let i = 1; i < arr.length; i++) {
    s = alpha * arr[i] + (1 - alpha) * s;  // plus récent = plus de poids
  }
  return s;
}

// Détecte si la valeur actuelle diverge de la tendance lissée
const ewmaValue = ewma(h.latency);
const deviation = (svc.latencyP99Ms - ewmaValue) / ewmaValue;
if (deviation > 0.5) {  // 50% au-dessus de la tendance
  alerts.push({ type: 'ewma_deviation', severity: deviation > 1 ? 'critical' : 'warning' });
}
```

#### 3.4 — ML Isolation Forest (service Python séparé)

**Fichier : `ml-service/detector.py`**

```python
from sklearn.ensemble import IsolationForest

class AnomalyDetector:
    def detect(self, metrics):
        features = [[
            metrics['latency_p99'],
            metrics['error_rate'],
            metrics['throughput_rps'],
            metrics['cpu_percent'],
            metrics['memory_mb'],
        ]]
        score = self.model.decision_function(features)[0]
        is_anomaly = self.model.predict(features)[0] == -1
        return { 'is_anomaly': is_anomaly, 'score': score }
```

→ Le backend Node.js appelle le service ML Python pour une détection multi-variable, puis **combine** les résultats ML avec les alertes statistiques.

---

## Phase 4 : Boucle de Contrôle Fermée (Closed-Loop)

Quand une anomalie est détectée, le système peut **agir automatiquement** (scaling Docker).

**Fichier : `backend/src/control/ControlService.js`**

```javascript
class ControlService {
  constructor(dockerClient, config) {
    this.docker = dockerClient;
    this.config = {
      maxReplicas: { default: 5 },
      cooldownMinutes: 5,        // évite le flapping
      dryRun: true,              // sécurité : log sans exécuter par défaut
      enabledServices: [],       // whitelist (vide = tous)
    };
  }

  async handleAnomaly(anomalyEvent) {
    // Seulement les anomalies high/critical déclenchent une action
    if (anomalyEvent.severity === 'high' || anomalyEvent.severity === 'critical') {
      const target = anomalyEvent.details?.recommendedReplicas;
      if (target) {
        return this.scaleService(anomalyEvent.service, target, 'anomaly_high_severity');
      }
    }
  }

  async scaleService(serviceName, targetReplicas, reason) {
    // 1. Vérification whitelist
    // 2. Vérification cooldown (pas d'action si < 5 min depuis la dernière)
    // 3. Cap max replicas
    // 4. Si dryRun → log seulement
    // 5. Sinon → Docker API: service.update({ Replicas: target })

    if (this.config.dryRun) {
      this._log({ decision: 'DRY_RUN', service: serviceName,
        message: `Would scale to ${replicas} replicas` });
      return { success: true, action_taken: false, message: 'dry_run' };
    }

    // Exécution réelle via Docker API
    const service = this.docker.getService(serviceName);
    await service.update({ Mode: { Replicated: { Replicas: targetReplicas } } });
    this._log({ decision: 'SCALED', message: `${previous} → ${replicas} replicas` });
  }
}
```

### Chaîne complète dans `collectMetrics()` :

```javascript
// 1. Détecte les anomalies
const anomalies = anomalyDetector.detectAnomalies(serviceSnapshots);

// 2. Publie sur Kafka (Digital Thread)
for (const a of anomalies) { kafkaPublisher.publishAnomaly(a); }

// 3. Agit sur les anomalies (scaling)
for (const a of anomalies) { await controlService.handleAnomaly(a); }

// 4. Génère des recommandations d'optimisation
const recs = optimizer.generateRecommendations(serviceSnapshots, topology);
for (const r of recs) { await controlService.handleOptimizerRecommendation(r); }
```

### Sécurités du contrôle

| Mécanisme | Description |
|-----------|-------------|
| `DRY_RUN=true` | Par défaut, log sans exécuter |
| Cooldown 5 min | Pas de double-action rapprochée |
| Max replicas | Cap à 5 réplicas par service |
| Whitelist | Seuls les services listés sont éligibles |

---

## Phase 5 : Dashboard Temps-Réel

### Communication Backend → Frontend

```
Backend (api-server.js)
    │
    ├── REST API (polling fallback)     →  GET /api/metrics/services
    │                                       GET /api/topology
    │                                       GET /api/optimize/anomalies
    │
    └── WebSocket (push temps-réel)     →  ws://localhost:3001/ws
         broadcast({ type: 'METRICS_UPDATE', payload: snapshot })
```

**Fichier : `frontend/src/hooks/useMetrics.js`**

```javascript
// Dual mode: WebSocket pour temps-réel, REST en fallback
function useMetrics() {
  const [services, setServices] = useState([]);
  const ws = useWebSocket('ws://localhost:3001/ws');

  // WebSocket: reçoit les mises à jour push
  useEffect(() => {
    if (ws) {
      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === 'METRICS_UPDATE') {
          setServices(msg.payload.services);
        }
      };
    }
  }, [ws]);

  // Fallback: polling REST toutes les 15s
  useEffect(() => {
    const poll = () => fetch('/api/metrics/services').then(r => r.json()).then(setData);
    const interval = setInterval(poll, 15000);
    return () => clearInterval(interval);
  }, []);
}
```

---

## Résumé du flux complet (1 cycle = 15 secondes)

```
1. SCRAPE       Prometheus ← PromQL queries (latence, RPS, erreurs)
                Jaeger     ← GET /api/dependencies (topologie)

2. TRANSFORM    Raw → ServiceSnapshot { name, latencyP99Ms, throughputRps, ... }

3. PUBLISH      → Kafka topic twin.metrics.{service}
                → WebSocket broadcast à tous les clients connectés

4. DETECT       anomaly-detector analyse l'historique (Z-score, EWMA, trend)
                → publie sur twin.anomalies

5. CONTROL      ControlService reçoit anomalies critical
                → scale Docker service (ou dry_run log)
                → publie sur twin.actions

6. DISPLAY      Frontend reçoit via WebSocket ou REST polling
                → Met à jour graphe, charts, alertes en temps réel
```

---

## Phase 6 : Simulateur What-If

Le simulateur prédit l'impact d'un scénario **sans toucher** à l'architecture réelle. Il prend le snapshot actuel comme baseline et applique un modèle mathématique.

### 6.1 — Modèle de performance M/M/c

**Fichier : `backend/simulator/performance-model.js`**

Le cœur du simulateur est la théorie des files d'attente **M/M/c** :

```javascript
/**
 * M/M/c queue — estime la latence moyenne selon :
 *  - λ (arrivalRate) : requêtes/seconde
 *  - μ (serviceRate) : 1000 / processingTimeMs
 *  - c (replicas)    : nombre d'instances
 *
 * Formule simplifiée : latence = procTime / (1 - ρ)
 * où ρ = λ / (c × μ) est le taux d'utilisation
 */
function mmcQueueLatency(arrivalRateRps, procTimeMs, replicas = 1) {
  const serviceRatePerReplica = 1000 / procTimeMs;
  const totalServiceRate = serviceRatePerReplica * replicas;
  const utilisation = arrivalRateRps / totalServiceRate;

  if (utilisation >= 1) {
    // Saturé — latence explose
    return procTimeMs * (1 + utilisation * 10);
  }
  // M/M/1 : temps moyen = procTime / (1 - ρ)
  return procTimeMs / Math.max(1 - utilisation, 0.001);
}
```

**Interprétation** : Si un service traite 1 requête en 15ms (μ = 66 req/s) et reçoit 50 req/s avec 1 réplica :
- ρ = 50/66 = 0.76 → latence = 15 / (1 - 0.76) = **62.5ms**
- Avec 2 réplicas : ρ = 50/132 = 0.38 → latence = 15 / (1 - 0.38) = **24ms**

### 6.2 — Propagation de pannes en cascade

```javascript
function propagateFailure(failedService, allServices, severity) {
  const impact = {};
  const depMap = getActiveDependencyMap(); // du graphe Jaeger

  // Pour chaque service qui DÉPEND du service en panne
  Object.entries(depMap).forEach(([consumer, deps]) => {
    if (deps.includes(failedService)) {
      const addedLatency = 500 * severity;   // timeout/retry
      const addedError = 30 * severity;       // % erreurs cascadées
      impact[consumer] = { latencyDeltaMs: addedLatency, errorDeltaPct: addedError };
    }
  });
  return impact;
}
```

→ Si `payment` tombe, `checkout` (qui dépend de `payment`) hérite de +500ms de latence et +30% d'erreurs.

### 6.3 — Les 6 scénarios

**Fichier : `backend/simulator/scenario-engine.js`**

```javascript
function runScenario({ scenario, service, intensity, config, baseline }) {
  switch (scenario) {
    case 'load_spike':        return handleLoadSpike({ service, intensity, baseline });
    case 'service_failure':   return handleServiceFailure({ service, intensity, baseline });
    case 'scale_up':          return handleScaleUp({ service, replicas: config.replicas, baseline });
    case 'network_partition': return handleNetworkPartition({ service, intensity, baseline });
    case 'memory_pressure':   return handleMemoryPressure({ service, intensity, baseline });
    case 'cache_miss':        return handleCacheMiss({ baseline });
  }
}
```

| Scénario | Ce qu'il fait | Modèle utilisé |
|----------|---------------|----------------|
| **Load Spike** | Multiplie le RPS par un facteur (2×, 5×, 10×) | M/M/c → prédit latence sous charge |
| **Service Failure** | Simule panne partielle/totale | `propagateFailure()` → cascade |
| **Scale Up** | Ajoute des réplicas | M/M/c avec c > 1 → prédit amélioration |
| **Network Partition** | Perte de paquets entre services | Latence × (1 + loss×5), erreurs += loss×50% |
| **Memory Pressure** | Simule fuite mémoire / GC pauses | Latence × (1 + pressure×4) |
| **Cache Failure** | Cache Redis down | Services dépendants passent au DB direct (×20 latence) |

### 6.4 — Exemple : Load Spike

```javascript
function handleLoadSpike({ service = 'frontend', intensity = 2, baseline }) {
  return baseline.map(svc => {
    const isEntryPoint = svc.name === service;
    const isDependency = (DEPENDENCY_MAP[service] || []).includes(svc.name);

    // L'entrée reçoit 100% de la charge, ses dépendances 80%
    const factor = isEntryPoint ? intensity
                 : isDependency ? intensity * 0.8
                 : 1.0;

    // Prédit métriques avec le modèle M/M/c
    const prediction = predictServiceMetrics(svc.name, svc, factor, 1);
    return { ...svc, ...prediction, scenarioTag: factor > 1 ? 'impacted' : 'normal' };
  });
}
```

### Appel API

```
POST /api/simulate
Body: { "scenario": "load_spike", "service": "frontend", "intensity": 5 }

Response: [
  { name: "frontend", predictedLatencyMs: 340, predictedErrorPct: 12, scenarioTag: "impacted" },
  { name: "checkout", predictedLatencyMs: 180, predictedErrorPct: 5, scenarioTag: "impacted" },
  { name: "payment",  predictedLatencyMs: 25, predictedErrorPct: 0, scenarioTag: "normal" },
  ...
]
```

---

## Phase 7 : Moteur d'Optimisation

Génère des recommandations de scaling basées sur les métriques actuelles.

**Fichier : `backend/optimizer/optimization-engine.js`**

### SLA Thresholds

```javascript
const SLA = {
  maxLatencyMs: 500,       // P99 latence max acceptée
  maxErrorPct: 1,          // Taux d'erreur max (%)
  maxUtilization: 0.8,     // ρ < 80% (zone sûre en théorie des files)
  targetUtilization: 0.7,  // Cible pour le calcul de scaling
  minUtilization: 0.3,     // En dessous → sur-provisionné
};
```

### Règles de recommandation

```javascript
function generateRecommendations(services, topology) {
  for (const svc of services) {
    const utilization = rps / serviceRate;

    // Règle 1: Latence haute + charge haute → SCALE UP
    if (svc.latencyP99Ms > 500 && utilization > 0.8) {
      const optimal = computeOptimalReplicas(svc.name, rps, profile);
      recommendations.push({ type: 'scale_up', recommendedReplicas: optimal });
    }

    // Règle 2: Latence haute + charge faible → problème de dépendance
    if (svc.latencyP99Ms > 500 && utilization < 0.3) {
      recommendations.push({ type: 'dependency_issue', dependencies: deps });
    }

    // Règle 3: Taux d'erreur élevé → investigation
    if (svc.errorRatePct > 1) {
      recommendations.push({ type: 'high_errors' });
    }

    // Règle 4: Sous-utilisé → scale down possible
    if (utilization < 0.3 && svc.latencyP99Ms < 250) {
      recommendations.push({ type: 'scale_down' });
    }
  }
}
```

### Calcul du nombre optimal de réplicas

```javascript
function computeOptimalReplicas(serviceName, arrivalRate, profile) {
  const serviceRate = 1000 / profile.baseProcTimeMs;

  // Trouve le minimum c tel que ρ < 70% ET latence < 500ms
  for (let c = 1; c <= 20; c++) {
    const utilization = arrivalRate / (c * serviceRate);
    const predictedLatency = mmcQueueLatency(arrivalRate, profile.baseProcTimeMs, c);

    if (utilization < 0.7 && predictedLatency < 500) {
      return c;  // nombre optimal trouvé
    }
  }
  return 20; // cap max
}
```

→ C'est ce résultat `recommendedReplicas` qui est envoyé au **ControlService** pour déclencher le scaling automatique.

---

## Frontend : Architecture des composants

**Fichier : `frontend/src/App.jsx`** — Layout principal avec onglets

```
App.jsx
 ├── ServiceMap.jsx        ── Graphe de topologie (D3.js force-directed)
 ├── MetricsPanel.jsx      ── Cartes des golden signals par service
 ├── PerformanceChart.jsx  ── Graphiques temps-réel (Recharts)
 ├── SimulatorControl.jsx  ── Interface what-if (choix scénario, paramètres, résultats)
 ├── OptimizePanel.jsx     ── Anomalies détectées + recommandations
 └── ControlPanel.jsx      ── Statut Kafka, mode LIVE/DRY_RUN, log d'actions
```

### Communication

**Fichier : `frontend/src/hooks/useMetrics.js`**

```javascript
export default function useMetrics() {
  const { latestMessage, wsStatus } = useWebSocket();

  // Mode 1: WebSocket push (temps-réel, ~15s)
  useEffect(() => {
    if (latestMessage?.type === 'METRICS_UPDATE') {
      setServices(latestMessage.payload.services);
      setTopology(latestMessage.payload.topology);
    }
  }, [latestMessage]);

  // Mode 2: REST polling (fallback si WebSocket déconnecté)
  useEffect(() => {
    if (wsStatus !== 'connected') {
      const timer = setInterval(async () => {
        const data = await fetchServicesSnapshot();
        applySnapshot(data);
      }, 15000);
      return () => clearInterval(timer);
    }
  }, [wsStatus]);
}
```

**Fichier : `frontend/src/api/client.js`**

```javascript
const BASE_URL = import.meta.env.VITE_API_URL || '/api';

export const fetchServicesSnapshot = () => apiFetch('/metrics/services');
export const fetchTopology = () => apiFetch('/topology');
export const fetchServiceDetail = (name) => apiFetch(`/metrics/service/${name}`);
export const runSimulation = (params) => apiFetch('/simulate', { method: 'POST', body: JSON.stringify(params) });
```

---

## Déploiement Docker

### Mode OTel Demo (connecté à une vraie architecture)

**Fichier : `docker-compose.otel-demo.yml`**

```yaml
services:
  kafka:          # KRaft mode (pas de Zookeeper)
    image: apache/kafka:3.7.0
    network: opentelemetry-demo   # même réseau que l'OTel Demo

  backend:
    environment:
      - PROMETHEUS_URL=http://prometheus:9090    # Prometheus de l'OTel Demo
      - JAEGER_URL=http://jaeger:16686/jaeger/ui # Jaeger de l'OTel Demo
      - KAFKA_BROKERS=kafka:9092                 # Notre Kafka
      - DEMO_MODE=false                          # Données réelles
      - DT_DRY_RUN=true                          # Contrôle en mode simulation
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock  # Pour le scaling
    network: opentelemetry-demo   # Se connecte au réseau existant

  frontend:
    ports: "3000:80"              # Dashboard accessible sur localhost:3000
```

### Mode Standalone (tout inclus)

**Fichier : `docker-compose.yml`** — inclut aussi :
- Prometheus + OTel Collector
- Jaeger
- Kafka + Kafka UI
- Redis (état courant)
- TimescaleDB (historique)
- ML Service (Isolation Forest)

---

## Schéma récapitulatif — Flux de données complet

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    ARCHITECTURE MICROSERVICES RÉELLE                      │
│    (OTel Demo: frontend, checkout, payment, cart, product-catalog...)     │
│                                                                         │
│    Instrumentée avec OpenTelemetry SDK                                   │
│    → Métriques envoyées à Prometheus (port 9090)                        │
│    → Traces envoyées à Jaeger (port 16686)                              │
└──────────────────────────┬────────────────────────┬─────────────────────┘
                           │                        │
                     PromQL queries          REST /api/dependencies
                           │                        │
┌──────────────────────────▼────────────────────────▼─────────────────────┐
│                      DIGITAL TWIN BACKEND                                │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │  COLLECTEUR (toutes les 15s)                                     │    │
│  │  prometheus-client.js → data-transformer.js → ServiceSnapshot    │    │
│  │  jaeger-client.js → topology-discovery.js → { nodes, edges }     │    │
│  └───────────────────────────────┬─────────────────────────────────┘    │
│                                  │                                       │
│  ┌───────────────────────────────▼─────────────────────────────────┐    │
│  │  KAFKA DIGITAL THREAD                                            │    │
│  │  KafkaPublisher → twin.metrics.* | twin.anomalies | twin.actions │    │
│  │  KafkaConsumer  → StateManager (Redis + TimescaleDB)             │    │
│  └───────────────────────────────┬─────────────────────────────────┘    │
│                                  │                                       │
│  ┌───────────────────────────────▼─────────────────────────────────┐    │
│  │  DÉTECTION D'ANOMALIES                                           │    │
│  │  Z-score + EWMA + Trend (Node.js) + Isolation Forest (Python ML) │    │
│  └───────────────────────────────┬─────────────────────────────────┘    │
│                                  │                                       │
│  ┌───────────────────────────────▼─────────────────────────────────┐    │
│  │  OPTIMISEUR + CONTRÔLE                                           │    │
│  │  optimization-engine.js → recommandations (scale_up, scale_down) │    │
│  │  ControlService.js → Docker API (scaling réel ou dry_run)        │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │  SIMULATEUR WHAT-IF                                              │    │
│  │  scenario-engine.js + performance-model.js (M/M/c)               │    │
│  │  → Prédit l'impact sans toucher la prod                          │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                         │
│  ── API REST (/api/*) + WebSocket (/ws) ──────────────────────────────  │
└──────────────────────────────────┬──────────────────────────────────────┘
                                   │
                          push WebSocket / polling REST
                                   │
┌──────────────────────────────────▼──────────────────────────────────────┐
│                       FRONTEND REACT (port 3000)                         │
│                                                                         │
│  ServiceMap ─ MetricsPanel ─ Charts ─ Simulator ─ Optimize ─ Control    │
└─────────────────────────────────────────────────────────────────────────┘
```
