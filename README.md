# Hone Relay

WebSocket relay server for [Hone](https://hone.dev) cross-device sync. Routes messages between devices in shared rooms with offline buffering and persistent delta storage.

## How It Works

```
Device A ──WebSocket──► Relay ◄──WebSocket── Device B
               │
               ├─ authenticate (token-based)
               ├─ join room
               ├─ route messages (unicast / broadcast / host)
               ├─ buffer for offline devices
               └─ persist deltas (SQLite)
```

1. Devices connect via WebSocket and authenticate with a signed token
2. Devices join a shared room (identified by room ID)
3. Messages are routed between devices in the same room
4. If a device is offline, messages are buffered and delivered on reconnect
5. Deltas are persisted to SQLite for durable sync state

## Building

Requires [Bun](https://bun.sh):

```sh
bun install
```

## Running

```sh
# With environment variables
HONE_AUTH_SECRET=your-secret-here bun run src/app.ts

# Or with a config file
cp relay.conf.example relay.conf
# Edit relay.conf with your settings
bun run src/app.ts
```

## Configuration

Configuration is read from `relay.conf` (key=value format), with environment variable overrides taking precedence.

| Env Variable | Config Key | Default | Description |
|---|---|---|---|
| `HONE_RELAY_HOST` | `host` | `0.0.0.0` | Bind address |
| `HONE_RELAY_PORT` | `port` | `8443` | HTTP server port (WS = port + 1) |
| `HONE_AUTH_SECRET` | `auth.secret` | *(empty)* | Token signing secret |
| `HONE_RELAY_SQLITE_PATH` | `sqlite.path` | `./relay.db` | SQLite database path |
| `HONE_RELAY_MAX_ROOMS` | `max.rooms` | `1000` | Maximum concurrent rooms |
| `HONE_RELAY_MAX_CLIENTS_PER_ROOM` | `max.clients.per.room` | `10` | Max devices per room |
| `HONE_RELAY_BUFFER_TTL` | `buffer.ttl.seconds` | `300` | Offline message buffer TTL |

## Docker

```sh
docker build -t hone-relay .
docker run -p 8443:8443 -e HONE_AUTH_SECRET=your-secret hone-relay
```

## Testing

```sh
bun test
```

## Architecture

- **`src/app.ts`** — Server entry point, WebSocket message routing
- **`src/auth.ts`** — Token-based device authentication
- **`src/ws-hub.ts`** — WebSocket connection management
- **`src/rooms.ts`** — Room membership and lifecycle
- **`src/buffer.ts`** — Offline message buffering
- **`src/delta-store.ts`** — SQLite-backed persistent delta storage
- **`src/config.ts`** — Configuration parsing (file + env vars)
- **`src/rate-limit.ts`** — Per-IP rate limiting

## License

MIT
