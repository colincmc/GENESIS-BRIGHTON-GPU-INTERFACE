/* ── GENESIS-BRIGHTON-GPU-INTERFACE — Express Server ─────────────── */
/* CPU-side adapter between Brighton Protocol and GPU acceleration.   */
/* Translates Brighton data → columnar batches → GPU service.         */
/* When GPU_URL is not set, runs in PASSTHROUGH mode (no-op).         */

import express from "express";
import { AdapterService } from "./services/adapter.service";
import { GpuTaskType } from "./types";

const app = express();
app.use(express.json({ limit: "50mb" }));

const PORT = parseInt(process.env.PORT || "8786", 10);
const adapter = new AdapterService();

/* ── Health & State ──────────────────────────────────────────────── */

app.get("/health", (_req, res) => {
  const state = adapter.getState();
  res.json({
    service: "genesis-brighton-gpu-interface",
    status: "UP",
    mode: state.mode,
    gpuAvailable: state.gpuAvailable,
    requestsSent: state.totalRequestsSent,
    responsesReceived: state.totalResponsesReceived,
    errors: state.totalErrors,
    avgGpuLatencyMs: state.avgGpuLatencyMs,
    uptime: state.uptime,
  });
});

app.get("/state", (_req, res) => {
  res.json(adapter.getState());
});

/* ── Batch Conversion Endpoints (Brighton → Columnar) ────────────── */
/* These accept Brighton-format data and return GPU-ready batches.     */
/* Used by Brighton Protocol to prepare data before GPU dispatch.      */

app.post("/convert/spreads", (req, res) => {
  const events = req.body.events || req.body;
  if (!Array.isArray(events)) return res.status(400).json({ error: "events array required" });
  const batch = adapter.buildSpreadBatch(events);
  res.json(batch);
});

app.post("/convert/temporal", (req, res) => {
  const buckets = req.body.buckets || req.body;
  if (!Array.isArray(buckets)) return res.status(400).json({ error: "buckets array required" });
  const batch = adapter.buildTemporalBatch(buckets);
  res.json(batch);
});

app.post("/convert/graph", (req, res) => {
  const edges = req.body.edges || req.body;
  if (!Array.isArray(edges)) return res.status(400).json({ error: "edges array required" });
  const batch = adapter.buildGraphEdgeBatch(edges);
  res.json(batch);
});

app.post("/convert/patterns", (req, res) => {
  const patterns = req.body.patterns || req.body;
  if (!Array.isArray(patterns)) return res.status(400).json({ error: "patterns array required" });
  const batch = adapter.buildPatternBatch(patterns);
  res.json(batch);
});

/* ── GPU Dispatch Endpoints ──────────────────────────────────────── */
/* Accept pre-built batches and forward to GPU service.                */

app.post("/dispatch", async (req, res) => {
  const { taskType, data, parameters } = req.body;
  if (!taskType || !data) return res.status(400).json({ error: "taskType and data required" });

  const validTasks: GpuTaskType[] = [
    "ANOMALY_DETECTION", "TEMPORAL_CLUSTERING", "EXCHANGE_GRAPH",
    "CORRELATION_MATRIX", "BATCH_SCORING", "SPREAD_FORECAST",
  ];
  if (!validTasks.includes(taskType)) {
    return res.status(400).json({ error: `Invalid taskType. Valid: ${validTasks.join(", ")}` });
  }

  const response = await adapter.dispatch(taskType, data, parameters);
  res.json(response);
});

/* ── Pull-and-Process Endpoints (Brighton → GPU in one call) ─────── */
/* Fetches data from Brighton, converts to batch, dispatches to GPU.   */

app.post("/pull/score", async (req, res) => {
  const response = await adapter.pullAndScore(req.body.parameters);
  res.json(response);
});

app.post("/pull/anomalies", async (req, res) => {
  const response = await adapter.pullAndDetectAnomalies(req.body.parameters);
  res.json(response);
});

/* ── Streaming Endpoints ─────────────────────────────────────────── */

app.post("/stream/ingest", (req, res) => {
  const event = req.body;
  if (!event || !event.eventId) return res.status(400).json({ error: "StreamEvent required" });
  adapter.ingestStreamEvent(event);
  res.json({ accepted: true });
});

app.post("/stream/ingest/batch", (req, res) => {
  const events = req.body.events || req.body;
  if (!Array.isArray(events)) return res.status(400).json({ error: "events array required" });
  for (const event of events) adapter.ingestStreamEvent(event);
  res.json({ accepted: events.length });
});

app.post("/stream/start", (_req, res) => {
  adapter.startStreaming();
  res.json({ streaming: true, config: adapter.getStreamConfig() });
});

app.post("/stream/stop", (_req, res) => {
  adapter.stopStreaming();
  res.json({ streaming: false });
});

app.get("/stream/config", (_req, res) => {
  res.json(adapter.getStreamConfig());
});

/* ── API Contract Documentation ──────────────────────────────────── */

app.get("/contract", (_req, res) => {
  res.json({
    service: "genesis-brighton-gpu-interface",
    version: "1.0.0",
    description: "API contract between Brighton Protocol (CPU) and GPU acceleration (RAPIDS cuML/cuGraph)",
    modes: {
      PASSTHROUGH: "GPU_URL not set — conversion endpoints work, dispatch returns fallback response",
      GPU_ACCELERATED: "GPU_URL set — full pipeline active",
      FALLBACK: "GPU was available but went down — Spine Heartbeat triggers fallback",
    },
    gpuTaskTypes: {
      ANOMALY_DETECTION: "cuML Isolation Forest — detect spread/PnL outliers in execution data",
      TEMPORAL_CLUSTERING: "cuML DBSCAN — discover natural time windows for profitable trading",
      EXCHANGE_GRAPH: "cuGraph PageRank — rank exchanges by profitability flow",
      CORRELATION_MATRIX: "cuML — cross-dimension correlation heatmap (spread×time×network×token)",
      BATCH_SCORING: "Parallel confidence re-scoring with Bayesian time decay",
      SPREAD_FORECAST: "cuML Ridge regression — predict spread decay curves",
    },
    batchFormats: {
      SpreadBatch: "Columnar execution events — 13 parallel arrays (timestamp, exchanges, spread, PnL, etc.)",
      TemporalBatch: "Columnar temporal buckets — 9 parallel arrays (time slots, stats)",
      GraphEdgeBatch: "Columnar exchange graph edges — 9 parallel arrays (source, target, weights)",
      PatternBatch: "Columnar Brighton patterns — 11 parallel arrays (IDs, scores, evidence)",
    },
    streamingFormat: {
      protocol: "HTTP POST per event or batch",
      windowSize: "Configurable tumbling window (default 60s)",
      slideInterval: "Configurable slide (default 10s)",
      processing: "Anomaly detection per window",
    },
    endpoints: {
      "GET /health": "Service health + GPU availability",
      "GET /state": "Full interface state",
      "GET /contract": "This API contract documentation",
      "POST /convert/spreads": "Brighton events → SpreadBatch columnar",
      "POST /convert/temporal": "Brighton temporal buckets → TemporalBatch columnar",
      "POST /convert/graph": "Brighton exchange pairs → GraphEdgeBatch columnar",
      "POST /convert/patterns": "Brighton patterns → PatternBatch columnar",
      "POST /dispatch": "Send pre-built batch to GPU (taskType + data + parameters)",
      "POST /pull/score": "Pull patterns from Brighton → batch score on GPU",
      "POST /pull/anomalies": "Pull events from Brighton → anomaly detection on GPU",
      "POST /stream/ingest": "Accept single streaming event",
      "POST /stream/ingest/batch": "Accept batch of streaming events",
      "POST /stream/start": "Start streaming window processor",
      "POST /stream/stop": "Stop streaming window processor",
      "GET /stream/config": "Current streaming configuration",
    },
  });
});

/* ── Start ───────────────────────────────────────────────────────── */

app.listen(PORT, () => {
  const state = adapter.getState();
  console.log(`[BRIGHTON-GPU-INTERFACE] Listening on port ${PORT}`);
  console.log(`[BRIGHTON-GPU-INTERFACE] Mode: ${state.mode}`);
  console.log(`[BRIGHTON-GPU-INTERFACE] GPU: ${state.gpuAvailable ? state.gpuUrl : "not configured (PASSTHROUGH)"}`);
  console.log(`[BRIGHTON-GPU-INTERFACE] Brighton: ${state.brightonUrl || "not configured"}`);
});
