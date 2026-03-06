/**
 * Simple per-IP connection rate limiting.
 */

export interface RateLimitEntry {
  ip: string;
  connectionCount: number;
  firstSeen: number;
  windowMs: number;
}

export class RateLimiter {
  private entries: Map<string, RateLimitEntry> = new Map();
  private maxConnectionsPerWindow: number;
  private windowMs: number;

  constructor(maxConnectionsPerWindow: number = 30, windowMs: number = 60_000) {
    this.maxConnectionsPerWindow = maxConnectionsPerWindow;
    this.windowMs = windowMs;
  }

  /** Check if a connection from an IP should be allowed. */
  allow(ip: string): boolean {
    const now = Date.now();
    const entry = this.entries.get(ip);

    if (!entry || (now - entry.firstSeen) > this.windowMs) {
      this.entries.set(ip, { ip, connectionCount: 1, firstSeen: now, windowMs: this.windowMs });
      return true;
    }

    if (entry.connectionCount >= this.maxConnectionsPerWindow) {
      return false;
    }

    entry.connectionCount++;
    return true;
  }

  /** Clean up expired entries. */
  cleanup(): number {
    const now = Date.now();
    let cleaned = 0;
    const keys = Array.from(this.entries.keys());
    for (let i = 0; i < keys.length; i++) {
      const entry = this.entries.get(keys[i])!;
      if ((now - entry.firstSeen) > entry.windowMs) {
        this.entries.delete(keys[i]);
        cleaned++;
      }
    }
    return cleaned;
  }

  /** Get tracked IP count. */
  getTrackedCount(): number {
    return this.entries.size;
  }
}
