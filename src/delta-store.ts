/**
 * SQLite-backed persistent delta storage for the relay server.
 * Uses better-sqlite3 via Perry FFI.
 *
 * Perry constraint: Database and Statement handles must be module-level
 * `const` declarations from `new Database()` / `db.prepare()` so the
 * compiler can track them as native instances for method call resolution.
 *
 * Deltas are sequenced per-room. Each device tracks its cursor (last consumed seq).
 * Room metadata tracks total bytes and max seq for quota enforcement and fast lookups.
 */

import Database from 'better-sqlite3';

// Module-level const — Perry tracks this as a native "better-sqlite3:Database" instance.
// Path is always ./relay.db (matches config default). Config override not supported
// because Perry requires const initialization at module scope for native instance tracking.
const db = new Database('./relay.db');

// Table creation — runs at module init time
db.exec('PRAGMA journal_mode=WAL');

db.exec(
  'CREATE TABLE IF NOT EXISTS deltas (' +
  '  id INTEGER PRIMARY KEY AUTOINCREMENT,' +
  '  roomId TEXT NOT NULL,' +
  '  deviceId TEXT NOT NULL,' +
  '  seq INTEGER NOT NULL,' +
  '  payload TEXT NOT NULL,' +
  '  sizeBytes INTEGER NOT NULL,' +
  '  createdAt INTEGER NOT NULL' +
  ')'
);

db.exec(
  'CREATE INDEX IF NOT EXISTS idx_room_seq ON deltas(roomId, seq)'
);

db.exec(
  'CREATE TABLE IF NOT EXISTS cursors (' +
  '  roomId TEXT NOT NULL,' +
  '  deviceId TEXT NOT NULL,' +
  '  lastSeq INTEGER NOT NULL DEFAULT 0,' +
  '  updatedAt INTEGER NOT NULL,' +
  '  PRIMARY KEY (roomId, deviceId)' +
  ')'
);

db.exec(
  'CREATE TABLE IF NOT EXISTS roomMeta (' +
  '  roomId TEXT PRIMARY KEY,' +
  '  totalBytes INTEGER NOT NULL DEFAULT 0,' +
  '  maxSeq INTEGER NOT NULL DEFAULT 0,' +
  '  snapshotSeq INTEGER DEFAULT NULL,' +
  '  createdAt INTEGER NOT NULL' +
  ')'
);

// Prepared statements — module-level const so Perry tracks as native Statement instances
const stmtInsertDelta = db.prepare(
  'INSERT INTO deltas (roomId, deviceId, seq, payload, sizeBytes, createdAt) VALUES (?, ?, ?, ?, ?, ?)'
);

const stmtGetDeltasAfter = db.prepare(
  'SELECT seq, deviceId, payload, createdAt FROM deltas WHERE roomId = ? AND seq > ? ORDER BY seq ASC LIMIT 1000'
);

const stmtUpsertCursor = db.prepare(
  'INSERT INTO cursors (roomId, deviceId, lastSeq, updatedAt) VALUES (?, ?, ?, ?) ' +
  'ON CONFLICT(roomId, deviceId) DO UPDATE SET lastSeq = excluded.lastSeq, updatedAt = excluded.updatedAt'
);

const stmtGetCursor = db.prepare(
  'SELECT lastSeq FROM cursors WHERE roomId = ? AND deviceId = ?'
);

const stmtGetRoomMeta = db.prepare(
  'SELECT totalBytes, maxSeq, snapshotSeq, createdAt FROM roomMeta WHERE roomId = ?'
);

const stmtUpsertRoomMeta = db.prepare(
  'INSERT INTO roomMeta (roomId, totalBytes, maxSeq, snapshotSeq, createdAt) VALUES (?, ?, ?, NULL, ?) ' +
  'ON CONFLICT(roomId) DO UPDATE SET totalBytes = excluded.totalBytes, maxSeq = excluded.maxSeq'
);

const stmtGetDeltaCount = db.prepare(
  'SELECT COUNT(*) as cnt FROM deltas WHERE roomId = ?'
);

const stmtPurgeExpired = db.prepare(
  'DELETE FROM deltas WHERE createdAt < ?'
);

const stmtGetInactiveRooms = db.prepare(
  'SELECT roomId FROM roomMeta WHERE createdAt < ? AND roomId NOT IN ' +
  '(SELECT DISTINCT roomId FROM deltas WHERE createdAt >= ?)'
);

const stmtPurgeInactiveDeltas = db.prepare(
  'DELETE FROM deltas WHERE roomId = ?'
);

const stmtPurgeInactiveCursors = db.prepare(
  'DELETE FROM cursors WHERE roomId = ?'
);

const stmtPurgeInactiveRoomMeta = db.prepare(
  'DELETE FROM roomMeta WHERE roomId = ?'
);

/**
 * Initialize the delta store. Now a no-op since all init happens at module level.
 * Kept for API compatibility with app.ts.
 */
export function initDeltaStore(dbPath: string): void {
  // All initialization happens at module level above.
  // dbPath is ignored — Perry requires const Database() at module scope.
}

/**
 * Store a delta for a room. Returns the assigned sequence number, or -1 if quota exceeded.
 */
export function storeDelta(roomId: string, deviceId: string, payload: string, quotaBytes: number): number {
  const sizeBytes = payload.length;
  const now = Date.now();

  // Get current room meta
  const meta = stmtGetRoomMeta.get(JSON.stringify([roomId]));

  let currentBytes = 0;
  let currentMaxSeq = 0;
  let roomCreatedAt = now;

  if (meta !== undefined) {
    const metaRow = meta as any;
    currentBytes = Number(metaRow.totalBytes);
    currentMaxSeq = Number(metaRow.maxSeq);
    roomCreatedAt = Number(metaRow.createdAt);
  }

  // Check quota
  if (quotaBytes > 0 && (currentBytes + sizeBytes) > quotaBytes) {
    return -1;
  }

  const nextSeq = currentMaxSeq + 1;
  const newTotalBytes = currentBytes + sizeBytes;

  // Insert delta
  stmtInsertDelta.run(JSON.stringify([roomId, deviceId, nextSeq, payload, sizeBytes, now]));

  // Upsert room meta
  stmtUpsertRoomMeta.run(JSON.stringify([roomId, newTotalBytes, nextSeq, roomCreatedAt]));

  return nextSeq;
}

/**
 * Get all deltas after a given seq for a room, up to 1000 results.
 * Returns a JSON string array: [{"seq":N,"deviceId":"...","payload":"...","createdAt":N}, ...]
 */
export function getDeltasAfter(roomId: string, afterSeq: number): string {
  const rows = stmtGetDeltasAfter.all(JSON.stringify([roomId, afterSeq]));

  if (rows.length === 0) {
    return '[]';
  }

  // Build JSON string manually — access columns by name (Perry objects)
  let result = '[';
  for (let i = 0; i < rows.length; i++) {
    if (i > 0) {
      result += ',';
    }
    const row = rows[i] as any;
    const rSeq = row.seq;
    const rDeviceId = row.deviceId;
    const rPayload = row.payload;
    const rCreatedAt = row.createdAt;
    // Escape payload for JSON embedding (it's already JSON, but may contain quotes in string values)
    let escapedPayload = '';
    const p = String(rPayload);
    for (let j = 0; j < p.length; j++) {
      const ch = p[j];
      if (ch === '\\') {
        escapedPayload += '\\\\';
      } else if (ch === '"') {
        escapedPayload += '\\"';
      } else if (ch === '\n') {
        escapedPayload += '\\n';
      } else if (ch === '\r') {
        escapedPayload += '\\r';
      } else if (ch === '\t') {
        escapedPayload += '\\t';
      } else {
        escapedPayload += ch;
      }
    }
    result += '{"seq":' + String(rSeq) + ',"deviceId":"' + String(rDeviceId) + '","payload":"' + escapedPayload + '","createdAt":' + String(rCreatedAt) + '}';
  }
  result += ']';

  return result;
}

/**
 * Update cursor for a device in a room.
 */
export function updateCursor(roomId: string, deviceId: string, lastSeq: number): void {
  const now = Date.now();
  stmtUpsertCursor.run(JSON.stringify([roomId, deviceId, lastSeq, now]));
}

/**
 * Get cursor (last consumed seq) for a device in a room.
 * Returns 0 if no cursor exists.
 */
export function getCursor(roomId: string, deviceId: string): number {
  const row = stmtGetCursor.get(JSON.stringify([roomId, deviceId]));
  if (row === undefined) {
    return 0;
  }
  return Number((row as any).lastSeq);
}

/**
 * Get total bytes stored for a room.
 * Returns 0 if room doesn't exist.
 */
export function getRoomBytes(roomId: string): number {
  const meta = stmtGetRoomMeta.get(JSON.stringify([roomId]));
  if (meta === undefined) {
    return 0;
  }
  return Number((meta as any).totalBytes);
}

/**
 * Get max sequence number for a room.
 * Returns 0 if room doesn't exist.
 */
export function getRoomMaxSeq(roomId: string): number {
  const meta = stmtGetRoomMeta.get(JSON.stringify([roomId]));
  if (meta === undefined) {
    return 0;
  }
  return Number((meta as any).maxSeq);
}

/**
 * Purge old deltas.
 * 1) Remove all deltas older than maxAgeMs.
 * 2) Remove all data for rooms with no deltas newer than inactiveMs.
 * Returns total number of deltas removed.
 */
export function purgeOldDeltas(maxAgeMs: number, inactiveMs: number): number {
  const now = Date.now();
  let totalPurged = 0;

  // Step 1: Delete deltas older than maxAgeMs
  const cutoffAge = now - maxAgeMs;
  const ageResult = stmtPurgeExpired.run(JSON.stringify([cutoffAge]));
  totalPurged += ageResult.changes;

  // Step 2: Find and destroy rooms inactive for inactiveMs
  const cutoffInactive = now - inactiveMs;
  const inactiveRooms = stmtGetInactiveRooms.all(JSON.stringify([cutoffInactive, cutoffInactive]));

  for (let i = 0; i < inactiveRooms.length; i++) {
    const rid = String((inactiveRooms[i] as any).roomId);

    // Count deltas being removed
    const countRow = stmtGetDeltaCount.get(JSON.stringify([rid]));
    const cnt = countRow !== undefined ? Number((countRow as any).cnt) : 0;
    totalPurged += cnt;

    // Remove all data for this room
    stmtPurgeInactiveDeltas.run(JSON.stringify([rid]));
    stmtPurgeInactiveCursors.run(JSON.stringify([rid]));
    stmtPurgeInactiveRoomMeta.run(JSON.stringify([rid]));
  }

  // Recalculate roomMeta totalBytes for remaining rooms
  const stmtAllRooms2 = db.prepare('SELECT roomId FROM roomMeta');
  const allRooms = stmtAllRooms2.all(JSON.stringify([]));
  const stmtSumBytes2 = db.prepare('SELECT COALESCE(SUM(sizeBytes), 0) as total FROM deltas WHERE roomId = ?');
  const stmtUpdateBytes2 = db.prepare('UPDATE roomMeta SET totalBytes = ? WHERE roomId = ?');

  for (let i = 0; i < allRooms.length; i++) {
    const rid = String((allRooms[i] as any).roomId);
    const sumRow = stmtSumBytes2.get(JSON.stringify([rid]));
    const total = sumRow !== undefined ? Number((sumRow as any).total) : 0;
    stmtUpdateBytes2.run(JSON.stringify([total, rid]));
  }

  return totalPurged;
}

/**
 * Get number of deltas stored for a room.
 */
export function getDeltaCount(roomId: string): number {
  const row = stmtGetDeltaCount.get(JSON.stringify([roomId]));
  if (row === undefined) {
    return 0;
  }
  return Number((row as any).cnt);
}
