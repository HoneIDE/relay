import { describe, test, expect, beforeEach } from 'bun:test';
import { WsHub, type WsConnection } from '../src/ws-hub';
import { RoomManager } from '../src/rooms';
import { MessageBuffer } from '../src/buffer';
import { RelayAuth } from '../src/auth';
import { RateLimiter } from '../src/rate-limit';

function makeConn(id: string, deviceId: string, roomId: string): WsConnection & { sent: string[] } {
  const sent: string[] = [];
  return {
    id,
    deviceId,
    roomId,
    sent,
    send(data: string) { sent.push(data); },
  };
}

function makeEnvelope(from: string, to: string, room: string, payload: string = 'test'): string {
  return JSON.stringify({ from, to, room, seq: 1, ts: Date.now(), encrypted: false, payload });
}

describe('WsHub', () => {
  let hub: WsHub;

  beforeEach(() => {
    hub = new WsHub(new RoomManager(), new MessageBuffer(), new RelayAuth(), new RateLimiter());
  });

  test('add and remove connection', () => {
    const conn = makeConn('c1', 'dev1', 'room1');
    const result = hub.addConnection(conn);
    expect(result.success).toBe(true);
    expect(hub.getConnectionCount()).toBe(1);

    hub.removeConnection('c1');
    expect(hub.getConnectionCount()).toBe(0);
  });

  test('first connection becomes host', () => {
    hub.addConnection(makeConn('c1', 'dev1', 'room1'));
    expect(hub.rooms.getHostDeviceId('room1')).toBe('dev1');
  });

  test('route message to host', () => {
    const host = makeConn('c1', 'host1', 'room1');
    const guest = makeConn('c2', 'guest1', 'room1');
    hub.addConnection(host);
    hub.addConnection(guest);

    const env = makeEnvelope('guest1', 'host', 'room1', 'hello host');
    hub.handleMessage('c2', env);

    expect(host.sent.length).toBe(1);
    expect(host.sent[0]).toContain('hello host');
  });

  test('route message to specific device', () => {
    const host = makeConn('c1', 'host1', 'room1');
    const guest = makeConn('c2', 'guest1', 'room1');
    hub.addConnection(host);
    hub.addConnection(guest);

    const env = makeEnvelope('host1', 'guest1', 'room1', 'hello guest');
    hub.handleMessage('c1', env);

    expect(guest.sent.length).toBe(1);
    expect(guest.sent[0]).toContain('hello guest');
  });

  test('broadcast to all others', () => {
    const host = makeConn('c1', 'host1', 'room1');
    const g1 = makeConn('c2', 'guest1', 'room1');
    const g2 = makeConn('c3', 'guest2', 'room1');
    hub.addConnection(host);
    hub.addConnection(g1);
    hub.addConnection(g2);

    const env = makeEnvelope('host1', 'broadcast', 'room1', 'to all');
    hub.handleMessage('c1', env);

    expect(g1.sent.length).toBe(1);
    expect(g2.sent.length).toBe(1);
    expect(host.sent.length).toBe(0); // sender excluded
  });

  test('reject sender mismatch', () => {
    hub.addConnection(makeConn('c1', 'dev1', 'room1'));
    const env = makeEnvelope('fake_sender', 'host', 'room1');
    const result = hub.handleMessage('c1', env);
    expect(result.success).toBe(false);
    expect(result.error).toContain('mismatch');
  });

  test('reject room mismatch', () => {
    hub.addConnection(makeConn('c1', 'dev1', 'room1'));
    const env = makeEnvelope('dev1', 'host', 'wrong_room');
    const result = hub.handleMessage('c1', env);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Room mismatch');
  });

  test('reject invalid envelope', () => {
    hub.addConnection(makeConn('c1', 'dev1', 'room1'));
    const result = hub.handleMessage('c1', 'not json');
    expect(result.success).toBe(false);
  });

  test('buffer message for offline device', () => {
    hub.addConnection(makeConn('c1', 'host1', 'room1'));
    // guest2 not connected
    hub.rooms.joinRoom('room1', 'guest2', 'guest2', false);

    const env = makeEnvelope('host1', 'guest2', 'room1', 'offline msg');
    hub.handleMessage('c1', env);

    expect(hub.buffer.getPendingCount()).toBe(1);
  });

  test('deliver buffered messages on connect', () => {
    hub.addConnection(makeConn('c1', 'host1', 'room1'));
    // Buffer a message for guest1
    hub.buffer.store('room1', 'guest1', 'buffered hello');

    const guest = makeConn('c2', 'guest1', 'room1');
    hub.addConnection(guest);

    expect(guest.sent.length).toBe(1);
    expect(guest.sent[0]).toBe('buffered hello');
  });

  test('room destroyed when all leave', () => {
    const c1 = makeConn('c1', 'dev1', 'room1');
    hub.addConnection(c1);
    expect(hub.rooms.getRoomCount()).toBe(1);

    hub.removeConnection('c1');
    expect(hub.rooms.getRoomCount()).toBe(0);
  });

  test('reject unknown connection message', () => {
    const result = hub.handleMessage('nonexistent', 'any');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown');
  });

  test('getConnection returns connection', () => {
    hub.addConnection(makeConn('c1', 'dev1', 'room1'));
    expect(hub.getConnection('c1')).not.toBeNull();
    expect(hub.getConnection('nonexistent')).toBeNull();
  });
});
