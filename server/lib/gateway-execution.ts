/**
 * Local command execution engine for ROBIN Gateway.
 *
 * Executes bash and PowerShell commands directly on the host system
 * without requiring OpenClaw or external gateway dependencies.
 */

import { spawn } from 'node:child_process';

export interface ExecuteCommandOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface ExecuteResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  startTime: number;
  endTime: number;
}

/**
 * Execute a bash/shell command.
 */
export async function executeBash(
  command: string,
  options?: ExecuteCommandOptions & { timeoutMs?: number },
): Promise<ExecuteResult> {
  const timeoutMs = options?.timeoutMs ?? 30_000;
  const startTime = Date.now();

  return new Promise((resolve) => {
    let timedOut = false;
    let exited = false;

    const isWindows = process.platform === 'win32';
    const shell = isWindows ? 'cmd.exe' : '/bin/sh';
    const args = isWindows ? ['/c', command] : ['-c', command];

    const child = spawn(shell, args, {
      cwd: options?.cwd || process.cwd(),
      env: { ...process.env, ...options?.env },
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    const timeoutId = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      
      setTimeout(() => {
        if (!exited) {
          child.kill('SIGKILL');
          exited = true;
          resolve({
            success: false,
            stdout,
            stderr: stderr || 'Process killed due to timeout',
            exitCode: null,
            timedOut: true,
            startTime,
            endTime: Date.now(),
          });
        }
      }, 2000).unref();
    }, timeoutMs);

    child.on('close', (code) => {
      if (!exited) {
        clearTimeout(timeoutId);
        exited = true;
        resolve({
          success: code === 0,
          stdout,
          stderr,
          exitCode: code,
          timedOut: false,
          startTime,
          endTime: Date.now(),
        });
      }
    });

    child.on('error', (err) => {
      if (!exited) {
        clearTimeout(timeoutId);
        exited = true;
        resolve({
          success: false,
          stdout,
          stderr: err.message,
          exitCode: null,
          timedOut: false,
          startTime,
          endTime: Date.now(),
        });
      }
    });

    child.stdin.end();
  });
}

/**
 * Execute a PowerShell command.
 */
export async function executePowerShell(
  command: string,
  options?: ExecuteCommandOptions & { timeoutMs?: number },
): Promise<ExecuteResult> {
  const timeoutMs = options?.timeoutMs ?? 60_000;
  const startTime = Date.now();

  return new Promise((resolve) => {
    let timedOut = false;
    let exited = false;

    const escapedCommand = command.replace(/"/g, '\\"');

    const child = spawn('powershell', ['-NoProfile', '-Command', escapedCommand], {
      cwd: options?.cwd || process.cwd(),
      env: { ...process.env, ...options?.env },
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    const timeoutId = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      
      setTimeout(() => {
        if (!exited) {
          child.kill('SIGKILL');
          exited = true;
          resolve({
            success: false,
            stdout,
            stderr: stderr || 'Process killed due to timeout',
            exitCode: null,
            timedOut: true,
            startTime,
            endTime: Date.now(),
          });
        }
      }, 2000).unref();
    }, timeoutMs);

    child.on('close', (code) => {
      if (!exited) {
        clearTimeout(timeoutId);
        exited = true;
        resolve({
          success: code === 0,
          stdout,
          stderr,
          exitCode: code,
          timedOut: false,
          startTime,
          endTime: Date.now(),
        });
      }
    });

    child.on('error', (err) => {
      if (!exited) {
        clearTimeout(timeoutId);
        exited = true;
        resolve({
          success: false,
          stdout,
          stderr: err.message,
          exitCode: null,
          timedOut: false,
          startTime,
          endTime: Date.now(),
        });
      }
    });

    child.stdin.end();
  });
}

/**
 * Execute a generic command based on interpreter detection.
 */
export async function executeCommand(
  command: string,
  options?: ExecuteCommandOptions & { timeoutMs?: number; interpreter?: 'bash' | 'powershell' },
): Promise<ExecuteResult> {
  const cmdOptions = options || {};
  const interpreter = cmdOptions.interpreter ?? (process.platform === 'win32' ? 'powershell' : 'bash');

  if (interpreter.toLowerCase() === 'powershell') {
    return executePowerShell(command, { ...cmdOptions, timeoutMs: cmdOptions.timeoutMs });
  }

  return executeBash(command, { ...cmdOptions, timeoutMs: cmdOptions.timeoutMs });
}

/**
 * Extract text content from a .docx file using PowerShell ZIP/XML parsing.
 * Returns the extracted text or an error message.
 */
export async function extractDocxText(filePath: string): Promise<{ success: boolean; content?: string; error?: string }> {
  try {
    const escapedPath = filePath.replace(/"/g, '\\"').replace(/\\/g, '\\\\');

    const powershellScript = `
$filePath = "${escapedPath}"
if (!(Test-Path $filePath)) {{ return [PSCustomObject]@{{ success = $false; error = "File not found: $filePath" }} }}

$tempDir = Join-Path $env:TEMP "docx-extract-$([guid]::NewGuid())"
Expand-Archive -Path $filePath -DestinationPath $tempDir -Force

$xmlPath = Join-Path $tempDir "word\\document.xml"
if (!(Test-Path $xmlPath)) {{
  Remove-Item $tempDir -Recurse
  return [PSCustomObject]@{{ success = $false; error = "Could not find word/document.xml in .docx" }}
}}

[xml]$xml = Get-Content $xmlPath
$nodes = $xml.SelectNodes("//w:t")
$text = ($nodes | ForEach-Object {{ $_.InnerText }}) -join " "
Remove-Item $tempDir -Recurse
[PSCustomObject]@{{ success = $true; content = $text }}
`;

    const result = await executePowerShell(powershellScript, { timeoutMs: 60_000 });

    if (result.success) {
      // Parse the JSON output from PowerShell
      try {
        const jsonStart = result.stdout.indexOf('{');
        const jsonEnd = result.stdout.lastIndexOf('}') + 1;
        if (jsonStart !== -1 && jsonEnd > jsonStart) {
          const jsonStr = result.stdout.substring(jsonStart, jsonEnd);
          const parsed = JSON.parse(jsonStr);
          return { success: true, content: parsed.content };
        }
      } catch {
        // Fallback to raw stdout
      }
    }

    return { success: false, error: result.stderr || 'Failed to extract .docx content' };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}
