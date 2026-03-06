/**
 * Transient message buffer for offline delivery.
 * Messages are stored encrypted and purged after TTL or delivery.
 */

export interface BufferedMessage {
  id: number;
  roomId: string;
  targetDeviceId: string;
  payload: string;
  createdAt: number;
  delivered: boolean;
}

export class MessageBuffer {
  private messages: BufferedMessage[] = [];
  private nextId: number = 1;
  private ttlMs: number;

  constructor(ttlSeconds: number = 60) {
    this.ttlMs = ttlSeconds * 1000;
  }

  /** Store a message for later delivery. */
  store(roomId: string, targetDeviceId: string, payload: string): number {
    const id = this.nextId++;
    this.messages.push({
      id,
      roomId,
      targetDeviceId,
      payload,
      createdAt: Date.now(),
      delivered: false,
    });
    return id;
  }

  /** Get undelivered messages for a device. Marks them as delivered. */
  drain(roomId: string, targetDeviceId: string): BufferedMessage[] {
    const result: BufferedMessage[] = [];
    for (let i = 0; i < this.messages.length; i++) {
      const msg = this.messages[i];
      if (msg.roomId === roomId && msg.targetDeviceId === targetDeviceId && !msg.delivered) {
        msg.delivered = true;
        result.push(msg);
      }
    }
    return result;
  }

  /** Purge expired and delivered messages. */
  purge(): number {
    const now = Date.now();
    const before = this.messages.length;
    this.messages = this.messages.filter(m => !m.delivered && (now - m.createdAt) < this.ttlMs);
    return before - this.messages.length;
  }

  /** Get pending (undelivered, non-expired) message count. */
  getPendingCount(): number {
    const now = Date.now();
    let count = 0;
    for (let i = 0; i < this.messages.length; i++) {
      if (!this.messages[i].delivered && (now - this.messages[i].createdAt) < this.ttlMs) {
        count++;
      }
    }
    return count;
  }

  /** Total stored messages (including delivered/expired). */
  getTotalCount(): number {
    return this.messages.length;
  }
}
