import { describe, test, expect, beforeEach } from 'bun:test';
import { MessageBuffer } from '../src/buffer';

describe('MessageBuffer', () => {
  let buffer: MessageBuffer;

  beforeEach(() => {
    buffer = new MessageBuffer(60);
  });

  test('store and drain messages', () => {
    buffer.store('room1', 'dev1', 'msg1');
    buffer.store('room1', 'dev1', 'msg2');
    buffer.store('room1', 'dev2', 'msg3');

    const drained = buffer.drain('room1', 'dev1');
    expect(drained.length).toBe(2);
    expect(drained[0].payload).toBe('msg1');
    expect(drained[1].payload).toBe('msg2');
  });

  test('drain marks as delivered', () => {
    buffer.store('room1', 'dev1', 'msg1');
    buffer.drain('room1', 'dev1');

    // Second drain gets nothing
    const again = buffer.drain('room1', 'dev1');
    expect(again.length).toBe(0);
  });

  test('drain only gets messages for target device', () => {
    buffer.store('room1', 'dev1', 'for-dev1');
    buffer.store('room1', 'dev2', 'for-dev2');

    const drained = buffer.drain('room1', 'dev1');
    expect(drained.length).toBe(1);
    expect(drained[0].payload).toBe('for-dev1');
  });

  test('purge removes delivered messages', () => {
    buffer.store('room1', 'dev1', 'msg1');
    buffer.drain('room1', 'dev1');

    const purged = buffer.purge();
    expect(purged).toBe(1);
    expect(buffer.getTotalCount()).toBe(0);
  });

  test('purge removes expired messages', () => {
    const shortBuffer = new MessageBuffer(0); // 0 second TTL
    shortBuffer.store('room1', 'dev1', 'msg1');

    const start = Date.now();
    while (Date.now() - start < 5) {}

    const purged = shortBuffer.purge();
    expect(purged).toBe(1);
  });

  test('getPendingCount excludes delivered', () => {
    buffer.store('room1', 'dev1', 'msg1');
    buffer.store('room1', 'dev1', 'msg2');
    expect(buffer.getPendingCount()).toBe(2);

    buffer.drain('room1', 'dev1');
    expect(buffer.getPendingCount()).toBe(0);
  });

  test('getTotalCount includes all', () => {
    buffer.store('room1', 'dev1', 'msg1');
    buffer.store('room1', 'dev2', 'msg2');
    expect(buffer.getTotalCount()).toBe(2);
  });

  test('store returns unique IDs', () => {
    const id1 = buffer.store('room1', 'dev1', 'msg1');
    const id2 = buffer.store('room1', 'dev1', 'msg2');
    expect(id1).not.toBe(id2);
  });
});
