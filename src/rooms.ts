/**
 * Room state management.
 * Each room has one host and zero or more guests.
 */

export interface RoomConnection {
  deviceId: string;
  deviceName: string;
  isHost: boolean;
  connectedAt: number;
}

export interface Room {
  id: string;
  hostDeviceId: string;
  connections: Map<string, RoomConnection>;
  createdAt: number;
}

export class RoomManager {
  private rooms: Map<string, Room> = new Map();
  private maxRooms: number;
  private maxClientsPerRoom: number;

  constructor(maxRooms: number = 1000, maxClientsPerRoom: number = 10) {
    this.maxRooms = maxRooms;
    this.maxClientsPerRoom = maxClientsPerRoom;
  }

  /** Create or get a room, adding a connection. */
  joinRoom(roomId: string, deviceId: string, deviceName: string, isHost: boolean): { success: boolean; error?: string } {
    let room = this.rooms.get(roomId);

    if (!room) {
      if (this.rooms.size >= this.maxRooms) {
        return { success: false, error: 'Max rooms reached' };
      }
      room = {
        id: roomId,
        hostDeviceId: isHost ? deviceId : '',
        connections: new Map(),
        createdAt: Date.now(),
      };
      this.rooms.set(roomId, room);
    }

    if (room.connections.size >= this.maxClientsPerRoom) {
      return { success: false, error: 'Room full' };
    }

    if (isHost && room.hostDeviceId && room.hostDeviceId !== deviceId) {
      return { success: false, error: 'Room already has a host' };
    }

    if (isHost) {
      room.hostDeviceId = deviceId;
    }

    room.connections.set(deviceId, {
      deviceId,
      deviceName,
      isHost,
      connectedAt: Date.now(),
    });

    return { success: true };
  }

  /** Remove a connection from a room. */
  leaveRoom(roomId: string, deviceId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;

    room.connections.delete(deviceId);

    if (room.hostDeviceId === deviceId) {
      room.hostDeviceId = '';
    }

    // Destroy room if empty
    if (room.connections.size === 0) {
      this.rooms.delete(roomId);
    }
  }

  /** Get the host device ID for a room. */
  getHostDeviceId(roomId: string): string | null {
    const room = this.rooms.get(roomId);
    if (!room || !room.hostDeviceId) return null;
    return room.hostDeviceId;
  }

  /** Get all device IDs in a room except the sender. */
  getOtherDevices(roomId: string, excludeDeviceId: string): string[] {
    const room = this.rooms.get(roomId);
    if (!room) return [];
    const result: string[] = [];
    room.connections.forEach((conn) => {
      if (conn.deviceId !== excludeDeviceId) {
        result.push(conn.deviceId);
      }
    });
    return result;
  }

  /** Check if a device is in a room. */
  isInRoom(roomId: string, deviceId: string): boolean {
    const room = this.rooms.get(roomId);
    if (!room) return false;
    return room.connections.has(deviceId);
  }

  /** Get room stats. */
  getRoomCount(): number {
    return this.rooms.size;
  }

  /** Get connection count for a room. */
  getConnectionCount(roomId: string): number {
    const room = this.rooms.get(roomId);
    return room ? room.connections.size : 0;
  }

  /** Get all room IDs. */
  getRoomIds(): string[] {
    return Array.from(this.rooms.keys());
  }

  /** Get a room. */
  getRoom(roomId: string): Room | null {
    return this.rooms.get(roomId) ?? null;
  }

  /** Destroy a room. */
  destroyRoom(roomId: string): void {
    this.rooms.delete(roomId);
  }
}
