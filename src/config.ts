/**
 * Relay server configuration.
 * Flat key=value file format + environment variable overrides.
 */

export interface RelayConfig {
  host: string;
  port: number;
  sqlitePath: string;
  maxRooms: number;
  maxClientsPerRoom: number;
  bufferTtlSeconds: number;
}

const DEFAULTS: RelayConfig = {
  host: '0.0.0.0',
  port: 8443,
  sqlitePath: './relay.db',
  maxRooms: 1000,
  maxClientsPerRoom: 10,
  bufferTtlSeconds: 300,
};

/**
 * Parse a flat key=value config string.
 */
export function parseConfigFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.length === 0 || line[0] === '#') continue;
    const eqIdx = line.indexOf('=');
    if (eqIdx < 0) continue;
    const key = line.slice(0, eqIdx).trim();
    const value = line.slice(eqIdx + 1).trim();
    result[key] = value;
  }
  return result;
}

/**
 * Build config from file values + environment overrides.
 */
export function buildConfig(fileValues?: Record<string, string>, env?: Record<string, string | undefined>): RelayConfig {
  const fv = fileValues ?? {};
  const e = env ?? {};

  return {
    host: e['HONE_RELAY_HOST'] ?? fv['host'] ?? DEFAULTS.host,
    port: parseInt(e['HONE_RELAY_PORT'] ?? fv['port'] ?? String(DEFAULTS.port), 10),
    sqlitePath: e['HONE_RELAY_SQLITE_PATH'] ?? fv['sqlite.path'] ?? DEFAULTS.sqlitePath,
    maxRooms: parseInt(e['HONE_RELAY_MAX_ROOMS'] ?? fv['max.rooms'] ?? String(DEFAULTS.maxRooms), 10),
    maxClientsPerRoom: parseInt(e['HONE_RELAY_MAX_CLIENTS_PER_ROOM'] ?? fv['max.clients.per.room'] ?? String(DEFAULTS.maxClientsPerRoom), 10),
    bufferTtlSeconds: parseInt(e['HONE_RELAY_BUFFER_TTL'] ?? fv['buffer.ttl.seconds'] ?? String(DEFAULTS.bufferTtlSeconds), 10),
  };
}

export function getDefaults(): RelayConfig {
  return { ...DEFAULTS };
}
