/**
 * Homepage Error Scraper
 * 
 * Developer tool to scrape localhost:3080 and search for errors
 * surfaced on the home page.
 * 
 * Usage: npx tsx scripts/homepage-error-scraper.ts
 */

import * as http from 'node:http';

interface ScrapeResult {
  url: string;
  status: number;
  hasServerError: boolean;
  hasClientError: boolean;
  hasConsoleError: boolean;
  hasErrorBoundary: boolean;
  errors: ErrorPattern[];
  latencyMs: number;
  htmlSize: number;
}

interface ErrorPattern {
  type: 'server' | 'client' | 'console' | 'boundary';
  message: string;
  context?: string;
}

const PORT = 3080;
const TIMEOUT_MS = 15000;

const ERROR_PATTERNS = {
  server: [/5\d{2}/i, /internal server error/i, /service unavailable/i, /gateway timeout/i, /error/i, /failed/i],
  client: [/uncaught/i, /referenceerror/i, /typeerror/i, /cannot read/i, /undefined/i, /null/i],
  console: [/error\[/i, /unhandled promise rejection/i, /warning/i],
  boundary: [/error boundary/i, /catch/i, /fallback/i],
};

/**
 * Fetch HTML from localhost with error handling
 */
async function fetchHomepage(port: number, timeout: number): Promise<{ html: string; status: number }> {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    
    const req = http.request(
      {
        hostname: 'localhost',
        port,
        path: '/',
        method: 'GET',
        timeout,
      },
      (res) => {
        let data = '';
        
        res.on('data', (chunk) => {
          data += chunk;
        });
        
        res.on('end', () => {
          const latency = Date.now() - startTime;
          console.log(`[+] Fetched homepage in ${latency}ms (size: ${data.length} bytes)`);
          resolve({ html: data, status: res.statusCode || 0 });
        });
      }
    );
    
    req.on('error', (error) => {
      reject(new Error(`Request failed: ${error.message}`));
    });
    
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Request timed out after ${timeout}ms`));
    });
    
    req.end();
  });
}

/**
 * Check HTML content for error patterns
 */
function scanForErrors(html: string): ErrorPattern[] {
  const errors: ErrorPattern[] = [];
  
  // Check for HTTP status codes in response
  const serverErrorMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (serverErrorMatch) {
    const title = serverErrorMatch[1].toLowerCase();
    if (title.includes('error') || title.includes('failed') || title.includes('unavailable')) {
      errors.push({
        type: 'server',
        message: `Error in page title: "${serverErrorMatch[1]}"`,
        context: 'HTTP response title',
      });
    }
  }
  
  // Server errors
  ERROR_PATTERNS.server.forEach((pattern) => {
    const match = html.match(pattern);
    if (match) {
      errors.push({
        type: 'server',
        message: match[0],
        context: 'HTML body',
      });
    }
  });
  
  // Client-side errors
  ERROR_PATTERNS.client.forEach((pattern) => {
    const match = html.match(pattern);
    if (match) {
      errors.push({
        type: 'client',
        message: match[0],
        context: 'HTML body',
      });
    }
  });
  
  // console.error messages
  ERROR_PATTERNS.console.forEach((pattern) => {
    const match = html.match(pattern);
    if (match) {
      errors.push({
        type: 'console',
        message: match[0],
        context: 'HTML body',
      });
    }
  });
  
  // Error boundary components
  ERROR_PATTERNS.boundary.forEach((pattern) => {
    const match = html.match(pattern);
    if (match) {
      errors.push({
        type: 'boundary',
        message: match[0],
        context: 'Component boundary',
      });
    }
  });
  
  return errors;
}

/**
 * Main scraper function
 */
async function scrapeHomepage(port: number = PORT): Promise<ScrapeResult> {
  const startTime = Date.now();
  
  console.log(`[ ] Scraping http://localhost:${port} for errors...`);
  
  try {
    const { html, status } = await fetchHomepage(port, TIMEOUT_MS);
    
    const errors = scanForErrors(html);
    
    // Categorize errors
    const hasServerError = errors.some(e => e.type === 'server');
    const hasClientError = errors.some(e => e.type === 'client');
    const hasConsoleError = errors.some(e => e.type === 'console');
    const hasErrorBoundary = errors.some(e => e.type === 'boundary');
    
    const latency = Date.now() - startTime;
    
    return {
      url: `http://localhost:${port}`,
      status,
      hasServerError,
      hasClientError,
      hasConsoleError,
      hasErrorBoundary,
      errors,
      latencyMs: latency,
      htmlSize: html.length,
    };
    
  } catch (error: unknown) {
    const latency = Date.now() - startTime;
    
    return {
      url: `http://localhost:${port}`,
      status: 0,
      hasServerError: true,
      hasClientError: false,
      hasConsoleError: false,
      hasErrorBoundary: false,
      errors: [
        {
          type: 'server',
          message: error instanceof Error ? error.message : 'Unknown error',
          context: 'Connection',
        },
      ],
      latencyMs: latency,
      htmlSize: 0,
    };
  }
}

/**
 * Display results in a formatted way
 */
function displayResults(result: ScrapeResult): void {
  console.log('\n' + '='.repeat(60));
  console.log('HOMEPAGE ERROR SCRAPE RESULTS');
  console.log('='.repeat(60));
  
  console.log(`\nURL: ${result.url}`);
  console.log(`Status: ${result.status || 'Connection failed'}`);
  console.log(`Latency: ${result.latencyMs}ms`);
  console.log(`HTML Size: ${result.htmlSize} bytes`);
  
  console.log('\n--- Error Status ---');
  console.log(`  Server Errors: ${result.hasServerError ? '❌ Found' : '✓ None'}`);
  console.log(`  Client Errors: ${result.hasClientError ? '❌ Found' : '✓ None'}`);
  console.log(`  Console Errors: ${result.hasConsoleError ? '❌ Found' : '✓ None'}`);
  console.log(`  Error Boundaries: ${result.hasErrorBoundary ? '⚠️  Detected' : '✓ None'}`);
  
  if (result.errors.length > 0) {
    console.log('\n--- Detected Errors ---');
    result.errors.forEach((error, index) => {
      console.log(`\n${index + 1}. [${error.type.toUpperCase()}] ${error.message}`);
      if (error.context) {
        console.log(`   Context: ${error.context}`);
      }
    });
  } else {
    console.log('\n--- Detected Errors ---');
    console.log('✓ No errors found');
  }
  
  console.log('\n' + '='.repeat(60));
}

/**
 * Entry point
 */
async function main(): Promise<number> {
  const PORT = parseInt(process.argv[2]) || 3080;
  
  const result = await scrapeHomepage(PORT);
  displayResults(result);
  
  // Return error code if errors found
  if (result.hasServerError || result.hasClientError || result.hasConsoleError) {
    return 1;
  }
  
  return 0;
}

// Run if executed directly
import { fileURLToPath } from 'node:url';

// Check if running as main module
const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);

if (isMainModule) {
  main()
    .then((code) => {
      process.exit(code);
    })
    .catch((error) => {
      console.error('Fatal error:', error);
      process.exit(1);
    });
}

export { scrapeHomepage, displayResults, type ScrapeResult };
