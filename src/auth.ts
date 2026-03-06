/**
 * Relay-side authentication.
 * The relay doesn't validate tokens (host does that),
 * but it manages pairing code relay and connection auth.
 */

export interface PairingCodeEntry {
  code: string;
  roomId: string;
  createdAt: number;
  expiresAt: number;
  used: boolean;
}

export class RelayAuth {
  private pairingCodes: Map<string, PairingCodeEntry> = new Map();

  /** Register a pairing code from a host. */
  registerPairingCode(code: string, roomId: string, ttlMs: number = 5 * 60 * 1000): void {
    this.pairingCodes.set(code, {
      code,
      roomId,
      createdAt: Date.now(),
      expiresAt: Date.now() + ttlMs,
      used: false,
    });
  }

  /** Look up a pairing code. Returns room ID if valid. */
  lookupPairingCode(code: string): { roomId: string } | null {
    const entry = this.pairingCodes.get(code.toUpperCase());
    if (!entry) return null;
    if (entry.used) return null;
    if (Date.now() > entry.expiresAt) {
      this.pairingCodes.delete(code.toUpperCase());
      return null;
    }
    return { roomId: entry.roomId };
  }

  /** Mark a pairing code as used. */
  markUsed(code: string): void {
    const entry = this.pairingCodes.get(code.toUpperCase());
    if (entry) {
      entry.used = true;
    }
  }

  /** Clean up expired codes. */
  cleanExpired(): number {
    const now = Date.now();
    let cleaned = 0;
    const keys = Array.from(this.pairingCodes.keys());
    for (let i = 0; i < keys.length; i++) {
      const entry = this.pairingCodes.get(keys[i])!;
      if (now > entry.expiresAt || entry.used) {
        this.pairingCodes.delete(keys[i]);
        cleaned++;
      }
    }
    return cleaned;
  }

  /** Get active (non-expired, non-used) code count. */
  getActiveCodeCount(): number {
    const now = Date.now();
    let count = 0;
    this.pairingCodes.forEach((entry) => {
      if (!entry.used && now <= entry.expiresAt) {
        count++;
      }
    });
    return count;
  }
}
