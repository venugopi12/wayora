import type { SessionRedis } from '../src/modules/search/sessions.js';

/**
 * Just enough of Redis for the search-session store (GET, SET PX, DEL,
 * MULTI/EXEC), with a controllable clock for expiry and a switch that makes
 * every command fail like a dropped connection. Several store instances can
 * share one FakeRedis, like API instances sharing one Redis.
 */
export class FakeRedis implements SessionRedis {
  readonly data = new Map<string, { value: string; expiresAt: number }>();
  /** Every SET as [key, px], for asserting TTLs. */
  readonly sets: [string, number][] = [];
  down = false;

  constructor(public now: () => number = () => Date.now()) {}

  private check(): void {
    if (this.down) {
      throw Object.assign(
        new Error('connect ECONNREFUSED 10.1.2.3:6379 (redis password=hunter2)'),
        {
          code: 'ECONNREFUSED',
        },
      );
    }
  }

  private live(key: string) {
    const entry = this.data.get(key);
    if (entry && entry.expiresAt <= this.now()) {
      this.data.delete(key);
      return undefined;
    }
    return entry;
  }

  async get(key: string): Promise<string | null> {
    this.check();
    return this.live(key)?.value ?? null;
  }

  async set(key: string, value: string, mode: 'PX', milliseconds: number): Promise<'OK'> {
    this.check();
    if (mode !== 'PX' || !Number.isInteger(milliseconds) || milliseconds <= 0) {
      throw new Error('ERR invalid expire time');
    }
    this.data.set(key, { value, expiresAt: this.now() + milliseconds });
    this.sets.push([key, milliseconds]);
    return 'OK';
  }

  async del(key: string): Promise<number> {
    this.check();
    return this.data.delete(key) ? 1 : 0;
  }

  multi() {
    const queued: [string, string, number][] = [];
    const tx = {
      set: (key: string, value: string, _mode: 'PX', milliseconds: number) => {
        queued.push([key, value, milliseconds]);
        return tx;
      },
      exec: async (): Promise<[Error | null, unknown][]> => {
        this.check();
        const replies: [Error | null, unknown][] = [];
        for (const [key, value, px] of queued)
          replies.push([null, await this.set(key, value, 'PX', px)]);
        return replies;
      },
    };
    return tx;
  }

  /** Raw stored value (for tampering in tests). */
  raw(key: string): string | undefined {
    return this.live(key)?.value;
  }

  write(key: string, value: string): void {
    const entry = this.data.get(key);
    this.data.set(key, { value, expiresAt: entry?.expiresAt ?? this.now() + 60_000 });
  }
}

/** A pino-compatible destination that keeps every log line, for leak assertions. */
export function captureLogs() {
  const lines: string[] = [];
  return {
    lines,
    stream: { write: (line: string) => void lines.push(line) },
    get text() {
      return lines.join('');
    },
    entries(): Record<string, unknown>[] {
      return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    },
  };
}
