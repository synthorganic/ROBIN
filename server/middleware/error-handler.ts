/**
 * Global error handler middleware.
 *
 * Catches unhandled errors thrown by route handlers and returns a consistent
 * response: JSON  for  routes, plain text otherwise.
 * In development mode, stack traces are logged to stderr.
 * 
 * For OPS routes (agent, bridge), returns detailed error information including
 * HTTP status code embedded in the response body for better client-side handling.
 * @module
 */

import type { ErrorHandler } from 'hono';
import { requestMetrics, recordRequest } from './request-logging.js';

const isDev = process.env.NODE_ENV !== 'production';

export const errorHandler: ErrorHandler = (err, c) => {
  const path = c.req.path;
  
  console.error('[server] unhandled error:', err.message || err);
  if (isDev && err.stack) {
    console.error('[server] stack:', err.stack);
  }

  // Get current request metrics for context
  const currentMetrics = requestMetrics;
  const failureCount = currentMetrics.failedRequests + 1;
  
  // For OPS routes, provide more detailed error information
  const isOpsRoute = path.startsWith('/api/agent') || 
                     path.startsWith('/api/bridge') ||
                     path.startsWith('/api/workspace');

  if (isDev) {
    console.error();
  }

  // Return appropriate response based on route type
  if (c.req.path.startsWith('/api/') || c.req.path.startsWith('/api')) {
    const responseBody = isOpsRoute
      ? {
          ok: false,
          error: err.message || 'Internal server error',
          endpoint: path,
          failureCount,
        }
      : { error: 'Internal server error' };

    // Default to 503 for OPS routes (matches previous behavior), 500 otherwise
    const statusCode = isOpsRoute ? 503 : 500;
    return c.json(responseBody, statusCode);
  }
  
  return c.text('Internal server error', 500);
};
