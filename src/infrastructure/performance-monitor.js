/**
 * WEEK 6: Performance Monitor
 * Tracks timing metrics for extraction, comparison, and rendering operations.
 * Provides before/after comparison to validate optimization impact.
 */

class PerformanceMonitor {
  constructor() {
    this.metrics = {};
    this.enabled = true;
  }

  start(operation) {
    if (!this.enabled) return;
    
    if (!this.metrics[operation]) {
      this.metrics[operation] = {
        count: 0,
        totalTime: 0,
        minTime: Infinity,
        maxTime: -Infinity,
        samples: []
      };
    }
    
    return {
      operation,
      startTime: performance.now(),
      startMark: `${operation}-start-${Date.now()}`
    };
  }

  end(handle) {
    if (!this.enabled || !handle) return null;
    
    const duration = performance.now() - handle.startTime;
    const metric = this.metrics[handle.operation];
    
    metric.count++;
    metric.totalTime += duration;
    metric.minTime = Math.min(metric.minTime, duration);
    metric.maxTime = Math.max(metric.maxTime, duration);
    
    // Keep last 100 samples for variance analysis
    metric.samples.push(duration);
    if (metric.samples.length > 100) {
      metric.samples.shift();
    }
    
    return {
      operation: handle.operation,
      duration: Math.round(duration),
      average: Math.round(metric.totalTime / metric.count)
    };
  }

  wrap(operation, fn) {
    return async (...args) => {
      const handle = this.start(operation);
      try {
        const result = await fn(...args);
        this.end(handle);
        return result;
      } catch (error) {
        this.end(handle);
        throw error;
      }
    };
  }

  getStats(operation) {
    const metric = this.metrics[operation];
    if (!metric || metric.count === 0) return null;
    
    const avg = metric.totalTime / metric.count;
    const variance = metric.samples.reduce((sum, val) => sum + Math.pow(val - avg, 2), 0) / metric.samples.length;
    const stdDev = Math.sqrt(variance);
    
    return {
      operation,
      count:     metric.count,
      total:     Math.round(metric.totalTime),
      average:   Math.round(avg),
      min:       Math.round(metric.minTime),
      max:       Math.round(metric.maxTime),
      stdDev:    Math.round(stdDev),
      p50:       this._percentile(metric.samples, 0.5),
      p95:       this._percentile(metric.samples, 0.95),
      p99:       this._percentile(metric.samples, 0.99)
    };
  }

  getAllStats() {
    const stats = {};
    for (const op of Object.keys(this.metrics)) {
      stats[op] = this.getStats(op);
    }
    return stats;
  }

  _percentile(samples, p) {
    if (samples.length === 0) return 0;
    const sorted = [...samples].sort((a, b) => a - b);
    const index = Math.ceil(sorted.length * p) - 1;
    return Math.round(sorted[Math.max(0, index)]);
  }

  reset(operation = null) {
    if (operation) {
      delete this.metrics[operation];
    } else {
      this.metrics = {};
    }
  }

  generateReport() {
    const stats = this.getAllStats();
    const lines = ['=== PERFORMANCE REPORT ===\n'];
    
    for (const [op, data] of Object.entries(stats)) {
      if (!data) continue;
      lines.push(`${op}:`);
      lines.push(`  Count:   ${data.count}`);
      lines.push(`  Total:   ${data.total}ms`);
      lines.push(`  Average: ${data.average}ms`);
      lines.push(`  Min/Max: ${data.min}ms / ${data.max}ms`);
      lines.push(`  P50/P95: ${data.p50}ms / ${data.p95}ms`);
      lines.push(`  StdDev:  ${data.stdDev}ms\n`);
    }
    
    return lines.join('\n');
  }

  /**
   * Week 6 specific: Estimate performance improvement vs baseline.
   * Baseline timings from artifact (pre-optimization).
   */
  estimateImprovement() {
    const baseline = {
      'dom-batch-reads':      800,   // Pre-optimization: interleaved reads
      'style-collection':     1200,  // Pre-optimization: redundant getComputedStyle
      'selector-generation':  9000,  // Pre-optimization: serial processing
      'normalization':        400,   // Pre-optimization: cold cache every comparison
      'matching':             800,   // Pre-optimization: O(N²) nested loops
      'extraction-total':     12000, // Sum of extraction phases
      'comparison-total':     2100   // Sum of comparison phases
    };
    
    const improvements = {};
    const current = this.getAllStats();
    
    for (const [op, baseTime] of Object.entries(baseline)) {
      const stat = current[op];
      if (stat && stat.average > 0) {
        const improvement = ((baseTime - stat.average) / baseTime) * 100;
        const speedup = baseTime / stat.average;
        improvements[op] = {
          baseline:    baseTime,
          current:     stat.average,
          improvement: Math.round(improvement),
          speedup:     speedup.toFixed(1)
        };
      }
    }
    
    return improvements;
  }

  logImprovement() {
    const improvements = this.estimateImprovement();
    console.group('🚀 WEEK 6 PERFORMANCE IMPROVEMENTS');
    
    for (const [op, data] of Object.entries(improvements)) {
      console.log(
        `${op}: ${data.baseline}ms → ${data.current}ms ` +
        `(${data.improvement > 0 ? '+' : ''}${data.improvement}% faster, ${data.speedup}x speedup)`
      );
    }
    
    console.groupEnd();
  }
}

// Export singleton instance
const performanceMonitor = new PerformanceMonitor();

export { PerformanceMonitor, performanceMonitor };