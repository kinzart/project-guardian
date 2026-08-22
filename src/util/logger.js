import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export class ScanLogger {
  constructor(logsDir, scanId) {
    this.logsDir = logsDir;
    this.scanId = scanId;
    mkdirSync(logsDir, { recursive: true });
    this.filePath = path.join(logsDir, `scan-${scanId}.jsonl`);
    this.errorCount = 0;
  }

  #write(entry) {
    appendFileSync(this.filePath, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  }

  info(message, extra = {}) {
    this.#write({ level: 'info', message, ...extra });
  }

  warn(message, extra = {}) {
    this.#write({ level: 'warn', message, ...extra });
  }

  error(message, extra = {}) {
    this.errorCount += 1;
    this.#write({ level: 'error', message, ...extra });
  }
}
