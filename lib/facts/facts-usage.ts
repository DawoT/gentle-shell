interface SourceSize {
  path: string;
  sha: string;
  sourceBytes?: number;
}

export interface FactsUsageSnapshot {
  queries: number;
  answered: number;
  empty: number;
  unavailable: number;
  errors: number;
  cursorPages: number;
  responseBytes: number;
  baselineBytes: number;
  baselineFiles: number;
  baselineCapped: boolean;
  estimatedReductionTokens: number | null;
}

/** Session-local estimates, not provider token accounting or causal savings. */
export class FactsUsage {
  private readonly credited = new Set<string>();
  private counters = {
    queries: 0,
    answered: 0,
    empty: 0,
    unavailable: 0,
    errors: 0,
    cursorPages: 0,
    responseBytes: 0,
    baselineBytes: 0,
    baselineCapped: false,
  };

  record(event: { status: string; returned: number; text: string; sources?: readonly SourceSize[] }): void {
    const counts = this.counters;
    counts.queries++;
    counts.responseBytes += Buffer.byteLength(event.text, "utf8");
    if (event.status === "error") counts.errors++;
    else if (event.status === "unavailable") counts.unavailable++;
    else {
      if (event.returned > 0) counts.answered++;
      else counts.empty++;
      if (event.status === "snapshot") counts.cursorPages++;
      for (const source of event.sources ?? []) {
        if (!Number.isSafeInteger(source.sourceBytes) || source.sourceBytes! < 0) continue;
        const key = JSON.stringify([source.path, source.sha]);
        if (this.credited.has(key)) continue;
        if (this.credited.size >= 4096) {
          counts.baselineCapped = true;
          continue;
        }
        this.credited.add(key);
        counts.baselineBytes += source.sourceBytes!;
      }
    }
  }

  snapshot(): FactsUsageSnapshot {
    return {
      ...this.counters,
      baselineFiles: this.credited.size,
      estimatedReductionTokens: this.credited.size
        ? Math.trunc((this.counters.baselineBytes - this.counters.responseBytes) / 4)
        : null,
    };
  }
}

export function factsUsageLines(usage: FactsUsageSnapshot): string[] {
  return [
    `Queries: ${usage.queries} · answered ${usage.answered} · empty ${usage.empty}`,
    `Unavailable: ${usage.unavailable} · errors ${usage.errors} · cursor pages ${usage.cursorPages}`,
    `Response text: ${usage.responseBytes} bytes`,
    usage.estimatedReductionTokens === null
      ? "Est. context reduction: unavailable (no source sizes)"
      : `Est. context reduction: ~${usage.estimatedReductionTokens} tokens${usage.baselineCapped ? " (baseline capped)" : ""}`,
    "Estimate: unique file-version bytes minus response bytes, /4; not billed savings.",
  ];
}
