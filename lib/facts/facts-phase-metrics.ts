export type FactsMetricPhase =
  | "cache_lock"
  | "git_scan"
  | "cache_load"
  | "source_index"
  | "manifest"
  | "module_resolution"
  | "snapshot_validation"
  | "cache_save"
  | "queue_wait"
  | "query_lookup"
  | "history_save";

export interface FactsPhaseMetricAggregate {
  count: number;
  totalMs: number;
  maxMs: number;
}

export interface FactsPhaseMetricsSnapshot {
  refreshTotal: number;
  phases: Partial<Record<FactsMetricPhase, FactsPhaseMetricAggregate>>;
}

// Durations aggregate across sync attempts: a drift retry re-records the
// repeated phases, so per-phase counts may exceed refreshTotal by design.
// cache_lock spans the whole locked refresh and therefore nests the inner
// phase timings; queue_wait measures pending-chain wait before the chain runs.
export class FactsPhaseMetrics {
  private refreshTotal = 0;
  private readonly phases = new Map<FactsMetricPhase, FactsPhaseMetricAggregate>();

  recordRefresh(): void {
    this.refreshTotal++;
  }

  record(phase: FactsMetricPhase, durationMs: number): void {
    const aggregate = this.phases.get(phase) ?? { count: 0, totalMs: 0, maxMs: 0 };
    aggregate.count++;
    aggregate.totalMs += durationMs;
    aggregate.maxMs = Math.max(aggregate.maxMs, durationMs);
    this.phases.set(phase, aggregate);
  }

  snapshot(): FactsPhaseMetricsSnapshot {
    const phases: FactsPhaseMetricsSnapshot["phases"] = {};
    for (const [phase, aggregate] of this.phases) {
      phases[phase] = { ...aggregate };
    }
    return { refreshTotal: this.refreshTotal, phases };
  }
}
