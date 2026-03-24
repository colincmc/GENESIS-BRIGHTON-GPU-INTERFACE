# GENESIS-BRIGHTON-GPU-INTERFACE

**RAPIDS columnar adapter — converts Brighton Protocol intelligence into GPU-ready batch formats**

**Port:** `8786`

> **NVIDIA Phase 2A** — This service is a GPU-readiness pipe. It defines schemas, formats, and CPU-side logic that will activate when NVIDIA RAPIDS / NeMo / Warp hardware arrives. Phase 0 runs pure TypeScript on CPU.

---

## What It Does

1. Converts Brighton Protocol pattern data into 4 GPU-ready columnar batch formats (SpreadBatch, TemporalBatch, GraphEdgeBatch, PatternBatch)
2. Dispatches columnar batches to GPU service for 6 task types: ANOMALY_DETECTION, TEMPORAL_CLUSTERING, EXCHANGE_GRAPH, CORRELATION_MATRIX, BATCH_SCORING, SPREAD_FORECAST
3. Pulls intelligence directly from Brighton Protocol endpoints (/patterns, /intelligence) for autonomous batch scoring and anomaly detection
4. Provides a streaming interface with configurable sliding windows for continuous real-time anomaly detection
5. Operates in PASSTHROUGH mode when GPU is unavailable, returning structured fallback responses
6. Tracks GPU request/response latency, queue depth, and error rates for operational monitoring
7. Exposes the full API contract documentation at /api-contract for consumer integration

---

## Architecture

| File | Purpose | Lines |
|------|---------|-------|
| `src/index.ts` | Express server — 17 endpoints for conversion, dispatch, pull-and-process, streaming, API contract | 192 |
| `src/types.ts` | 4 columnar batch schemas (13/9/9/11 column arrays), 6 GPU task types, request/response/streaming types | 338 |
| `src/services/adapter.service.ts` | Core engine — Brighton-to-columnar conversion, GPU dispatch with timeout/fallback, Brighton pull, sliding window streaming | 482 |
| `package.json` | Express dependency | 18 |
| `Dockerfile` | node:20.20.0-slim, EXPOSE 8786 | 10 |

---

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | Service health + state summary |
| GET | `/state` | Full interface state (GPU availability, latency, queue depth) |
| POST | `/convert/spreads` | Convert Brighton events to SpreadBatch (13 columns) |
| POST | `/convert/temporal` | Convert Brighton temporal buckets to TemporalBatch (9 columns) |
| POST | `/convert/graph` | Convert Brighton pair stats to GraphEdgeBatch (9 columns) |
| POST | `/convert/patterns` | Convert Brighton patterns to PatternBatch (11 columns) |
| POST | `/dispatch` | Send a columnar batch to GPU for processing |
| POST | `/pull-and-score` | Fetch Brighton patterns and run GPU batch scoring |
| POST | `/pull-and-detect` | Fetch Brighton events and run GPU anomaly detection |
| POST | `/stream/event` | Ingest a single event into the streaming buffer |
| POST | `/stream/start` | Start the sliding window streaming processor |
| POST | `/stream/stop` | Stop the streaming processor |
| GET | `/stream/config` | Get current streaming configuration |
| GET | `/gpu/available` | Check if GPU service is reachable |
| GET | `/api-contract` | Full API contract documentation (all batch schemas, task types) |
| GET | `/briefing` | Operational briefing (mode, stats, stream config) |
| GET | `/config` | Service configuration |

---

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `8786` | HTTP listen port |
| `GPU_URL` | `null` | GPU compute service URL (RAPIDS/cuML endpoint) |
| `BRIGHTON_URL` | `null` | Brighton Protocol URL for pull operations |
| `GPU_TIMEOUT_MS` | `30000` | GPU request timeout in milliseconds |
| `STREAM_WINDOW_MS` | `60000` | Streaming window size (ms) |
| `STREAM_SLIDE_MS` | `10000` | Streaming window slide interval (ms) |
| `STREAM_MIN_EVENTS` | `10` | Minimum events per window to trigger processing |
| `STREAM_MAX_BUFFER` | `10000` | Maximum streaming buffer size before forced flush |

---

## Integration

- **Reads from:** Brighton Protocol (/patterns, /intelligence), GPU compute service (/compute)
- **Writes to:** GPU compute service (columnar batch dispatch)
- **Consumed by:** Any service needing GPU-accelerated analysis of Brighton intelligence
- **GPU future:** Direct RAPIDS cuDF DataFrames (Phase 2+), Morpheus streaming pipeline (Phase 3+)

---

## Current State

- **Phase 0 BUILT** — CPU-side TypeScript, fully operational
- 4 columnar batch formats matching RAPIDS cuDF schema expectations
- 6 GPU task types with per-task default parameters (contamination, eps, damping, method, halfLife, forecastHorizon)
- PASSTHROUGH mode when GPU unavailable (structured fallback responses)
- Sliding window streaming with configurable window/slide/min-events
- Brighton pull operations for autonomous batch scoring and anomaly detection

---

## Future Editions

1. **RAPIDS cuDF direct** — output native cuDF DataFrames instead of JSON columnar arrays
2. **Morpheus streaming pipeline** — replace sliding window with Morpheus real-time inference pipeline
3. **cuGraph exchange graph** — feed GraphEdgeBatch directly into cuGraph for PageRank/community detection
4. **TensorRT spread forecast** — deploy trained spread prediction model via TensorRT for sub-millisecond inference
5. **Multi-GPU dispatch** — route different task types to specialised GPU workers (RAPIDS vs NeMo vs Warp)

---

## Rail Deployment

| Rail | Status | Notes |
|------|--------|-------|
| Rail 1 | BUILT | CPU columnar conversion, PASSTHROUGH mode, 4 batch formats |
| Rail 3 | GPU activation | RAPIDS cuDF, cuML anomaly detection, cuGraph exchange graph |
| Rail 5+ | Full NVIDIA stack | Morpheus streaming, TensorRT inference, multi-GPU dispatch |
