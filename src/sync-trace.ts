type TraceData = Record<string, unknown>;

interface TraceEntry {
  atMs: number;
  event: string;
  path?: string;
  data?: TraceData;
}

const MAX_TRACE_ENTRIES = 400;

export class SyncTrace {
  private startedAt = performance.now();
  private startedIso = new Date().toISOString();
  private entries: TraceEntry[] = [];
  private observedPaths = new Set<string>();
  private droppedEntries = 0;

  resetStartup(meta?: TraceData): void {
    this.startedAt = performance.now();
    this.startedIso = new Date().toISOString();
    this.entries = [];
    this.observedPaths.clear();
    this.droppedEntries = 0;
    this.mark('startup.reset', meta);
  }

  observePath(path: string): void {
    if (!path || this.observedPaths.has(path)) return;
    this.observedPaths.add(path);
    this.push({
      atMs: this.elapsedMs(),
      event: 'trace.observe-path',
      path,
    });
  }

  mark(event: string, data?: TraceData): void {
    this.push({ atMs: this.elapsedMs(), event, data });
  }

  markPath(event: string, path: string, data?: TraceData): void {
    if (!this.observedPaths.has(path)) return;
    this.push({ atMs: this.elapsedMs(), event, path, data });
  }

  report(): string {
    const lines: string[] = [];
    lines.push('# VaultCRDT startup trace');
    lines.push('');
    lines.push(`started: ${this.startedIso}`);
    lines.push(`observedPaths: ${[...this.observedPaths].join(', ') || '(none)'}`);
    lines.push(`entries: ${this.entries.length}`);
    if (this.droppedEntries > 0) {
      lines.push(`droppedEntries: ${this.droppedEntries}`);
    }
    lines.push('');
    lines.push('```text');
    for (const entry of this.entries) {
      const parts = [`+${entry.atMs.toFixed(0)}ms`, entry.event];
      if (entry.path) parts.push(`path=${entry.path}`);
      if (entry.data && Object.keys(entry.data).length > 0) {
        parts.push(`data=${JSON.stringify(entry.data)}`);
      }
      lines.push(parts.join(' | '));
    }
    lines.push('```');
    lines.push('');
    lines.push('Delete this note after diagnosis.');
    return lines.join('\n');
  }

  private elapsedMs(): number {
    return performance.now() - this.startedAt;
  }

  private push(entry: TraceEntry): void {
    if (this.entries.length >= MAX_TRACE_ENTRIES) {
      this.entries.shift();
      this.droppedEntries++;
    }
    this.entries.push(entry);
  }
}
