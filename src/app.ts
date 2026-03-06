/**
 * Relay server entry point.
 * Bun HTTP + WebSocket server.
 */

import { buildConfig, parseConfigFile } from './config';
import { RoomManager } from './rooms';
import { MessageBuffer } from './buffer';
import { RelayAuth } from './auth';
import { RateLimiter } from './rate-limit';
import { WsHub, type WsConnection } from './ws-hub';
import { getHealthStatus } from './health';

// Load config
let fileValues: Record<string, string> = {};
try {
  const configFile = Bun.file('./relay.conf');
  if (await configFile.exists()) {
    fileValues = parseConfigFile(await configFile.text());
  }
} catch {
  // No config file — use defaults + env
}

const config = buildConfig(fileValues, process.env as Record<string, string>);

// Initialize components
const rooms = new RoomManager(config.maxRooms, config.maxClientsPerRoom);
const buffer = new MessageBuffer(config.bufferTtlSeconds);
const auth = new RelayAuth();
const rateLimiter = new RateLimiter();
const hub = new WsHub(rooms, buffer, auth, rateLimiter);

let nextConnId = 1;

// Periodic cleanup
setInterval(() => {
  buffer.purge();
  auth.cleanExpired();
  rateLimiter.cleanup();
}, 30_000);

// Start server
const server = Bun.serve({
  hostname: config.host,
  port: config.port,

  fetch(req, server) {
    const url = new URL(req.url);

    // Health endpoint
    if (url.pathname === '/health') {
      return Response.json(getHealthStatus(hub));
    }

    // WebSocket upgrade
    if (url.pathname === '/ws') {
      const room = url.searchParams.get('room') ?? '';
      const device = url.searchParams.get('device') ?? '';
      const ip = req.headers.get('x-forwarded-for') ?? 'unknown';

      if (!room || !device) {
        return new Response('Missing room or device', { status: 400 });
      }

      if (!rateLimiter.allow(ip)) {
        return new Response('Rate limited', { status: 429 });
      }

      const upgraded = server.upgrade(req, {
        data: { connId: 'conn_' + (nextConnId++), deviceId: device, roomId: room },
      });

      if (!upgraded) {
        return new Response('WebSocket upgrade failed', { status: 500 });
      }

      return undefined;
    }

    return new Response('Hone Relay Server', { status: 200 });
  },

  websocket: {
    open(ws) {
      const data = ws.data as { connId: string; deviceId: string; roomId: string };
      const conn: WsConnection = {
        id: data.connId,
        deviceId: data.deviceId,
        roomId: data.roomId,
        send: (msg: string) => ws.send(msg),
      };
      hub.addConnection(conn);
    },
    message(ws, message) {
      const data = ws.data as { connId: string };
      const msgStr = typeof message === 'string' ? message : new TextDecoder().decode(message as ArrayBuffer);
      hub.handleMessage(data.connId, msgStr);
    },
    close(ws) {
      const data = ws.data as { connId: string };
      hub.removeConnection(data.connId);
    },
  },
});

console.log(`Hone Relay listening on ${config.host}:${config.port}`);
