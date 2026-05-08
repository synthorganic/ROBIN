/**
 * Metrics endpoint for request monitoring
 */
import { Hono } from 'hono';
import { getHealthReport, requestLogging, requestMetrics } from '../middleware/request-logging.js';

const app = new Hono();

// Expose the middleware export for use in server/app.ts
export { requestLogging, requestMetrics };

app.get('/api/metrics', async (c) => {
  const report = getHealthReport();
  return c.json(report);
});

app.get('/api/metrics/failures', async (c) => {
  const failures = requestMetrics.failures.slice(-50).reverse();
  return c.json({ count: failures.length, failures });
});

app.get('/api/metrics/health', async (c) => {
  const health = {
    status: requestMetrics.failedRequests === 0 ? 'healthy' : 'degraded',
    timestamp: new Date().toISOString(),
    metrics: {
      totalRequests: requestMetrics.totalRequests,
      successfulRequests: requestMetrics.successfulRequests,
      failedRequests: requestMetrics.failedRequests,
      failureRate: ((requestMetrics.failedRequests / (requestMetrics.totalRequests || 1)) * 100).toFixed(2) + '%',
    },
    responseTimes: {
      avgMs: Math.round(
        (requestMetrics.responseTimes.samples.reduce((a, b) => a + b, 0) /
          (requestMetrics.responseTimes.samples.length || 1))
      ),
      minMs: requestMetrics.responseTimes.min,
      maxMs: requestMetrics.responseTimes.max,
    },
  };
  return c.json(health);
});

export default app;
