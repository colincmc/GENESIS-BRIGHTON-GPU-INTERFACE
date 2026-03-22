/* ── GENESIS-BRIGHTON-GPU-INTERFACE — Types ──────────────────────── */
/* API contract between Brighton Protocol (CPU) and GPU acceleration  */
/* RAPIDS cuML for anomaly detection + clustering                     */
/* RAPIDS cuGraph for exchange/token relationship graphs              */

/* ── Brighton Native Types (mirror — never diverge) ─────────────── */

export type PatternType =
  | "EXCHANGE_PAIR_ALPHA"
  | "TEMPORAL_WINDOW"
  | "TOKEN_SPECIALIST"
  | "NETWORK_EFFICIENCY"
  | "FAILURE_CORRELATION"
  | "TRANSFER_TIME_PATTERN"
  | "SPREAD_DECAY"
  | "EXCHANGE_DARK_PATTERN";

export type ConfidenceLevel = "ANECDOTE" | "HYPOTHESIS" | "ACTIONABLE" | "DOCTRINE";

/* ── GPU Task Types ─────────────────────────────────────────────── */

/** What the GPU is being asked to do */
export type GpuTaskType =
  | "ANOMALY_DETECTION"       // cuML Isolation Forest / DBSCAN outlier detection
  | "TEMPORAL_CLUSTERING"     // cuML DBSCAN — discover natural time windows
  | "EXCHANGE_GRAPH"          // cuGraph PageRank — rank exchanges by profitability flow
  | "CORRELATION_MATRIX"      // cuML — cross-dimension correlation heatmap
  | "BATCH_SCORING"           // Parallel confidence re-score across all patterns
  | "SPREAD_FORECAST";        // cuML regression — predict spread decay curves

export type GpuTaskStatus = "QUEUED" | "PROCESSING" | "COMPLETED" | "FAILED" | "TIMED_OUT";

/* ── Columnar Batch Format (GPU-ready) ──────────────────────────── */
/* GPU acceleration requires columnar data — arrays of primitives,   */
/* not arrays of objects. Each field is a parallel array.             */
/* Row i across all arrays = one observation.                        */

/** Spread observations — primary feed for anomaly detection */
export interface SpreadBatch {
  batchId: string;
  rowCount: number;
  columns: {
    timestamp: number[];        // Unix ms
    buyExchange: string[];
    sellExchange: string[];
    pair: string[];
    token: string[];
    grossSpreadBps: number[];
    netSpreadBps: number[];
    realizedPnl: number[];      // USD
    transferTimeMs: number[];
    success: number[];           // 1 = success, 0 = failure (GPU-friendly boolean)
    network: string[];
    hourOfDay: number[];         // 0-23
    dayOfWeek: number[];         // 0-6
  };
}

/** Temporal observations — feed for temporal clustering */
export interface TemporalBatch {
  batchId: string;
  rowCount: number;
  columns: {
    exchangePair: string[];      // "binance→kraken"
    token: string[];
    hourOfDay: number[];
    dayOfWeek: number[];
    avgSpreadBps: number[];
    avgPnlUsd: number[];
    successRate: number[];       // 0.0-1.0
    occurrences: number[];
    avgTransferTimeMs: number[];
  };
}

/** Exchange graph edges — feed for cuGraph */
export interface GraphEdgeBatch {
  batchId: string;
  edgeCount: number;
  columns: {
    sourceExchange: string[];    // Node A
    targetExchange: string[];    // Node B
    pair: string[];
    totalOccurrences: number[];
    avgSpreadBps: number[];
    avgPnlUsd: number[];
    successRate: number[];
    avgTransferTimeMs: number[];
    lastSeen: number[];          // Unix ms
  };
}

/** Pattern batch — feed for batch scoring */
export interface PatternBatch {
  batchId: string;
  rowCount: number;
  columns: {
    patternId: string[];
    patternType: string[];       // PatternType as string for GPU
    occurrences: number[];
    avgSpreadBps: number[];
    avgPnlUsd: number[];
    successRate: number[];
    avgTransferTimeMs: number[];
    daysSinceLastSeen: number[];
    daysSinceFirstSeen: number[];
    currentScore: number[];      // 0-100
    active: number[];            // 1/0
  };
}

/* ── GPU Request / Response ─────────────────────────────────────── */

/** Request sent TO the GPU service */
export interface GpuRequest {
  requestId: string;
  taskType: GpuTaskType;
  createdAt: string;
  timeoutMs: number;
  parameters: GpuTaskParameters;
  data: SpreadBatch | TemporalBatch | GraphEdgeBatch | PatternBatch;
}

/** Task-specific parameters */
export interface GpuTaskParameters {
  // Anomaly detection (Isolation Forest)
  contamination?: number;        // Expected anomaly fraction (default 0.05)
  nEstimators?: number;          // Number of trees (default 100)

  // Temporal clustering (DBSCAN)
  eps?: number;                  // Neighbourhood radius (default 0.5)
  minSamples?: number;           // Min points per cluster (default 3)
  features?: string[];           // Which columns to cluster on

  // Exchange graph (PageRank)
  damping?: number;              // PageRank damping factor (default 0.85)
  maxIterations?: number;        // Max iterations (default 100)
  weightColumn?: string;         // Edge weight column (default "avgPnlUsd")

  // Correlation matrix
  columns?: string[];            // Which columns to correlate
  method?: "pearson" | "spearman"; // Correlation method (default "pearson")

  // Batch scoring
  halfLifeDays?: number;         // Time decay half-life (default 14)
  decayConstant?: number;        // Bayesian decay constant (default 10)

  // Spread forecast (regression)
  forecastHorizonMs?: number;    // How far ahead to predict (default 3600000 = 1h)
  modelType?: "linear" | "ridge" | "lasso"; // Regression model (default "ridge")
}

/** Response FROM the GPU service */
export interface GpuResponse {
  requestId: string;
  taskType: GpuTaskType;
  status: GpuTaskStatus;
  processingTimeMs: number;
  completedAt: string;
  result: GpuResult;
}

/** Task-specific results */
export type GpuResult =
  | AnomalyResult
  | ClusterResult
  | GraphResult
  | CorrelationResult
  | BatchScoreResult
  | ForecastResult;

/** Anomaly detection result */
export interface AnomalyResult {
  type: "ANOMALY_DETECTION";
  totalRows: number;
  anomalyCount: number;
  anomalyIndices: number[];      // Row indices flagged as anomalies
  anomalyScores: number[];       // Anomaly score per flagged row (0-1)
  topAnomalies: Array<{
    index: number;
    score: number;
    reason: string;              // Human-readable: "Spread 12x above mean"
    exchangePair: string;
    pair: string;
    spreadBps: number;
  }>;
}

/** Temporal clustering result */
export interface ClusterResult {
  type: "TEMPORAL_CLUSTERING";
  totalRows: number;
  clusterCount: number;
  noiseCount: number;
  clusters: Array<{
    clusterId: number;
    memberCount: number;
    centroid: Record<string, number>; // Feature name → centroid value
    description: string;         // "Wed-Thu 14:00-16:00 UTC, BTC routes"
    avgSpreadBps: number;
    avgPnlUsd: number;
  }>;
  labels: number[];              // Cluster label per row (-1 = noise)
}

/** Exchange graph result */
export interface GraphResult {
  type: "EXCHANGE_GRAPH";
  nodeCount: number;
  edgeCount: number;
  pageRank: Array<{
    exchange: string;
    rank: number;                // 0-1, sum = 1
    inDegree: number;
    outDegree: number;
    avgInboundPnl: number;
    avgOutboundPnl: number;
  }>;
  strongestEdges: Array<{
    source: string;
    target: string;
    weight: number;
    avgPnlUsd: number;
    occurrences: number;
  }>;
  communities: Array<{
    communityId: number;
    exchanges: string[];
    internalEdges: number;
  }>;
}

/** Correlation matrix result */
export interface CorrelationResult {
  type: "CORRELATION_MATRIX";
  columns: string[];
  matrix: number[][];            // N×N correlation values (-1 to 1)
  significantPairs: Array<{
    columnA: string;
    columnB: string;
    correlation: number;
    pValue: number;
  }>;
}

/** Batch scoring result */
export interface BatchScoreResult {
  type: "BATCH_SCORING";
  totalPatterns: number;
  scores: Array<{
    patternId: string;
    oldScore: number;
    newScore: number;
    newConfidence: ConfidenceLevel;
    promoted: boolean;           // Score crossed upward threshold
    demoted: boolean;            // Score crossed downward threshold
  }>;
  promotions: number;
  demotions: number;
  expired: number;               // Patterns decayed below minimum
}

/** Spread forecast result */
export interface ForecastResult {
  type: "SPREAD_FORECAST";
  forecastCount: number;
  forecasts: Array<{
    exchangePair: string;
    pair: string;
    currentSpreadBps: number;
    forecastSpreadBps: number;
    forecastTimestamp: string;
    confidenceInterval: { low: number; high: number };
    decayRatePerHour: number;    // bps lost per hour
    recommendation: "EXECUTE_NOW" | "WAIT" | "STALE";
  }>;
}

/* ── Streaming Format (for real-time GPU pipeline) ──────────────── */

/** Single event for streaming ingestion (vs batch) */
export interface StreamEvent {
  eventId: string;
  timestamp: number;
  buyExchange: string;
  sellExchange: string;
  pair: string;
  token: string;
  grossSpreadBps: number;
  netSpreadBps: number;
  realizedPnl: number;
  transferTimeMs: number;
  success: boolean;
  network: string;
}

/** Streaming window configuration */
export interface StreamConfig {
  windowSizeMs: number;          // Tumbling window size (default 60000 = 1 min)
  slideMs: number;               // Slide interval (default 10000 = 10s)
  minEventsPerWindow: number;    // Minimum events before GPU processes (default 10)
  maxBufferSize: number;         // Max events buffered before force-flush (default 10000)
}

/** Streaming result — emitted per window */
export interface StreamWindowResult {
  windowId: string;
  windowStart: number;
  windowEnd: number;
  eventCount: number;
  anomaliesDetected: number;
  topAnomaly: {
    exchangePair: string;
    pair: string;
    spreadBps: number;
    score: number;
  } | null;
  avgSpreadBps: number;
  avgPnlUsd: number;
}

/* ── Interface Service State ────────────────────────────────────── */

export interface InterfaceState {
  gpuAvailable: boolean;
  gpuUrl: string | null;
  brightonUrl: string | null;
  mode: "PASSTHROUGH" | "GPU_ACCELERATED" | "FALLBACK";
  totalRequestsSent: number;
  totalResponsesReceived: number;
  totalErrors: number;
  avgGpuLatencyMs: number;
  lastRequestAt: string | null;
  lastResponseAt: string | null;
  queueDepth: number;
  uptime: number;
}
