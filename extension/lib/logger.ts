export class Logger {
  private prefix: string;

  constructor(prefix: string = 'tribe') {
    this.prefix = prefix;
  }

  info(message: string, meta?: any): void {
    console.log(`[${this.prefix}] INFO: ${message}`, meta || '');
  }

  warn(message: string, meta?: any): void {
    console.warn(`[${this.prefix}] WARN: ${message}`, meta || '');
  }

  error(message: string, error?: any): void {
    console.error(`[${this.prefix}] ERROR: ${message}`, error || '');
  }

  debug(message: string, meta?: any): void {
    if (process.env.DEBUG) {
      console.log(`[${this.prefix}] DEBUG: ${message}`, meta || '');
    }
  }
}
