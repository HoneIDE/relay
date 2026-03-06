import { describe, test, expect, beforeEach } from 'bun:test';
import { RelayAuth } from '../src/auth';

describe('RelayAuth', () => {
  let auth: RelayAuth;

  beforeEach(() => {
    auth = new RelayAuth();
  });

  test('register and lookup pairing code', () => {
    auth.registerPairingCode('ABC123', 'room1');
    const result = auth.lookupPairingCode('ABC123');
    expect(result).not.toBeNull();
    expect(result!.roomId).toBe('room1');
  });

  test('lookup is case-insensitive', () => {
    auth.registerPairingCode('ABC123', 'room1');
    expect(auth.lookupPairingCode('abc123')).not.toBeNull();
  });

  test('lookup returns null for unknown code', () => {
    expect(auth.lookupPairingCode('UNKNOWN')).toBeNull();
  });

  test('mark used prevents reuse', () => {
    auth.registerPairingCode('ABC123', 'room1');
    auth.markUsed('ABC123');
    expect(auth.lookupPairingCode('ABC123')).toBeNull();
  });

  test('expired code returns null', () => {
    auth.registerPairingCode('ABC123', 'room1', 1); // 1ms TTL
    const start = Date.now();
    while (Date.now() - start < 5) {} // wait
    expect(auth.lookupPairingCode('ABC123')).toBeNull();
  });

  test('cleanExpired removes old codes', () => {
    auth.registerPairingCode('ABC123', 'room1', 1);
    const start = Date.now();
    while (Date.now() - start < 5) {}
    const cleaned = auth.cleanExpired();
    expect(cleaned).toBe(1);
  });

  test('getActiveCodeCount', () => {
    auth.registerPairingCode('CODE1', 'room1');
    auth.registerPairingCode('CODE2', 'room2');
    expect(auth.getActiveCodeCount()).toBe(2);
    auth.markUsed('CODE1');
    expect(auth.getActiveCodeCount()).toBe(1);
  });
});
