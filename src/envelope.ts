/**
 * Envelope parsing and validation for the relay.
 */

export interface RelayEnvelope {
  from: string;
  to: string;
  room: string;
  seq: number;
  ts: number;
  encrypted: boolean;
  payload: string;
}

/**
 * Parse an envelope from a raw string.
 */
export function parseEnvelope(data: string): RelayEnvelope | null {
  try {
    const obj = JSON.parse(data);
    if (typeof obj.from !== 'string' || typeof obj.to !== 'string' || typeof obj.room !== 'string') {
      return null;
    }
    if (typeof obj.seq !== 'number' || typeof obj.ts !== 'number') {
      return null;
    }
    if (typeof obj.payload !== 'string') {
      return null;
    }
    return {
      from: obj.from,
      to: obj.to,
      room: obj.room,
      seq: obj.seq,
      ts: obj.ts,
      encrypted: obj.encrypted === true,
      payload: obj.payload,
    };
  } catch {
    return null;
  }
}

/**
 * Validate an envelope for routing.
 */
export function validateEnvelope(env: RelayEnvelope): string | null {
  if (!env.from || env.from.length === 0) return 'Missing "from"';
  if (!env.to || env.to.length === 0) return 'Missing "to"';
  if (!env.room || env.room.length === 0) return 'Missing "room"';
  if (env.from.length > 128) return '"from" too long';
  if (env.to.length > 128) return '"to" too long';
  if (env.room.length > 128) return '"room" too long';
  if (env.payload.length > 1024 * 1024) return 'Payload too large (>1MB)';
  return null;
}

/**
 * Determine routing target from envelope.
 */
export function getRoutingTarget(env: RelayEnvelope): { type: 'host' | 'broadcast' | 'device'; deviceId?: string } {
  if (env.to === 'host') return { type: 'host' };
  if (env.to === 'broadcast') return { type: 'broadcast' };
  return { type: 'device', deviceId: env.to };
}
