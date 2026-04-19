import type { Pool } from "pg";
import { MSG, type ChatMessage } from "../types.ts";

export interface PrivateMessageRecord {
  id: string;
  fromId: string;
  fromUsername: string;
  toId: string;
  toUsername: string;
  content: string;
  timestamp: string;
}

export interface ChatRepository {
  upsertChatProfile(username: string): Promise<void>;
  ensureChatRoom(roomName: string): Promise<void>;
  upsertRoomMember(roomName: string, username: string): Promise<void>;
  removeRoomMember(roomName: string, username: string): Promise<void>;
  saveRoomMessage(message: ChatMessage): Promise<void>;
  savePrivateMessage(message: PrivateMessageRecord): Promise<void>;
  loadRecentRoomMessages(roomName: string, limit?: number): Promise<ChatMessage[]>;
  listRooms(limit?: number): Promise<Array<{ roomName: string; createdAt: string; memberCount: number }>>;
  loadRecentPrivateMessages(
    usernameA: string,
    usernameB: string,
    limit?: number,
  ): Promise<PrivateMessageRecord[]>;
}

export function createChatRepository(db: Pool): ChatRepository {
  async function upsertChatProfile(username: string) {
    await db.query(
      `
        INSERT INTO chat_profiles (username, updated_at)
        VALUES ($1, NOW())
        ON CONFLICT (username)
        DO UPDATE SET updated_at = NOW()
      `,
      [username],
    );
  }

  async function ensureChatRoom(roomName: string) {
    await db.query(
      `
        INSERT INTO chat_rooms (room_name)
        VALUES ($1)
        ON CONFLICT (room_name) DO NOTHING
      `,
      [roomName],
    );
  }

  async function upsertRoomMember(roomName: string, username: string) {
    await ensureChatRoom(roomName);
    await upsertChatProfile(username);

    await db.query(
      `
        INSERT INTO chat_room_members (room_name, username)
        VALUES ($1, $2)
        ON CONFLICT (room_name, username)
        DO UPDATE SET joined_at = NOW()
      `,
      [roomName, username],
    );
  }

  async function removeRoomMember(roomName: string, username: string) {
    await db.query(
      `
        DELETE FROM chat_room_members
        WHERE room_name = $1 AND username = $2
      `,
      [roomName, username],
    );
  }

  async function saveRoomMessage(message: ChatMessage) {
    await db.query(
      `
        INSERT INTO chat_messages (id, room_name, user_id, username, content, created_at)
        VALUES ($1, $2, $3, $4, $5, $6::timestamptz)
      `,
      [
        message.id,
        message.room,
        message.userId,
        message.username,
        message.content,
        message.timestamp,
      ],
    );
  }

  async function savePrivateMessage(message: PrivateMessageRecord) {
    await db.query(
      `
        INSERT INTO chat_private_messages (
          id,
          from_user_id,
          from_username,
          to_user_id,
          to_username,
          content,
          created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz)
      `,
      [
        message.id,
        message.fromId,
        message.fromUsername,
        message.toId,
        message.toUsername,
        message.content,
        message.timestamp,
      ],
    );
  }

  async function loadRecentRoomMessages(roomName: string, limit = 50): Promise<ChatMessage[]> {
    const result = await db.query<{
      id: string;
      room_name: string;
      user_id: string;
      username: string;
      content: string;
      created_at: Date;
    }>(
      `
        SELECT id, room_name, user_id, username, content, created_at
        FROM chat_messages
        WHERE room_name = $1
        ORDER BY created_at DESC
        LIMIT $2
      `,
      [roomName, limit],
    );

    return result.rows
      .reverse()
      .map((row) => ({
        id: row.id,
        type: MSG.MESSAGE_RECEIVED,
        room: row.room_name,
        userId: row.user_id,
        username: row.username,
        content: row.content,
        timestamp: new Date(row.created_at).toISOString(),
      }));
  }

  async function listRooms(limit = 100) {
    const result = await db.query<{
      room_name: string;
      created_at: Date;
      member_count: string;
    }>(
      `
        SELECT
          r.room_name,
          r.created_at,
          COUNT(m.username)::text AS member_count
        FROM chat_rooms r
        LEFT JOIN chat_room_members m ON m.room_name = r.room_name
        GROUP BY r.room_name, r.created_at
        ORDER BY r.created_at DESC
        LIMIT $1
      `,
      [limit],
    );

    return result.rows.map((row) => ({
      roomName: row.room_name,
      createdAt: row.created_at.toISOString(),
      memberCount: Number(row.member_count),
    }));
  }

  async function loadRecentPrivateMessages(usernameA: string, usernameB: string, limit = 50) {
    const result = await db.query<{
      id: string;
      from_user_id: string;
      from_username: string;
      to_user_id: string;
      to_username: string;
      content: string;
      created_at: Date;
    }>(
      `
        SELECT
          id,
          from_user_id,
          from_username,
          to_user_id,
          to_username,
          content,
          created_at
        FROM chat_private_messages
        WHERE
          (from_username = $1 AND to_username = $2)
          OR
          (from_username = $2 AND to_username = $1)
        ORDER BY created_at DESC
        LIMIT $3
      `,
      [usernameA, usernameB, limit],
    );

    return result.rows
      .reverse()
      .map((row) => ({
        id: row.id,
        fromId: row.from_user_id,
        fromUsername: row.from_username,
        toId: row.to_user_id,
        toUsername: row.to_username,
        content: row.content,
        timestamp: row.created_at.toISOString(),
      }));
  }

  return {
    upsertChatProfile,
    ensureChatRoom,
    upsertRoomMember,
    removeRoomMember,
    saveRoomMessage,
    savePrivateMessage,
    loadRecentRoomMessages,
    listRooms,
    loadRecentPrivateMessages,
  };
}
