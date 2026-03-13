/**
 * Relay server entry point — Perry-compatible routing.
 *
 * ARCHITECTURE: All message routing is done INLINE in onWsMessage using
 * number-keyed Maps and parallel arrays.
 *
 * Perry constraints:
 *   - Number-keyed Maps only for lookups
 *   - Parallel arrays for room membership
 *   - Module-level functions for callbacks
 *   - NO cross-function string returns (return NaN-boxed floats)
 *   - NO cross-function module-var mutation (caller snapshots scalars)
 *   - ALL string extraction must be inline (indexOf + slice)
 *   - charCodeAt for string comparison
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
import { initDeltaStore, storeDelta, getDeltasAfter, updateCursor, getCursor, getRoomMaxSeq, getRoomBytes, purgeOldDeltas } from './delta-store';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

let fileValues: Record<string, string> = {};
try {
  const content = readFileSync('./relay.conf', 'utf-8');
  fileValues = parseConfigFile(content);
} catch {
  // No config file
}

const config = buildConfig(fileValues, process.env as Record<string, string>);

// Initialize persistent delta store
initDeltaStore(config.sqlitePath);

// ---------------------------------------------------------------------------
// WsHub kept for tests / health
// ---------------------------------------------------------------------------

const rooms = new RoomManager(config.maxRooms, config.maxClientsPerRoom);
const buffer = new MessageBuffer(config.bufferTtlSeconds);
const auth = new RelayAuth();
const rateLimiter = new RateLimiter();
const hub = new WsHub(rooms, buffer, auth, rateLimiter);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let nextConnId = 1;
const startTime = Date.now();

let wsJoined: Map<number, number> = new Map();

// Slot tracking — Maps instead of arrays (Perry push() bug)
let slotWsIdMap: Map<number, number> = new Map();
let slotDeviceIdMap: Map<number, string> = new Map();
let slotRoomIdMap: Map<number, string> = new Map();
let slotActiveMap: Map<number, number> = new Map();
let slotCount = 0;

let wsIdToSlot: Map<number, number> = new Map();
let freeSlots: number[] = [];

// Room membership — use Maps instead of arrays (Perry push() bug)
let memRoomHash: Map<number, number> = new Map();
let memWsId: Map<number, number> = new Map();
let memIsHost: Map<number, number> = new Map();
let memActive: Map<number, number> = new Map();
let memberCount = 0;

let roomHostWsId: Map<number, number> = new Map();
let roomMemberCount: Map<number, number> = new Map();
let wsIdToConnId: Map<number, string> = new Map();

// ---------------------------------------------------------------------------
// Helpers that DON'T return strings (only modify arrays/Maps or return numbers)
// ---------------------------------------------------------------------------

function djb2Hash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h * 33) + s.charCodeAt(i)) | 0;
  }
  if (h < 0) {
    h = h + 2147483648 + 2147483648;
  }
  return h;
}

function strEqN(a: string, b: string): number {
  if (a.length !== b.length) return 0;
  for (let i = 0; i < a.length; i++) {
    if (a.charCodeAt(i) !== b.charCodeAt(i)) return 0;
  }
  return 1;
}

// ---------------------------------------------------------------------------
// Token validation — same algorithm as hone-auth (local, no HTTP call needed)
// Token format: userId:deviceId:timestamp.hash
// ---------------------------------------------------------------------------

function computeTokenHash(payload: string): number {
  let input1 = config.authSecret;
  input1 += '|';
  input1 += payload;
  const h1 = djb2Hash(input1);
  let input2 = String(h1);
  input2 += '|';
  input2 += config.authSecret;
  input2 += '|';
  input2 += payload;
  return djb2Hash(input2);
}

function validateToken(token: string): number {
  if (token.length < 3) return 0;
  // Find last dot
  let lastDot = -1;
  for (let i = token.length - 1; i >= 0; i--) {
    if (token.charCodeAt(i) === 46) { lastDot = i; break; }
  }
  if (lastDot < 1) return 0;

  const payload = token.slice(0, lastDot);
  const hashStr = token.slice(lastDot + 1);
  const givenHash = Number(hashStr);
  const expectedHash = computeTokenHash(payload);
  if (givenHash !== expectedHash) return 0;

  // Extract userId (before first colon)
  let firstColon = -1;
  for (let i = 0; i < payload.length; i++) {
    if (payload.charCodeAt(i) === 58) { firstColon = i; break; }
  }
  if (firstColon < 1) return 0;
  const userId = Number(payload.slice(0, firstColon));
  if (userId < 1) return 0;
  return userId;
}

function allocSlot(theWsId: number, deviceId: string, roomId: string): void {
  let slot = -1;
  if (freeSlots.length > 0) {
    slot = freeSlots[freeSlots.length - 1];
    freeSlots.length = freeSlots.length - 1;
  } else {
    slot = slotCount;
    slotCount = slotCount + 1;
  }
  slotWsIdMap.set(slot, theWsId);
  slotDeviceIdMap.set(slot, deviceId);
  slotRoomIdMap.set(slot, roomId);
  slotActiveMap.set(slot, 1);
  wsIdToSlot.set(theWsId, slot);
}

function freeSlot(slot: number): void {
  slotActiveMap.set(slot, 0);
  const sw = slotWsIdMap.get(slot) || 0;
  wsIdToSlot.delete(sw);
  freeSlots.push(slot);
}

function addRoomMember(roomHash: number, theWsId: number, isHost: number): void {
  const idx = memberCount;
  memRoomHash.set(idx, roomHash);
  memWsId.set(idx, theWsId);
  memIsHost.set(idx, isHost);
  memActive.set(idx, 1);
  memberCount = memberCount + 1;
  if (isHost === 1) {
    roomHostWsId.set(roomHash, theWsId);
  }
  const prev = roomMemberCount.get(roomHash) || 0;
  roomMemberCount.set(roomHash, prev + 1);
}

function removeRoomMember(theWsId: number): void {
  for (let i = 0; i < memberCount; i++) {
    const active = memActive.get(i) || 0;
    if (active !== 1) continue;
    const mWs = memWsId.get(i) || 0;
    if (mWs !== theWsId) continue;
    memActive.set(i, 0);
    const rh = memRoomHash.get(i) || 0;
    const isH = memIsHost.get(i) || 0;
    if (isH === 1) {
      roomHostWsId.delete(rh);
    }
    const prev = roomMemberCount.get(rh) || 0;
    if (prev <= 1) {
      roomMemberCount.delete(rh);
      roomHostWsId.delete(rh);
    } else {
      roomMemberCount.set(rh, prev - 1);
    }
    return;
  }
}

function broadcastToRoom(roomHash: number, senderWsId: number, data: string): void {
  let sent = 0;
  for (let i = 0; i < memberCount; i++) {
    const active = memActive.get(i) || 0;
    if (active !== 1) continue;
    const mHash = memRoomHash.get(i) || 0;
    if (mHash !== roomHash) continue;
    const mWs = memWsId.get(i) || 0;
    if (mWs === senderWsId) continue;
    sendToClient(mWs, data);
    sent = sent + 1;
  }
}

function sendToRoomHost(roomHash: number, data: string): void {
  if (roomHostWsId.has(roomHash)) {
    const hostWs = roomHostWsId.get(roomHash) || 0;
    sendToClient(hostWs, data);
  }
}

// ---------------------------------------------------------------------------
// Periodic cleanup
// ---------------------------------------------------------------------------

setInterval(cleanupPeriodic, 30000);

function cleanupPeriodic(): void {
  buffer.purge();
  auth.cleanExpired();
  rateLimiter.cleanup();
  // Purge deltas older than 30 days, rooms inactive for 90 days
  purgeOldDeltas(30 * 24 * 60 * 60 * 1000, 90 * 24 * 60 * 60 * 1000);
}

// ---------------------------------------------------------------------------
// WebSocket server
// ---------------------------------------------------------------------------

const wsPort = config.port + 1;
const wss = new WebSocketServer({ port: wsPort });

wss.on('listening', onWsListening);

function onWsListening(): void {
  console.log('WebSocket relay on port ' + String(wsPort));
}

wss.on('connection', onWsConnection);

function onWsConnection(ws: any): void {
  const wsId = Number(ws);
  wsJoined.set(wsId, 0);
}

wss.on('message', onWsMessage);

// ---------------------------------------------------------------------------
// MAIN MESSAGE HANDLER — everything inlined, no string-returning helpers
// ---------------------------------------------------------------------------

function onWsMessage(ws: any, data: any): void {
  const wsId = Number(ws);
  if (!wsJoined.has(wsId)) return;
  const joined = wsJoined.get(wsId) as number;

  const msg = String(data);

  if (joined === 0) {
    // ===================== JOIN PATH (inline) =====================
    // Check for "join" in message
    const joinIdx = msg.indexOf('"join"');
    if (joinIdx < 0) {
      sendToClient(wsId, '{"error":"First message must be join"}');
      closeClient(wsId);
      wsJoined.delete(wsId);
      return;
    }

    // Extract room: find "room":"..."
    const roomKeyIdx = msg.indexOf('"room"');
    if (roomKeyIdx < 0) {
      sendToClient(wsId, '{"error":"Missing room"}');
      closeClient(wsId);
      wsJoined.delete(wsId);
      return;
    }
    const roomColonIdx = msg.indexOf(':', roomKeyIdx + 6);
    const roomQS = msg.indexOf('"', roomColonIdx + 1);
    const roomQE = msg.indexOf('"', roomQS + 1);
    const theRoom = msg.slice(roomQS + 1, roomQE);

    // Extract device: find "device":"..."
    const devKeyIdx = msg.indexOf('"device"');
    if (devKeyIdx < 0) {
      sendToClient(wsId, '{"error":"Missing device"}');
      closeClient(wsId);
      wsJoined.delete(wsId);
      return;
    }
    const devColonIdx = msg.indexOf(':', devKeyIdx + 8);
    const devQS = msg.indexOf('"', devColonIdx + 1);
    const devQE = msg.indexOf('"', devQS + 1);
    const theDevice = msg.slice(devQS + 1, devQE);

    if (theRoom.length === 0 || theDevice.length === 0) {
      sendToClient(wsId, '{"error":"Empty room or device"}');
      closeClient(wsId);
      wsJoined.delete(wsId);
      return;
    }

    // Extract token: find "token":"..."
    let theToken = '';
    const tokKeyIdx = msg.indexOf('"token"');
    if (tokKeyIdx >= 0) {
      const tokColonIdx = msg.indexOf(':', tokKeyIdx + 7);
      const tokQS = msg.indexOf('"', tokColonIdx + 1);
      const tokQE = msg.indexOf('"', tokQS + 1);
      theToken = msg.slice(tokQS + 1, tokQE);
    }

    // Extract lastSeq (optional, defaults to 0)
    let lastSeq = 0;
    const lsKeyIdx = msg.indexOf('"lastSeq"');
    if (lsKeyIdx >= 0) {
      const lsColonIdx = msg.indexOf(':', lsKeyIdx + 9);
      // Find start of number (skip whitespace)
      let lsNumStart = lsColonIdx + 1;
      while (lsNumStart < msg.length && msg.charCodeAt(lsNumStart) === 32) {
        lsNumStart = lsNumStart + 1;
      }
      // Find end of number
      let lsNumEnd = lsNumStart;
      while (lsNumEnd < msg.length) {
        const ch = msg.charCodeAt(lsNumEnd);
        if (ch < 48 || ch > 57) break;
        lsNumEnd = lsNumEnd + 1;
      }
      if (lsNumEnd > lsNumStart) {
        lastSeq = Number(msg.slice(lsNumStart, lsNumEnd));
      }
    }

    // Validate auth token (if auth is configured)
    if (config.authSecret.length > 0) {
      if (theToken.length === 0) {
        sendToClient(wsId, '{"error":"Authentication required"}');
        closeClient(wsId);
        wsJoined.delete(wsId);
        return;
      }
      const tokenUserId = validateToken(theToken);
      if (tokenUserId < 1) {
        sendToClient(wsId, '{"error":"Invalid token"}');
        closeClient(wsId);
        wsJoined.delete(wsId);
        return;
      }
      console.log('Auth OK: userId=' + String(tokenUserId) + ' device=' + theDevice);
    }

    // Check room capacity
    const rHash = djb2Hash(theRoom);
    const currentCount = roomMemberCount.get(rHash) || 0;
    if (currentCount >= config.maxClientsPerRoom) {
      sendToClient(wsId, '{"error":"Room full"}');
      closeClient(wsId);
      wsJoined.delete(wsId);
      return;
    }

    // First to join = host — use .has() since Perry === undefined may fail
    let isHost = 0;
    if (!roomHostWsId.has(rHash)) {
      isHost = 1;
    }

    // Register
    allocSlot(wsId, theDevice, theRoom);
    addRoomMember(rHash, wsId, isHost);
    wsJoined.set(wsId, 1);

    // WsHub for health endpoint
    const connId = 'conn_' + String(nextConnId);
    nextConnId = nextConnId + 1;
    const conn: WsConnection = {
      id: connId,
      deviceId: theDevice,
      roomId: theRoom,
      send: makeSender(wsId),
    };
    hub.addConnection(conn);
    wsIdToConnId.set(wsId, connId);

    // Send confirmation — build string with concat
    let conf = '{"type":"joined","room":"';
    conf += theRoom;
    conf += '","device":"';
    conf += theDevice;
    conf += '"}';
    sendToClient(wsId, conf);

    console.log('Joined wsId=' + String(wsId) + ' host=' + String(isHost) + ' room=' + theRoom + ' device=' + theDevice);

    // Deliver persisted deltas from SQLite (since lastSeq)
    const deltasJson = getDeltasAfter(theRoom, lastSeq);
    // Parse the JSON array of deltas and send each payload
    if (deltasJson.length > 2) {
      // deltasJson is like: [{"seq":1,"deviceId":"...","payload":"...","createdAt":N}, ...]
      // Send as a batch message
      let batchMsg = '{"type":"deltas","room":"';
      batchMsg += theRoom;
      batchMsg += '","deltas":';
      batchMsg += deltasJson;
      batchMsg += '}';
      sendToClient(wsId, batchMsg);
    }

    // Update cursor
    const roomMaxSeq = getRoomMaxSeq(theRoom);
    if (roomMaxSeq > 0) {
      updateCursor(theRoom, theDevice, roomMaxSeq);
    }

    // Also drain in-memory buffer (for messages not yet persisted)
    const buffered = buffer.drain(theRoom, theDevice);
    for (let i = 0; i < buffered.length; i++) {
      sendToClient(wsId, buffered[i].payload);
    }

    return;
  }

  // ===================== ROUTING PATH (inline) =====================
  // Skip keepalive pings (Perry indexOf may misparse short JSON messages)
  // Check for "type" key — ping/pong messages have "type" but no "from"/"to"/"room"
  if (msg.length < 30) {
    // Short messages are likely pings; check for "ping" (charCode: p=112 i=105 n=110 g=103)
    const pingCheck = msg.indexOf('"ping"');
    if (pingCheck >= 0) return;
    const pongCheck = msg.indexOf('"pong"');
    if (pongCheck >= 0) return;
  }
  if (!wsIdToSlot.has(wsId)) { return; }
  const slot = wsIdToSlot.get(wsId) as number;
  const slotAct = slotActiveMap.get(slot) || 0;
  if (slotAct !== 1) { console.log('ROUTE FAIL: slot not active'); return; }

  const senderRoomId = slotRoomIdMap.get(slot) || '';
  const roomHash = djb2Hash(senderRoomId);

  // Extract "from":"..."
  const fromKeyIdx = msg.indexOf('"from"');
  if (fromKeyIdx < 0) return;
  const fromColonIdx = msg.indexOf(':', fromKeyIdx + 6);
  const fromQS = msg.indexOf('"', fromColonIdx + 1);
  let fromQE = fromQS + 1;
  while (fromQE < msg.length) {
    const ch = msg.charCodeAt(fromQE);
    if (ch === 92) { fromQE = fromQE + 2; }
    else if (ch === 34) { break; }
    else { fromQE = fromQE + 1; }
  }
  const eFrom = msg.slice(fromQS + 1, fromQE);

  // Extract "to":"..."
  const toKeyIdx = msg.indexOf('"to"');
  if (toKeyIdx < 0) return;
  const toColonIdx = msg.indexOf(':', toKeyIdx + 4);
  const toQS = msg.indexOf('"', toColonIdx + 1);
  let toQE = toQS + 1;
  while (toQE < msg.length) {
    const ch = msg.charCodeAt(toQE);
    if (ch === 92) { toQE = toQE + 2; }
    else if (ch === 34) { break; }
    else { toQE = toQE + 1; }
  }
  const eTo = msg.slice(toQS + 1, toQE);

  // Extract "room":"..."
  const roomKeyIdx2 = msg.indexOf('"room"');
  if (roomKeyIdx2 < 0) return;
  const roomColonIdx2 = msg.indexOf(':', roomKeyIdx2 + 6);
  const roomQS2 = msg.indexOf('"', roomColonIdx2 + 1);
  const roomQE2 = msg.indexOf('"', roomQS2 + 1);
  const eRoom = msg.slice(roomQS2 + 1, roomQE2);

  // Validate required fields
  if (eFrom.length === 0) { return; }
  if (eTo.length === 0) { return; }
  if (eRoom.length === 0) { return; }
  if (eFrom.length > 128) { return; }
  if (eTo.length > 128) { return; }

  // Log sender device (soft check — don't block routing on mismatch since
  // Perry slot reuse can cause stale device ID mappings)
  const senderDeviceId = slotDeviceIdMap.get(slot) || '';
  if (senderDeviceId.length > 0 && eFrom.length > 0 && senderDeviceId.length === eFrom.length) {
    let fromMatch = 1;
    for (let i = 0; i < eFrom.length; i++) {
      if (eFrom.charCodeAt(i) !== senderDeviceId.charCodeAt(i)) {
        fromMatch = 0;
        break;
      }
    }
    if (fromMatch !== 1) {
      // Update slot device ID to the actual sender
      slotDeviceIdMap.set(slot, eFrom);
    }
  }

  // Verify room matches
  if (eRoom.length !== senderRoomId.length) { return; }
  let roomMatch = 1;
  for (let i = 0; i < eRoom.length; i++) {
    if (eRoom.charCodeAt(i) !== senderRoomId.charCodeAt(i)) {
      roomMatch = 0;
      break;
    }
  }
  if (roomMatch !== 1) return;

  // Route based on "to"
  // Check "host" (h=104 o=111 s=115 t=116)
  let isHostTarget = 0;
  if (eTo.length === 4) {
    if (eTo.charCodeAt(0) === 104) {
      if (eTo.charCodeAt(1) === 111) {
        if (eTo.charCodeAt(2) === 115) {
          if (eTo.charCodeAt(3) === 116) {
            isHostTarget = 1;
          }
        }
      }
    }
  }

  // Check "broadcast" (b=98 r=114 o=111 a=97 d=100 c=99 a=97 s=115 t=116)
  let isBroadcast = 0;
  if (eTo.length === 9) {
    if (eTo.charCodeAt(0) === 98) {
      if (eTo.charCodeAt(1) === 114) {
        if (eTo.charCodeAt(2) === 111) {
          if (eTo.charCodeAt(3) === 97) {
            if (eTo.charCodeAt(4) === 100) {
              if (eTo.charCodeAt(5) === 99) {
                if (eTo.charCodeAt(6) === 97) {
                  if (eTo.charCodeAt(7) === 115) {
                    if (eTo.charCodeAt(8) === 116) {
                      isBroadcast = 1;
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  if (isHostTarget === 1) {
    console.log('Route: host roomHash=' + String(roomHash));
    sendToRoomHost(roomHash, msg);
  } else if (isBroadcast === 1) {
    const rmCount = roomMemberCount.get(roomHash) || 0;
    console.log('Route: broadcast roomHash=' + String(roomHash) + ' sender=' + String(wsId) + ' members=' + String(rmCount));
    broadcastToRoom(roomHash, wsId, msg);
    // Persist delta to SQLite (0 = no quota enforcement on relay side for now)
    const senderDevice = slotDeviceIdMap.get(slot) || '';
    storeDelta(senderRoomId, senderDevice, msg, 0);
  } else {
    // Direct device target — find the target wsId by scanning members
    let targetWs = -1;
    for (let i = 0; i < memberCount; i++) {
      const mActive = memActive.get(i) || 0;
      if (mActive !== 1) continue;
      const mHash = memRoomHash.get(i) || 0;
      if (mHash !== roomHash) continue;
      const mWsIdVal = memWsId.get(i) || 0;
      if (mWsIdVal === wsId) continue;
      const tSlot = wsIdToSlot.get(mWsIdVal);
      if (tSlot !== undefined && (slotActiveMap.get(tSlot) || 0) === 1) {
        const tDev = slotDeviceIdMap.get(tSlot) || '';
        if (eTo.length === tDev.length) {
          let match = 1;
          for (let j = 0; j < eTo.length; j++) {
            if (eTo.charCodeAt(j) !== tDev.charCodeAt(j)) {
              match = 0;
              break;
            }
          }
          if (match === 1) {
            targetWs = mWsIdVal;
            break;
          }
        }
      }
    }
    if (targetWs !== -1) {
      sendToClient(targetWs, msg);
    } else {
      // Target device offline — buffer for delivery on reconnect
      buffer.store(senderRoomId, eTo, msg);
    }
    // Persist direct messages too
    const senderDevice2 = slotDeviceIdMap.get(slot) || '';
    storeDelta(senderRoomId, senderDevice2, msg, 0);
  }
}

wss.on('close', onWsClose);

function onWsClose(ws: any): void {
  const wsId = Number(ws);
  const joined = wsJoined.get(wsId);

  if (joined === 1) {
    removeRoomMember(wsId);

    const connId = wsIdToConnId.get(wsId);
    if (connId !== undefined) {
      hub.removeConnection(connId);
      wsIdToConnId.delete(wsId);
    }
  }

  const slot = wsIdToSlot.get(wsId);
  if (slot !== undefined && (slotActiveMap.get(slot) || 0) === 1) {
    freeSlot(slot);
  }

  wsJoined.delete(wsId);
}

// ---------------------------------------------------------------------------
// Sender factory
// ---------------------------------------------------------------------------

function makeSender(targetWsId: number): (payload: string) => void {
  return (payload: string) => {
    doSend(targetWsId, payload);
  };
}

function doSend(wsId: number, payload: string): void {
  sendToClient(wsId, payload);
}

// ---------------------------------------------------------------------------
// HTTP health endpoint
// ---------------------------------------------------------------------------

const app = Fastify({ logger: false });

app.get('/health', async (request: any, reply: any) => {
  let count = 0;
  for (let i = 0; i < slotCount; i++) {
    const sa = slotActiveMap.get(i) || 0;
    if (sa === 1) {
      count = count + 1;
    }
  }
  const seen: Map<number, number> = new Map();
  for (let i = 0; i < memberCount; i++) {
    const a = memActive.get(i) || 0;
    if (a === 1) {
      const rh = memRoomHash.get(i) || 0;
      seen.set(rh, 1);
    }
  }
  let body = '{"status":"ok","uptime":';
  body += String(Date.now() - startTime);
  body += ',"rooms":';
  body += String(seen.size);
  body += ',"connections":';
  body += String(count);
  body += ',"version":"0.2.0"}';
  reply.header('Content-Type', 'application/json');
  return body;
});

app.get('/', async (request: any, reply: any) => {
  return 'Hone Relay Server';
});

app.listen({ host: config.host, port: config.port }, onHttpListen);

function onHttpListen(err: any): void {
  if (err) {
    console.log('HTTP server error');
  } else {
    console.log('HTTP health on port ' + String(config.port));
  }
}
