import { randomUUID } from 'node:crypto';
import { broadcast } from '../routes/events.js';
import { opsAgentService } from './ops-agent.js';
import { opsTerminalManager } from './ops-terminals.js';

export interface OpsBridgeJob {
  id: string;
  sessionId: string;
  targetTerminalId: 'cli';
  state: 'idle' | 'sent' | 'returned' | 'cancelled';
  prompt: string;
  transcriptRef: string;
  createdAt: string;
  updatedAt: string;
}

class OpsBridgeService {
  private activeJob: OpsBridgeJob | null = null;
  private readonly history: OpsBridgeJob[] = [];

  status() {
    return {
      activeJob: this.activeJob,
      recentJobs: [...this.history].reverse().slice(0, 10),
    };
  }

  async handoffToCli(sessionId: string, prompt: string, context = '') {
    if (this.activeJob?.state === 'sent') {
      this.activeJob.state = 'cancelled';
      this.activeJob.updatedAt = new Date().toISOString();
    }

    await opsTerminalManager.start('cli');
    const job: OpsBridgeJob = {
      id: `bridge-${randomUUID().slice(0, 10)}`,
      sessionId,
      targetTerminalId: 'cli',
      state: 'sent',
      prompt,
      transcriptRef: `cli:${sessionId}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.activeJob = job;
    this.history.push(job);

    const payload = [
      '# ROBIN Bridge',
      `Session: ${sessionId}`,
      '',
      'Task:',
      prompt.trim(),
      '',
      context.trim() ? 'Context:' : '',
      context.trim(),
      '',
      'Return a concise implementation summary, blockers, and next step.',
    ]
      .filter(Boolean)
      .join('\n');

    opsTerminalManager.sendBlock('cli', payload);
    opsTerminalManager.appendLog(`[bridge] ${job.id} -> cli (${sessionId})`);
    this.emit();

    return this.status();
  }

  async returnToAgent(sessionId: string, text: string) {
    if (!text.trim()) {
      throw new Error('Return payload cannot be empty');
    }
    if (this.activeJob && this.activeJob.sessionId !== sessionId) {
      throw new Error('Bridge return must target the active central agent session');
    }

    const prompt = `CLI coding agent update:\n\n${text.trim()}`;
    await opsAgentService.sendMessage(sessionId, prompt);

    if (this.activeJob && this.activeJob.sessionId === sessionId) {
      this.activeJob.state = 'returned';
      this.activeJob.updatedAt = new Date().toISOString();
      this.activeJob = null;
    }

    opsTerminalManager.appendLog(`[bridge] returned cli update -> ${sessionId}`);
    this.emit();
    return this.status();
  }

  cancel() {
    if (this.activeJob) {
      this.activeJob.state = 'cancelled';
      this.activeJob.updatedAt = new Date().toISOString();
      this.activeJob = null;
    }

    try {
      opsTerminalManager.ctrlC('cli');
    } catch {
      // ignore if the CLI pane is not running
    }

    opsTerminalManager.appendLog('[bridge] cancelled active CLI handoff');
    this.emit();
    return this.status();
  }

  private emit() {
    broadcast('ops.bridge.status', {
      ...this.status(),
      ts: Date.now(),
    });
  }
}

export const opsBridgeService = new OpsBridgeService();
