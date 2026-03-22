/* ── GENESIS-BRIGHTON-GPU-INTERFACE — Adapter Service ────────────── */
/* Translates Brighton Protocol data into GPU-ready columnar batches  */
/* and dispatches to GPU service. Runs CPU-side.                      */

import { randomUUID } from "crypto";
import {
  SpreadBatch,
  TemporalBatch,
  GraphEdgeBatch,
  PatternBatch,
  GpuRequest,
  GpuResponse,
  GpuTaskType,
  GpuTaskParameters,
  GpuTaskStatus,
  StreamEvent,
  StreamConfig,
  StreamWindowResult,
  InterfaceState,
} from "../types";

const DEFAULT_STREAM_CONFIG: StreamConfig = {
  windowSizeMs: parseInt(process.env.STREAM_WINDOW_MS || "60000", 10),
  slideMs: parseInt(process.env.STREAM_SLIDE_MS || "10000", 10),
  minEventsPerWindow: parseInt(process.env.STREAM_MIN_EVENTS || "10", 10),
  maxBufferSize: parseInt(process.env.STREAM_MAX_BUFFER || "10000", 10),
};

export class AdapterService {
  private gpuUrl: string | null;
  private brightonUrl: string | null;
  private totalRequestsSent = 0;
  private totalResponsesReceived = 0;
  private totalErrors = 0;
  private gpuLatencies: number[] = [];
  private lastRequestAt: string | null = null;
  private lastResponseAt: string | null = null;
  private queue: GpuRequest[] = [];
  private streamBuffer: StreamEvent[] = [];
  private streamConfig: StreamConfig;
  private streamInterval: ReturnType<typeof setInterval> | null = null;
  private startedAt = Date.now();
  private gpuTimeoutMs: number;

  constructor() {
    this.gpuUrl = process.env.GPU_URL || null;
    this.brightonUrl = process.env.BRIGHTON_URL || null;
    this.streamConfig = { ...DEFAULT_STREAM_CONFIG };
    this.gpuTimeoutMs = parseInt(process.env.GPU_TIMEOUT_MS || "30000", 10);
  }

  /* ── Brighton → Columnar Conversion ────────────────────────────── */

  /** Convert Brighton pattern data to spread batch (for anomaly detection) */
  buildSpreadBatch(events: any[]): SpreadBatch {
    const batch: SpreadBatch = {
      batchId: randomUUID(),
      rowCount: events.length,
      columns: {
        timestamp: [],
        buyExchange: [],
        sellExchange: [],
        pair: [],
        token: [],
        grossSpreadBps: [],
        netSpreadBps: [],
        realizedPnl: [],
        transferTimeMs: [],
        success: [],
        network: [],
        hourOfDay: [],
        dayOfWeek: [],
      },
    };

    for (const e of events) {
      const payload = e.payload || e;
      const ts = new Date(e.receivedAt || e.timestamp || Date.now());

      batch.columns.timestamp.push(ts.getTime());
      batch.columns.buyExchange.push(String(payload.buyExchange || "unknown"));
      batch.columns.sellExchange.push(String(payload.sellExchange || "unknown"));
      batch.columns.pair.push(String(payload.pair || "UNKNOWN"));
      batch.columns.token.push(String(payload.token || this.extractToken(payload.pair)));
      batch.columns.grossSpreadBps.push(Number(payload.grossSpreadBps) || 0);
      batch.columns.netSpreadBps.push(Number(payload.netSpreadBps) || 0);
      batch.columns.realizedPnl.push(Number(payload.realizedPnl) || 0);
      batch.columns.transferTimeMs.push(Number(payload.transferTimeMs) || 0);
      batch.columns.success.push(payload.status === "FILLED" || payload.status === "SUCCESS" ? 1 : 0);
      batch.columns.network.push(String(payload.network || "unknown"));
      batch.columns.hourOfDay.push(ts.getUTCHours());
      batch.columns.dayOfWeek.push(ts.getUTCDay());
    }

    return batch;
  }

  /** Convert Brighton temporal buckets to temporal batch (for clustering) */
  buildTemporalBatch(buckets: any[]): TemporalBatch {
    const batch: TemporalBatch = {
      batchId: randomUUID(),
      rowCount: buckets.length,
      columns: {
        exchangePair: [],
        token: [],
        hourOfDay: [],
        dayOfWeek: [],
        avgSpreadBps: [],
        avgPnlUsd: [],
        successRate: [],
        occurrences: [],
        avgTransferTimeMs: [],
      },
    };

    for (const b of buckets) {
      batch.columns.exchangePair.push(String(b.exchangePair || b.route || "unknown"));
      batch.columns.token.push(String(b.token || "UNKNOWN"));
      batch.columns.hourOfDay.push(Number(b.hourOfDay ?? b.hour ?? 0));
      batch.columns.dayOfWeek.push(Number(b.dayOfWeek ?? b.day ?? 0));
      batch.columns.avgSpreadBps.push(Number(b.avgSpreadBps ?? b.avgSpread ?? 0));
      batch.columns.avgPnlUsd.push(Number(b.avgPnlUsd ?? b.avgPnl ?? 0));
      batch.columns.successRate.push(Number(b.successRate ?? 0));
      batch.columns.occurrences.push(Number(b.occurrences ?? b.count ?? 0));
      batch.columns.avgTransferTimeMs.push(Number(b.avgTransferTimeMs ?? 0));
    }

    return batch;
  }

  /** Convert Brighton exchange pair stats to graph edges (for cuGraph) */
  buildGraphEdgeBatch(pairStats: any[]): GraphEdgeBatch {
    const batch: GraphEdgeBatch = {
      batchId: randomUUID(),
      edgeCount: pairStats.length,
      columns: {
        sourceExchange: [],
        targetExchange: [],
        pair: [],
        totalOccurrences: [],
        avgSpreadBps: [],
        avgPnlUsd: [],
        successRate: [],
        avgTransferTimeMs: [],
        lastSeen: [],
      },
    };

    for (const ps of pairStats) {
      const [source, target] = this.splitExchangePair(ps.exchangePair || ps.route || "unknown→unknown");
      batch.columns.sourceExchange.push(source);
      batch.columns.targetExchange.push(target);
      batch.columns.pair.push(String(ps.pair || ps.token || "ALL"));
      batch.columns.totalOccurrences.push(Number(ps.occurrences ?? ps.count ?? 0));
      batch.columns.avgSpreadBps.push(Number(ps.avgSpreadBps ?? ps.avgSpread ?? 0));
      batch.columns.avgPnlUsd.push(Number(ps.avgPnlUsd ?? ps.avgPnl ?? 0));
      batch.columns.successRate.push(Number(ps.successRate ?? 0));
      batch.columns.avgTransferTimeMs.push(Number(ps.avgTransferTimeMs ?? 0));
      batch.columns.lastSeen.push(new Date(ps.lastSeen || Date.now()).getTime());
    }

    return batch;
  }

  /** Convert Brighton patterns to pattern batch (for batch scoring) */
  buildPatternBatch(patterns: any[]): PatternBatch {
    const now = Date.now();
    const batch: PatternBatch = {
      batchId: randomUUID(),
      rowCount: patterns.length,
      columns: {
        patternId: [],
        patternType: [],
        occurrences: [],
        avgSpreadBps: [],
        avgPnlUsd: [],
        successRate: [],
        avgTransferTimeMs: [],
        daysSinceLastSeen: [],
        daysSinceFirstSeen: [],
        currentScore: [],
        active: [],
      },
    };

    for (const p of patterns) {
      const evidence = p.evidence || {};
      const lastSeen = new Date(evidence.lastSeen || p.updatedAt || now).getTime();
      const firstSeen = new Date(evidence.firstSeen || p.createdAt || now).getTime();

      batch.columns.patternId.push(String(p.id || p.patternId || randomUUID()));
      batch.columns.patternType.push(String(p.type || p.patternType || "UNKNOWN"));
      batch.columns.occurrences.push(Number(evidence.occurrences ?? 0));
      batch.columns.avgSpreadBps.push(Number(evidence.avgSpreadBps ?? 0));
      batch.columns.avgPnlUsd.push(Number(evidence.avgPnlUsd ?? 0));
      batch.columns.successRate.push(Number(evidence.successRate ?? 0));
      batch.columns.avgTransferTimeMs.push(Number(evidence.avgTransferTimeMs ?? 0));
      batch.columns.daysSinceLastSeen.push((now - lastSeen) / 86400000);
      batch.columns.daysSinceFirstSeen.push((now - firstSeen) / 86400000);
      batch.columns.currentScore.push(Number(p.confidenceScore ?? p.score ?? 0));
      batch.columns.active.push(p.active !== false ? 1 : 0);
    }

    return batch;
  }

  /* ── GPU Dispatch ──────────────────────────────────────────────── */

  /** Build and send a GPU request */
  async dispatch(
    taskType: GpuTaskType,
    data: SpreadBatch | TemporalBatch | GraphEdgeBatch | PatternBatch,
    parameters?: Partial<GpuTaskParameters>
  ): Promise<GpuResponse> {
    const request: GpuRequest = {
      requestId: randomUUID(),
      taskType,
      createdAt: new Date().toISOString(),
      timeoutMs: this.gpuTimeoutMs,
      parameters: { ...this.getDefaultParameters(taskType), ...parameters },
      data,
    };

    return this.sendToGpu(request);
  }

  /** Send request to GPU service */
  private async sendToGpu(request: GpuRequest): Promise<GpuResponse> {
    if (!this.gpuUrl) {
      return this.buildFallbackResponse(request, "GPU_URL not configured — running in PASSTHROUGH mode");
    }

    this.totalRequestsSent++;
    this.lastRequestAt = new Date().toISOString();
    this.queue.push(request);

    const start = Date.now();
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), request.timeoutMs);

      const res = await fetch(`${this.gpuUrl}/compute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      const elapsed = Date.now() - start;
      this.recordLatency(elapsed);
      this.removeFromQueue(request.requestId);

      if (!res.ok) {
        this.totalErrors++;
        return this.buildFallbackResponse(request, `GPU returned HTTP ${res.status}`);
      }

      const response = (await res.json()) as GpuResponse;
      this.totalResponsesReceived++;
      this.lastResponseAt = new Date().toISOString();

      console.log(`[BRIGHTON-GPU] Task ${request.taskType} completed in ${elapsed}ms`);
      return response;
    } catch (err: any) {
      const elapsed = Date.now() - start;
      this.recordLatency(elapsed);
      this.removeFromQueue(request.requestId);
      this.totalErrors++;

      const reason = err.name === "AbortError" ? "GPU_TIMEOUT" : (err.message || "GPU_UNREACHABLE");
      console.warn(`[BRIGHTON-GPU] Task ${request.taskType} failed: ${reason}`);
      return this.buildFallbackResponse(request, reason);
    }
  }

  /* ── Pull from Brighton ────────────────────────────────────────── */

  /** Fetch patterns from Brighton and run batch scoring on GPU */
  async pullAndScore(parameters?: Partial<GpuTaskParameters>): Promise<GpuResponse> {
    const patterns = await this.fetchBrightonPatterns();
    if (patterns.length === 0) {
      return this.buildFallbackResponse(
        { requestId: randomUUID(), taskType: "BATCH_SCORING" },
        "No patterns available from Brighton"
      );
    }
    const batch = this.buildPatternBatch(patterns);
    return this.dispatch("BATCH_SCORING", batch, parameters);
  }

  /** Fetch intelligence from Brighton and run anomaly detection */
  async pullAndDetectAnomalies(parameters?: Partial<GpuTaskParameters>): Promise<GpuResponse> {
    const events = await this.fetchBrightonEvents();
    if (events.length === 0) {
      return this.buildFallbackResponse(
        { requestId: randomUUID(), taskType: "ANOMALY_DETECTION" },
        "No events available from Brighton"
      );
    }
    const batch = this.buildSpreadBatch(events);
    return this.dispatch("ANOMALY_DETECTION", batch, parameters);
  }

  /** Fetch from Brighton /patterns endpoint */
  private async fetchBrightonPatterns(): Promise<any[]> {
    if (!this.brightonUrl) return [];
    try {
      const res = await fetch(`${this.brightonUrl}/patterns?limit=5000`);
      if (!res.ok) return [];
      const data = (await res.json()) as any;
      return Array.isArray(data) ? data : (data.patterns || []);
    } catch {
      console.warn("[BRIGHTON-GPU] Failed to fetch Brighton patterns");
      return [];
    }
  }

  /** Fetch from Brighton /intelligence endpoint */
  private async fetchBrightonEvents(): Promise<any[]> {
    if (!this.brightonUrl) return [];
    try {
      const res = await fetch(`${this.brightonUrl}/intelligence`);
      if (!res.ok) return [];
      const data = (await res.json()) as any;
      return data.recentEvents || data.events || [];
    } catch {
      console.warn("[BRIGHTON-GPU] Failed to fetch Brighton intelligence");
      return [];
    }
  }

  /* ── Streaming Interface ───────────────────────────────────────── */

  /** Accept a single event into the streaming buffer */
  ingestStreamEvent(event: StreamEvent): void {
    this.streamBuffer.push(event);
    if (this.streamBuffer.length >= this.streamConfig.maxBufferSize) {
      this.flushStreamBuffer();
    }
  }

  /** Start the streaming window processor */
  startStreaming(): void {
    if (this.streamInterval) return;
    console.log(`[BRIGHTON-GPU] Streaming started (window=${this.streamConfig.windowSizeMs}ms, slide=${this.streamConfig.slideMs}ms)`);
    this.streamInterval = setInterval(() => this.processStreamWindow(), this.streamConfig.slideMs);
  }

  /** Stop streaming */
  stopStreaming(): void {
    if (this.streamInterval) {
      clearInterval(this.streamInterval);
      this.streamInterval = null;
      console.log("[BRIGHTON-GPU] Streaming stopped");
    }
  }

  private async processStreamWindow(): Promise<void> {
    const now = Date.now();
    const windowStart = now - this.streamConfig.windowSizeMs;

    // Filter events within window
    const windowEvents = this.streamBuffer.filter(e => e.timestamp >= windowStart);

    if (windowEvents.length < this.streamConfig.minEventsPerWindow) return;

    // Convert to spread batch and dispatch
    const brightonEvents = windowEvents.map(e => ({
      receivedAt: new Date(e.timestamp).toISOString(),
      payload: {
        buyExchange: e.buyExchange,
        sellExchange: e.sellExchange,
        pair: e.pair,
        token: e.token,
        grossSpreadBps: e.grossSpreadBps,
        netSpreadBps: e.netSpreadBps,
        realizedPnl: e.realizedPnl,
        transferTimeMs: e.transferTimeMs,
        status: e.success ? "FILLED" : "FAILED",
        network: e.network,
      },
    }));

    const batch = this.buildSpreadBatch(brightonEvents);
    await this.dispatch("ANOMALY_DETECTION", batch, { contamination: 0.05, nEstimators: 50 });

    // Trim old events from buffer
    this.streamBuffer = this.streamBuffer.filter(e => e.timestamp >= windowStart);
  }

  private flushStreamBuffer(): void {
    const cutoff = Date.now() - this.streamConfig.windowSizeMs * 2;
    this.streamBuffer = this.streamBuffer.filter(e => e.timestamp >= cutoff);
  }

  /* ── Helpers ───────────────────────────────────────────────────── */

  private extractToken(pair?: string): string {
    if (!pair) return "UNKNOWN";
    // BTCUSDT → BTC, ETH-USD → ETH
    return pair.replace(/[-_/]?(USDT|USD|USDC|BUSD|EUR|GBP|BTC|ETH)$/i, "") || pair;
  }

  private splitExchangePair(route: string): [string, string] {
    const parts = route.split("→");
    return [parts[0] || "unknown", parts[1] || "unknown"];
  }

  private getDefaultParameters(taskType: GpuTaskType): GpuTaskParameters {
    switch (taskType) {
      case "ANOMALY_DETECTION":
        return { contamination: 0.05, nEstimators: 100 };
      case "TEMPORAL_CLUSTERING":
        return { eps: 0.5, minSamples: 3, features: ["hourOfDay", "dayOfWeek", "avgSpreadBps"] };
      case "EXCHANGE_GRAPH":
        return { damping: 0.85, maxIterations: 100, weightColumn: "avgPnlUsd" };
      case "CORRELATION_MATRIX":
        return { method: "pearson", columns: ["grossSpreadBps", "netSpreadBps", "realizedPnl", "transferTimeMs"] };
      case "BATCH_SCORING":
        return { halfLifeDays: 14, decayConstant: 10 };
      case "SPREAD_FORECAST":
        return { forecastHorizonMs: 3600000, modelType: "ridge" };
    }
  }

  private buildFallbackResponse(request: Pick<GpuRequest, "requestId" | "taskType">, reason: string): GpuResponse {
    return {
      requestId: request.requestId,
      taskType: request.taskType,
      status: "FAILED" as GpuTaskStatus,
      processingTimeMs: 0,
      completedAt: new Date().toISOString(),
      result: {
        type: request.taskType as any,
        error: reason,
        fallback: true,
      } as any,
    };
  }

  private recordLatency(ms: number): void {
    this.gpuLatencies.push(ms);
    if (this.gpuLatencies.length > 100) this.gpuLatencies.shift();
  }

  private removeFromQueue(requestId: string): void {
    this.queue = this.queue.filter(r => r.requestId !== requestId);
  }

  /* ── State ─────────────────────────────────────────────────────── */

  getState(): InterfaceState {
    const avgLatency = this.gpuLatencies.length > 0
      ? this.gpuLatencies.reduce((a, b) => a + b, 0) / this.gpuLatencies.length
      : 0;

    return {
      gpuAvailable: this.gpuUrl !== null,
      gpuUrl: this.gpuUrl,
      brightonUrl: this.brightonUrl,
      mode: this.gpuUrl ? "GPU_ACCELERATED" : "PASSTHROUGH",
      totalRequestsSent: this.totalRequestsSent,
      totalResponsesReceived: this.totalResponsesReceived,
      totalErrors: this.totalErrors,
      avgGpuLatencyMs: parseFloat(avgLatency.toFixed(1)),
      lastRequestAt: this.lastRequestAt,
      lastResponseAt: this.lastResponseAt,
      queueDepth: this.queue.length,
      uptime: Date.now() - this.startedAt,
    };
  }

  getStreamConfig(): StreamConfig {
    return { ...this.streamConfig };
  }

  isGpuAvailable(): boolean {
    return this.gpuUrl !== null;
  }
}
