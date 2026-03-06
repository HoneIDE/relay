/**
 * Relay server entry point.
 * Fastify for HTTP health + WebSocketServer for relay hub.
 * Perry-compatible: compiles to a native binary.
 *
 * Uses sendToClient/closeClient from 'ws' module for explicit ws_id sends.
 * Server-level message/close listeners receive (ws_id, data) / (ws_id).
 */

import Fastify from 'fastify';
import { WebSocketServer, sendToClient, closeClient } from 'ws';
import { readFileSync } from 'fs';
import { buildConfig, parseConfigFile } from './config';
import { RoomManager } from './rooms';
import { MessageBuffer } from './buffer';
import { RelayAuth } from './auth';
import { RateLimiter } from './rate-limit';
import { WsHub, type WsConnection } from './ws-hub';

// Load config
let fileValues: Record<string, string> = {};
try {
  const content = readFileSync('./relay.conf', 'utf-8');
  fileValues = parseConfigFile(content);
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
const startTime = Date.now();

// Module-level maps: wsId (number) ↔ connId (string)
let wsToConnId: Map<number, string> = new Map();
let connIdToWsId: Map<string, number> = new Map();
let wsJoinedMap: Map<number, number> = new Map();

// Periodic cleanup
setInterval(() => {
  buffer.purge();
  auth.cleanExpired();
  rateLimiter.cleanup();
}, 30000);

// --- WebSocket server ---

const wsPort = config.port + 1;
const wss = new WebSocketServer({ port: wsPort });

wss.on('listening', () => {
  console.log('WebSocket relay on port ' + String(wsPort));
});

wss.on('connection', (ws: any) => {
  const connId = 'conn_' + String(nextConnId);
  nextConnId = nextConnId + 1;
  const wsId = Number(ws);
  wsToConnId.set(wsId, connId);
  connIdToWsId.set(connId, wsId);
  wsJoinedMap.set(wsId, 0);
});

// Server-level 'message': (ws, data)
wss.on('message', (ws: any, data: any) => {
  handleIncoming(ws, data);
});

// Server-level 'close': (ws)
wss.on('close', (ws: any) => {
  handleDisconnect(ws);
});

// Module-level handlers
function handleIncoming(ws: any, rawData: any): void {
  const wsId = Number(ws);
  const connId = wsToConnId.get(wsId);
  if (!connId) return;

  const msg = String(rawData);
  const joined = wsJoinedMap.get(wsId) || 0;

  if (joined === 0) {
    const parsed = parseJoin(msg);
    if (parsed.room.length === 0 || parsed.device.length === 0) {
      sendToClient(wsId, '{"error":"First message must be join with room and device"}');
      closeClient(wsId);
      return;
    }

    const conn: WsConnection = {
      id: connId,
      deviceId: parsed.device,
      roomId: parsed.room,
      send: makeSender(connId),
    };

    const result = hub.addConnection(conn);
    if (!result.success) {
      sendToClient(wsId, '{"error":"' + (result.error || 'Join failed') + '"}');
      closeClient(wsId);
      return;
    }

    wsJoinedMap.set(wsId, 1);
    sendToClient(wsId, '{"type":"joined","room":"' + parsed.room + '","device":"' + parsed.device + '"}');
    return;
  }

  hub.handleMessage(connId, msg);
}

function handleDisconnect(ws: any): void {
  const wsId = Number(ws);
  const connId = wsToConnId.get(wsId);
  if (!connId) return;

  const joined = wsJoinedMap.get(wsId) || 0;
  if (joined === 1) {
    hub.removeConnection(connId);
  }

  wsToConnId.delete(wsId);
  connIdToWsId.delete(connId);
  wsJoinedMap.delete(wsId);
}

// Create a send function for the WsConnection
function makeSender(connId: string): (payload: string) => void {
  return (payload: string) => {
    doSend(connId, payload);
  };
}

// Module-level send — looks up ws handle by connId at call time
function doSend(connId: string, payload: string): void {
  const wsId = connIdToWsId.get(connId);
  if (wsId !== undefined) {
    sendToClient(wsId, payload);
  }
}

// --- HTTP health endpoint via Fastify ---

const app = Fastify({ logger: false });

app.get('/health', async (request: any, reply: any) => {
  const parts: string[] = [];
  parts.push('{"status":"ok","uptime":');
  parts.push(String(Date.now() - startTime));
  parts.push(',"rooms":');
  parts.push(String(hub.rooms.getRoomCount()));
  parts.push(',"connections":');
  parts.push(String(hub.getConnectionCount()));
  parts.push(',"bufferedMessages":');
  parts.push(String(hub.buffer.getPendingCount()));
  parts.push(',"version":"0.1.0"}');
  reply.header('Content-Type', 'application/json');
  return parts.join('');
});

app.get('/', async (request: any, reply: any) => {
  return 'Hone Relay Server';
});

app.listen({ host: config.host, port: config.port }, (err: any) => {
  if (err) {
    console.log('HTTP server error');
  } else {
    console.log('HTTP health on port ' + String(config.port));
  }
});

// --- Helpers ---

function parseJoin(msg: string): { room: string; device: string } {
  try {
    const obj = JSON.parse(msg);
    const type = obj.type || '';
    if (type !== 'join') return { room: '', device: '' };
    const room = obj.room || '';
    const device = obj.device || '';
    return { room: room, device: device };
  } catch {
    return { room: '', device: '' };
  }
}
