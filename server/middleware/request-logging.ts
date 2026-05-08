/**
 * Request logging middleware with failure tracking
 */

// Track request metrics
export const requestMetrics = {
  totalRequests: 0,
  successfulRequests: 0,
  failedRequests: 0,
  failures: [] as Array<any>,
  responseTimes: { min: Infinity, max: 0, samples: [] as number[] },
};

/**
 * Record a request and its outcome
 */
export function recordRequest(endpoint: string, status: number, durationMs: number) {
  requestMetrics.totalRequests++;
  const isSuccess = status >= 200 && status < 300;
  
  if (isSuccess) {
    requestMetrics.successfulRequests++;
  } else {
    requestMetrics.failedRequests++;
    requestMetrics.failures.push({
      endpoint,
      status,
      durationMs,
      timestamp: new Date().toISOString(),
    });
    // Keep last 100 failures
    if (requestMetrics.failures.length > 100) {
      requestMetrics.failures.shift();
    }
  }

  // Track response times
  if (requestMetrics.responseTimes.samples.length >= 200) {
    requestMetrics.responseTimes.samples.shift();
  }
  requestMetrics.responseTimes.samples.push(durationMs);
  const samples = requestMetrics.responseTimes.samples;
  requestMetrics.responseTimes.min = Math.min(requestMetrics.responseTimes.min, durationMs);
  requestMetrics.responseTimes.max = Math.max(requestMetrics.responseTimes.max, durationMs);
}

export const requestLogging: any = async (c: any, next: any) => {
  // Handle both Hono context and path string
  const path = typeof c === 'string' ? c : (c.req?.path || c.url?.pathname || '/');
  
  // Skip logging for static assets and health checks
  if (
    path.startsWith('/assets/') ||
    path.startsWith('/vendor/') ||
    path === '/api/health'
  ) {
    return next();
  }

  const start = Date.now();
  await next();
  const durationMs = Date.now() - start;
  
  // Get status from response or default to 200
  const status = c.res?.status || 200;
  recordRequest(path, status, durationMs);
};

/**
 * Get current health report
 */
export function getHealthReport() {
  const samples = requestMetrics.responseTimes.samples || [];
  const avgResponseTime =
    samples.reduce((a: number, b: number) => a + b, 0) / (samples.length || 1);

  return {
    timestamp: new Date().toISOString(),
    status: requestMetrics.failedRequests === 0 ? 'healthy' : 'degraded',
    metrics: {
      totalRequests: requestMetrics.totalRequests,
      successfulRequests: requestMetrics.successfulRequests,
      failedRequests: requestMetrics.failedRequests,
      failureRate: ((requestMetrics.failedRequests / (requestMetrics.totalRequests || 1)) * 100).toFixed(2) + '%',
    },
    responseTimes: {
      avgMs: Math.round(avgResponseTime),
      minMs: requestMetrics.responseTimes.min,
      maxMs: requestMetrics.responseTimes.max,
    },
    recentFailures: requestMetrics.failures
      .slice(-10)
      .reverse()
      .map((f: any) => ({
        endpoint: f.endpoint,
        status: f.status,
        durationMs: f.durationMs,
        timestamp: f.timestamp,
      })),
  };
}
