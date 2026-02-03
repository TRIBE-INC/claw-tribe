import { PythonBridge } from './python-bridge.js';
import * as path from 'path';
import * as fs from 'fs/promises';
import { Logger } from './logger.js';

export interface Signal {
  kind: 'error' | 'user_frustration' | 'improvement_suggestion' |
        'experiment_suggestion' | 'proactive_opportunity' | 'user_delight' | 'other';
  severity: 'low' | 'medium' | 'high' | 'critical';
  summary: string;
  tags: string[];
  evidence: Evidence[];
}

export interface Evidence {
  session_id: string;
  start_idx: number;
  end_idx: number;
  quote: string;
}

export interface Rollup {
  fingerprint_id: string;
  canonical_summary: string;
  kind_counts: Record<string, number>;
  tier: number;
  score: number;
  max_severity: string;
  tags_top: string[];
  sample_refs: Evidence[];
}

export interface ResearchBrief {
  ticket_id: string;
  title: string;
  evidence: string;
  analysis: string;
  recommendations: string;
}

export class SessionAnalyzer {
  private python: PythonBridge;
  private logger: Logger;
  private sessionsDir: string;

  constructor(logger: Logger) {
    this.python = new PythonBridge();
    this.logger = logger;
    this.sessionsDir = path.join(
      process.env.HOME || '~',
      '.openclaw',
      'agents',
      'main',
      'sessions'
    );
  }

  /**
   * Mine signals from recent sessions
   */
  async mineSignals(options: {
    maxSessions?: number;
    sessionIds?: string[];
    llm?: 'openai' | 'none';
  } = {}): Promise<Signal[]> {
    this.logger.info('Mining signals from sessions...', {
      maxSessions: options.maxSessions,
      sessionIds: options.sessionIds?.length
    });

    const args = [
      'mine-signals',
      '--sessions-dir', this.sessionsDir,
      '--llm', options.llm || 'openai',
      '--out-json', '-' // stdout
    ];

    if (options.maxSessions) {
      args.push('--max-sessions', String(options.maxSessions));
    }

    if (options.sessionIds) {
      // Create temp file with session IDs
      const tempFile = `/tmp/tribe-sessions-${Date.now()}.txt`;
      await fs.writeFile(tempFile, options.sessionIds.join('\n'));
      args.push('--include', tempFile);
    }

    try {
      const result = await this.python.runOpenClawTrace('mine-signals', args.slice(1));

      this.logger.info('Signal mining complete', {
        signalCount: result.signals?.length || 0
      });

      return result.signals || [];
    } catch (error: any) {
      this.logger.error('Signal mining failed', error);
      throw error;
    }
  }

  /**
   * Roll up signals into clusters
   */
  async rollupSignals(
    signals: Signal[],
    options: {
      mergeSimilar?: boolean;
      mergeLLM?: boolean;
    } = {}
  ): Promise<Rollup[]> {
    this.logger.info('Rolling up signals...', {
      signalCount: signals.length,
      mergeSimilar: options.mergeSimilar
    });

    // Write signals to temp file
    const tempInput = `/tmp/tribe-signals-${Date.now()}.jsonl`;
    await fs.writeFile(
      tempInput,
      signals.map(s => JSON.stringify(s)).join('\n')
    );

    const args = [
      'rollup-signals',
      '--in-jsonl', tempInput,
      '--out-json', '-'
    ];

    if (options.mergeSimilar) {
      args.push('--merge-similar');
    }

    if (options.mergeLLM) {
      args.push('--merge-llm');
    }

    try {
      const result = await this.python.runOpenClawTrace('rollup-signals', args.slice(1));

      // Cleanup
      await fs.unlink(tempInput).catch(() => {});

      this.logger.info('Rollup complete', {
        rollupCount: result.rollups?.length || 0
      });

      return result.rollups || [];
    } catch (error: any) {
      this.logger.error('Rollup failed', error);
      await fs.unlink(tempInput).catch(() => {});
      throw error;
    }
  }

  /**
   * Generate research brief for a rollup
   */
  async generateBrief(rollupId: string): Promise<ResearchBrief> {
    this.logger.info('Generating research brief', { rollupId });

    // Call Python script
    const scriptPath = path.join(
      process.cwd(),
      'openclaw-trace',
      'scripts',
      'run_research_brief.py'
    );

    try {
      const result = await this.python.run(scriptPath, [
        '--ticket-id', rollupId,
        '--actor-critic'
      ]);

      // Parse output (assume it writes to docs/research-briefs/)
      const briefPath = path.join(
        process.cwd(),
        'openclaw-trace',
        'docs',
        'research-briefs',
        `${rollupId}.md`
      );

      const content = await fs.readFile(briefPath, 'utf-8');

      return this.parseBrief(content);
    } catch (error: any) {
      this.logger.error('Brief generation failed', error);
      throw error;
    }
  }

  private parseBrief(markdown: string): ResearchBrief {
    // Parse markdown sections
    const sections: any = {
      ticket_id: '',
      title: '',
      evidence: '',
      analysis: '',
      recommendations: ''
    };

    const lines = markdown.split('\n');
    let currentSection = '';

    for (const line of lines) {
      if (line.startsWith('# ')) {
        sections.title = line.substring(2).trim();
      } else if (line.startsWith('## Evidence')) {
        currentSection = 'evidence';
      } else if (line.startsWith('## Analysis')) {
        currentSection = 'analysis';
      } else if (line.startsWith('## Recommendations')) {
        currentSection = 'recommendations';
      } else if (currentSection) {
        sections[currentSection] += line + '\n';
      }
    }

    return sections as ResearchBrief;
  }

  /**
   * Run full analysis pipeline
   */
  async analyze(options: {
    maxSessions?: number;
    sessionIds?: string[];
  } = {}): Promise<{
    signals: Signal[];
    rollups: Rollup[];
    topIssues: Rollup[];
  }> {
    this.logger.info('Running full session analysis pipeline');

    // Step 1: Mine signals
    const signals = await this.mineSignals(options);

    if (signals.length === 0) {
      this.logger.warn('No signals found');
      return { signals: [], rollups: [], topIssues: [] };
    }

    // Step 2: Rollup
    const rollups = await this.rollupSignals(signals, {
      mergeSimilar: true,
      mergeLLM: true
    });

    // Step 3: Get top issues
    const topIssues = rollups
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);

    this.logger.info('Analysis complete', {
      signalCount: signals.length,
      rollupCount: rollups.length,
      topIssuesCount: topIssues.length
    });

    return { signals, rollups, topIssues };
  }
}
