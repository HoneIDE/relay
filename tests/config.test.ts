import { describe, test, expect } from 'bun:test';
import { parseConfigFile, buildConfig, getDefaults } from '../src/config';

describe('Config', () => {
  test('parseConfigFile parses key=value', () => {
    const content = 'host=localhost\nport=9000\n';
    const result = parseConfigFile(content);
    expect(result['host']).toBe('localhost');
    expect(result['port']).toBe('9000');
  });

  test('parseConfigFile skips comments', () => {
    const content = '# comment\nhost=localhost\n';
    const result = parseConfigFile(content);
    expect(result['host']).toBe('localhost');
    expect(Object.keys(result).length).toBe(1);
  });

  test('parseConfigFile skips empty lines', () => {
    const content = '\nhost=localhost\n\nport=9000\n';
    const result = parseConfigFile(content);
    expect(Object.keys(result).length).toBe(2);
  });

  test('parseConfigFile handles spaces around equals', () => {
    const content = 'host = localhost\n';
    const result = parseConfigFile(content);
    expect(result['host']).toBe('localhost');
  });

  test('buildConfig uses defaults when no values', () => {
    const config = buildConfig();
    const defaults = getDefaults();
    expect(config.host).toBe(defaults.host);
    expect(config.port).toBe(defaults.port);
  });

  test('buildConfig uses file values', () => {
    const config = buildConfig({ 'host': 'myhost', 'port': '9000' });
    expect(config.host).toBe('myhost');
    expect(config.port).toBe(9000);
  });

  test('buildConfig env overrides file values', () => {
    const config = buildConfig(
      { 'host': 'filehost', 'port': '8000' },
      { 'HONE_RELAY_HOST': 'envhost', 'HONE_RELAY_PORT': '9999' }
    );
    expect(config.host).toBe('envhost');
    expect(config.port).toBe(9999);
  });

  test('buildConfig handles sqlite.path', () => {
    const config = buildConfig({ 'sqlite.path': '/data/relay.db' });
    expect(config.sqlitePath).toBe('/data/relay.db');
  });
});
