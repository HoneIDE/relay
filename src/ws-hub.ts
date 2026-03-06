/**
 * WebSocket hub — room-based message routing.
 *
 * This is the core relay logic: receive envelopes, validate,
 * and route to the correct recipient(s) in the room.
 */

import { RoomManager } from './rooms';
import { MessageBuffer } from './buffer';
import { RateLimiter } from './rate-limit';
import { parseEnvelope, validateEnvelope, getRoutingTarget, type RelayEnvelope } from './envelope';
import { RelayAuth } from './auth';

export interface WsConnection {
  id: string;
  deviceId: string;
  roomId: string;
  send: (data: string) => void;
}

export class WsHub {
  readonly rooms: RoomManager;
  readonly buffer: MessageBuffer;
  readonly auth: RelayAuth;
  readonly rateLimiter: RateLimiter;

  private connections: Map<string, WsConnection> = new Map(); // connId → connection
  private deviceToConn: Map<string, string> = new Map(); // deviceId → connId

  constructor(rooms: RoomManager, buffer: MessageBuffer, auth: RelayAuth, rateLimiter: RateLimiter) {
    this.rooms = rooms;
    this.buffer = buffer;
    this.auth = auth;
    this.rateLimiter = rateLimiter;
  }

  /** Register a new WebSocket connection. */
  addConnection(conn: WsConnection): { success: boolean; error?: string } {
    // Join room
    const isHost = this.rooms.getHostDeviceId(conn.roomId) === null;
    const joinResult = this.rooms.joinRoom(conn.roomId, conn.deviceId, conn.deviceId, isHost);
    if (!joinResult.success) {
      return joinResult;
    }

    this.connections.set(conn.id, conn);
    this.deviceToConn.set(conn.deviceId, conn.id);

    // Deliver buffered messages
    const buffered = this.buffer.drain(conn.roomId, conn.deviceId);
    for (let i = 0; i < buffered.length; i++) {
      conn.send(buffered[i].payload);
    }

    return { success: true };
  }

  /** Remove a WebSocket connection. */
  removeConnection(connId: string): void {
    const conn = this.connections.get(connId);
    if (!conn) return;

    this.rooms.leaveRoom(conn.roomId, conn.deviceId);
    this.deviceToConn.delete(conn.deviceId);
    this.connections.delete(connId);
  }

  /** Handle an incoming message from a connection. */
  handleMessage(connId: string, data: string): { success: boolean; error?: string } {
    const conn = this.connections.get(connId);
    if (!conn) return { success: false, error: 'Unknown connection' };

    const envelope = parseEnvelope(data);
    if (!envelope) return { success: false, error: 'Invalid envelope' };

    const validationError = validateEnvelope(envelope);
    if (validationError) return { success: false, error: validationError };

    // Verify sender matches connection
    if (envelope.from !== conn.deviceId) {
      return { success: false, error: 'Sender mismatch' };
    }

    // Verify room matches
    if (envelope.room !== conn.roomId) {
      return { success: false, error: 'Room mismatch' };
    }

    // Route
    const target = getRoutingTarget(envelope);

    if (target.type === 'host') {
      const hostDeviceId = this.rooms.getHostDeviceId(conn.roomId);
      if (!hostDeviceId) {
        this.buffer.store(conn.roomId, 'host', data);
        return { success: true };
      }
      this.sendToDevice(hostDeviceId, data, conn.roomId);
    } else if (target.type === 'broadcast') {
      const others = this.rooms.getOtherDevices(conn.roomId, conn.deviceId);
      for (let i = 0; i < others.length; i++) {
        this.sendToDevice(others[i], data, conn.roomId);
      }
    } else if (target.type === 'device' && target.deviceId) {
      this.sendToDevice(target.deviceId, data, conn.roomId);
    }

    return { success: true };
  }

  private sendToDevice(deviceId: string, data: string, roomId: string): void {
    const connId = this.deviceToConn.get(deviceId);
    if (connId) {
      const conn = this.connections.get(connId);
      if (conn) {
        conn.send(data);
        return;
      }
    }
    // Device offline — buffer
    this.buffer.store(roomId, deviceId, data);
  }

  /** Get connection count. */
  getConnectionCount(): number {
    return this.connections.size;
  }

  /** Get a connection by ID. */
  getConnection(connId: string): WsConnection | null {
    return this.connections.get(connId) ?? null;
  }
}
