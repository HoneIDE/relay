import { describe, test, expect } from 'bun:test';
import { parseEnvelope, validateEnvelope, getRoutingTarget } from '../src/envelope';

describe('Envelope', () => {
  const validEnv = {
    from: 'dev1',
    to: 'host',
    room: 'room1',
    seq: 1,
    ts: Date.now(),
    encrypted: false,
    payload: 'test',
  };

  test('parseEnvelope parses valid JSON', () => {
    const result = parseEnvelope(JSON.stringify(validEnv));
    expect(result).not.toBeNull();
    expect(result!.from).toBe('dev1');
    expect(result!.to).toBe('host');
    expect(result!.room).toBe('room1');
  });

  test('parseEnvelope returns null for invalid JSON', () => {
    expect(parseEnvelope('not json')).toBeNull();
  });

  test('parseEnvelope returns null for missing from', () => {
    expect(parseEnvelope(JSON.stringify({ to: 'host', room: 'r', seq: 1, ts: 1, payload: '' }))).toBeNull();
  });

  test('parseEnvelope returns null for missing seq', () => {
    expect(parseEnvelope(JSON.stringify({ from: 'a', to: 'b', room: 'r', ts: 1, payload: '' }))).toBeNull();
  });

  test('parseEnvelope returns null for missing payload', () => {
    expect(parseEnvelope(JSON.stringify({ from: 'a', to: 'b', room: 'r', seq: 1, ts: 1 }))).toBeNull();
  });

  test('validateEnvelope returns null for valid', () => {
    expect(validateEnvelope(validEnv)).toBeNull();
  });

  test('validateEnvelope rejects empty from', () => {
    expect(validateEnvelope({ ...validEnv, from: '' })).toContain('from');
  });

  test('validateEnvelope rejects empty to', () => {
    expect(validateEnvelope({ ...validEnv, to: '' })).toContain('to');
  });

  test('validateEnvelope rejects oversized payload', () => {
    const big = { ...validEnv, payload: 'x'.repeat(1024 * 1024 + 1) };
    expect(validateEnvelope(big)).toContain('large');
  });

  test('getRoutingTarget host', () => {
    expect(getRoutingTarget({ ...validEnv, to: 'host' })).toEqual({ type: 'host' });
  });

  test('getRoutingTarget broadcast', () => {
    expect(getRoutingTarget({ ...validEnv, to: 'broadcast' })).toEqual({ type: 'broadcast' });
  });

  test('getRoutingTarget specific device', () => {
    const result = getRoutingTarget({ ...validEnv, to: 'device123' });
    expect(result.type).toBe('device');
    expect(result.deviceId).toBe('device123');
  });
});
