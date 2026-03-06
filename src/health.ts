/**
 * Health and status endpoints.
 */

import type { WsHub } from './ws-hub';

export interface HealthStatus {
  status: 'ok' | 'error';
  uptime: number;
  rooms: number;
  connections: number;
  bufferedMessages: number;
  version: string;
}

const startTime = Date.now();
const VERSION = '0.1.0';

export function getHealthStatus(hub: WsHub): HealthStatus {
  return {
    status: 'ok',
    uptime: Date.now() - startTime,
    rooms: hub.rooms.getRoomCount(),
    connections: hub.getConnectionCount(),
    bufferedMessages: hub.buffer.getPendingCount(),
    version: VERSION,
  };
}
