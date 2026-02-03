import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';

export interface PythonResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  duration: number;
}

export class PythonBridge {
  private pythonPath: string;

  constructor() {
    this.pythonPath = this.findPythonPath();
  }

  private findPythonPath(): string {
    // Check for openclaw-trace venv
    const venvPath = path.join(
      process.cwd(),
      'openclaw-trace',
      '.venv',
      'bin',
      'python'
    );

    // Fallback to system python
    return venvPath;
  }

  async run(
    script: string,
    args: string[] = [],
    options: {
      timeout?: number;
      cwd?: string;
    } = {}
  ): Promise<PythonResult> {
    const startTime = Date.now();
    const timeout = options.timeout || 120000; // 2 min default

    return new Promise((resolve, reject) => {
      const proc = spawn(this.pythonPath, [script, ...args], {
        cwd: options.cwd || process.cwd(),
        env: {
          ...process.env,
          PYTHONPATH: path.join(process.cwd(), 'openclaw-trace')
        }
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      const timer = setTimeout(() => {
        proc.kill('SIGTERM');
        reject(new Error(`Python process timeout after ${timeout}ms`));
      }, timeout);

      proc.on('close', (code) => {
        clearTimeout(timer);
        resolve({
          stdout,
          stderr,
          exitCode: code || 0,
          duration: Date.now() - startTime
        });
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  async runOpenClawTrace(
    command: string,
    args: string[] = []
  ): Promise<any> {
    const scriptPath = path.join(
      process.cwd(),
      'openclaw-trace',
      'openclaw_trace',
      'cli.py'
    );

    const result = await this.run(scriptPath, [command, ...args], {
      cwd: path.join(process.cwd(), 'openclaw-trace'),
      timeout: 300000 // 5 min for analysis
    });

    if (result.exitCode !== 0) {
      throw new Error(`openclaw-trace failed: ${result.stderr}`);
    }

    // Parse JSON output if applicable
    try {
      return JSON.parse(result.stdout);
    } catch {
      return result.stdout;
    }
  }
}
