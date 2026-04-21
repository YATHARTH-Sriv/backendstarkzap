import type { Pool } from "pg";
import { MSG, type ChatMessage } from "../types.ts";

export type ChatRoomVisibility = "public" | "private";
export type ChatRoomJoinPolicy = "open" | "approval" | "invite_only";
export type ChatRoomRole = "owner" | "admin" | "member";
export type ChatRoomMembershipStatus =
  | "active"
  | "pending"
  | "invited"
  | "removed"
  | "banned";

export type ChatRoomRecord = {
  roomName: string;
  visibility: ChatRoomVisibility;
  joinPolicy: ChatRoomJoinPolicy;
  createdByPrivyUserId: string | null;
  createdAt: string;
};

export type ChatRoomMembershipRecord = {
  roomName: string;
  privyUserId: string;
  role: ChatRoomRole;
  status: ChatRoomMembershipStatus;
  createdByPrivyUserId: string | null;
  createdAt: string;
  updatedAt: string;
  username: string | null;
};

export type ChatRoomListEntry = {
  roomName: string;
  createdAt: string;
  memberCount: number;
  visibility: ChatRoomVisibility;
  joinPolicy: ChatRoomJoinPolicy;
  myMembershipStatus: ChatRoomMembershipStatus | null;
  myRole: ChatRoomRole | null;
  isMember: boolean;
};

export type JoinRoomResult = {
  status: "active" | "pending" | "denied";
  message: string;
};

export type RoomInviteResult = {
  status: "invited" | "already_member" | "banned" | "not_found" | "invalid";
  message: string;
  targetPrivyUserId: string | null;
  targetUsername: string | null;
};

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
  createRoom(input: {
    roomName: string;
    visibility: ChatRoomVisibility;
    joinPolicy: ChatRoomJoinPolicy;
    createdByPrivyUserId: string;
  }): Promise<ChatRoomRecord>;
  getRoomByName(roomName: string): Promise<ChatRoomRecord | null>;
  getRoomMembership(
    roomName: string,
    privyUserId: string,
  ): Promise<ChatRoomMembershipRecord | null>;
  hasActiveRoomMembership(
    roomName: string,
    privyUserId: string,
  ): Promise<boolean>;
  isRoomAdmin(roomName: string, privyUserId: string): Promise<boolean>;
  resolveJoinForUser(input: {
    roomName: string;
    privyUserId: string;
    username: string;
  }): Promise<JoinRoomResult>;
  listVisibleRoomsForUser(
    privyUserId: string,
    limit?: number,
  ): Promise<ChatRoomListEntry[]>;
  listActiveRoomMembers(roomName: string): Promise<ChatRoomMembershipRecord[]>;
  listPendingRoomRequests(
    roomName: string,
  ): Promise<ChatRoomMembershipRecord[]>;
  inviteUserByUsername(
    roomName: string,
    inviterPrivyUserId: string,
    targetUsername: string,
  ): Promise<RoomInviteResult>;
  approvePendingRoomRequest(
    roomName: string,
    targetPrivyUserId: string,
  ): Promise<boolean>;
  rejectPendingRoomRequest(
    roomName: string,
    targetPrivyUserId: string,
  ): Promise<boolean>;
  saveRoomMessage(message: ChatMessage): Promise<void>;
  savePrivateMessage(message: PrivateMessageRecord): Promise<void>;
  loadRecentRoomMessages(
    roomName: string,
    limit?: number,
  ): Promise<ChatMessage[]>;
  loadRecentPrivateMessages(
    usernameA: string,
    usernameB: string,
    limit?: number,
  ): Promise<PrivateMessageRecord[]>;
}

export function createChatRepository(db: Pool): ChatRepository {
  function normalizeLimit(
    limit: number,
    fallback: number,
    max: number,
  ): number {
    if (!Number.isFinite(limit) || limit <= 0) {
      return fallback;
    }

    return Math.min(Math.trunc(limit), max);
  }

  function mapRoomRow(row: {
    room_name: string;
    visibility: ChatRoomVisibility;
    join_policy: ChatRoomJoinPolicy;
    created_by_privy_user_id: string | null;
    created_at: Date;
  }): ChatRoomRecord {
    return {
      roomName: row.room_name,
      visibility: row.visibility,
      joinPolicy: row.join_policy,
      createdByPrivyUserId: row.created_by_privy_user_id,
      createdAt: row.created_at.toISOString(),
    };
  }

  function mapMembershipRow(row: {
    room_name: string;
    privy_user_id: string;
    role: ChatRoomRole;
    status: ChatRoomMembershipStatus;
    created_by_privy_user_id: string | null;
    created_at: Date;
    updated_at: Date;
    username: string | null;
  }): ChatRoomMembershipRecord {
    return {
      roomName: row.room_name,
      privyUserId: row.privy_user_id,
      role: row.role,
      status: row.status,
      createdByPrivyUserId: row.created_by_privy_user_id,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      username: row.username,
    };
  }

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
        INSERT INTO chat_rooms (room_name, visibility, join_policy)
        VALUES ($1, 'public', 'open')
        ON CONFLICT (room_name) DO NOTHING
      `,
      [roomName],
    );
  }

  async function createRoom(input: {
    roomName: string;
    visibility: ChatRoomVisibility;
    joinPolicy: ChatRoomJoinPolicy;
    createdByPrivyUserId: string;
  }) {
    const createdRoomResult = await db.query<{
      room_name: string;
      visibility: ChatRoomVisibility;
      join_policy: ChatRoomJoinPolicy;
      created_by_privy_user_id: string | null;
      created_at: Date;
    }>(
      `
        INSERT INTO chat_rooms (
          room_name,
          visibility,
          join_policy,
          created_by_privy_user_id
        )
        VALUES ($1, $2, $3, $4)
        RETURNING
          room_name,
          visibility,
          join_policy,
          created_by_privy_user_id,
          created_at
      `,
      [
        input.roomName,
        input.visibility,
        input.joinPolicy,
        input.createdByPrivyUserId,
      ],
    );

    await db.query(
      `
        INSERT INTO chat_room_memberships (
          room_name,
          privy_user_id,
          role,
          status,
          created_by_privy_user_id,
          updated_at
        )
        VALUES ($1, $2, 'owner', 'active', $2, NOW())
        ON CONFLICT (room_name, privy_user_id)
        DO UPDATE SET
          role = 'owner',
          status = 'active',
          updated_at = NOW(),
          created_by_privy_user_id = EXCLUDED.created_by_privy_user_id
      `,
      [input.roomName, input.createdByPrivyUserId],
    );

    return mapRoomRow(createdRoomResult.rows[0]);
  }

  async function getRoomByName(
    roomName: string,
  ): Promise<ChatRoomRecord | null> {
    const result = await db.query<{
      room_name: string;
      visibility: ChatRoomVisibility;
      join_policy: ChatRoomJoinPolicy;
      created_by_privy_user_id: string | null;
      created_at: Date;
    }>(
      `
        SELECT
          room_name,
          visibility,
          join_policy,
          created_by_privy_user_id,
          created_at
        FROM chat_rooms
        WHERE room_name = $1
        LIMIT 1
      `,
      [roomName],
    );

    if (result.rowCount === 0) {
      return null;
    }

    return mapRoomRow(result.rows[0]);
  }

  async function getRoomMembership(roomName: string, privyUserId: string) {
    const result = await db.query<{
      room_name: string;
      privy_user_id: string;
      role: ChatRoomRole;
      status: ChatRoomMembershipStatus;
      created_by_privy_user_id: string | null;
      created_at: Date;
      updated_at: Date;
      username: string | null;
    }>(
      `
        SELECT
          m.room_name,
          m.privy_user_id,
          m.role,
          m.status,
          m.created_by_privy_user_id,
          m.created_at,
          m.updated_at,
          u.username
        FROM chat_room_memberships m
        LEFT JOIN app_users u ON u.privy_user_id = m.privy_user_id
        WHERE m.room_name = $1 AND m.privy_user_id = $2
        LIMIT 1
      `,
      [roomName, privyUserId],
    );

    if (result.rowCount === 0) {
      return null;
    }

    return mapMembershipRow(result.rows[0]);
  }

  async function hasActiveRoomMembership(
    roomName: string,
    privyUserId: string,
  ) {
    const membership = await getRoomMembership(roomName, privyUserId);
    return membership?.status === "active";
  }

  async function isRoomAdmin(roomName: string, privyUserId: string) {
    const membership = await getRoomMembership(roomName, privyUserId);
    if (!membership || membership.status !== "active") {
      return false;
    }

    return membership.role === "owner" || membership.role === "admin";
  }

  async function upsertMembership(input: {
    roomName: string;
    privyUserId: string;
    role: ChatRoomRole;
    status: ChatRoomMembershipStatus;
    createdByPrivyUserId: string | null;
  }) {
    await db.query(
      `
        INSERT INTO chat_room_memberships (
          room_name,
          privy_user_id,
          role,
          status,
          created_by_privy_user_id,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, NOW())
        ON CONFLICT (room_name, privy_user_id)
        DO UPDATE SET
          role = CASE
            WHEN chat_room_memberships.role IN ('owner', 'admin')
              AND EXCLUDED.role = 'member'
              THEN chat_room_memberships.role
            ELSE EXCLUDED.role
          END,
          status = EXCLUDED.status,
          created_by_privy_user_id = EXCLUDED.created_by_privy_user_id,
          updated_at = NOW()
      `,
      [
        input.roomName,
        input.privyUserId,
        input.role,
        input.status,
        input.createdByPrivyUserId,
      ],
    );
  }

  async function resolveJoinForUser(input: {
    roomName: string;
    privyUserId: string;
    username: string;
  }): Promise<JoinRoomResult> {
    const room = await getRoomByName(input.roomName);

    if (!room) {
      return {
        status: "denied",
        message: "Room does not exist",
      };
    }

    const membership = await getRoomMembership(
      input.roomName,
      input.privyUserId,
    );

    if (membership?.status === "active") {
      return {
        status: "active",
        message: "Already a room member",
      };
    }

    if (membership?.status === "pending") {
      return {
        status: "pending",
        message: "Join request pending admin approval",
      };
    }

    if (membership?.status === "invited") {
      await upsertChatProfile(input.username);
      await upsertMembership({
        roomName: input.roomName,
        privyUserId: input.privyUserId,
        role: membership.role,
        status: "active",
        createdByPrivyUserId: membership.createdByPrivyUserId,
      });

      return {
        status: "active",
        message: "Invitation accepted",
      };
    }

    if (membership?.status === "removed") {
      return {
        status: "denied",
        message: "Access to this room has been removed by an admin",
      };
    }

    if (membership?.status === "banned") {
      return {
        status: "denied",
        message: "You are banned from this room",
      };
    }

    await upsertChatProfile(input.username);

    if (room.joinPolicy === "invite_only") {
      return {
        status: "denied",
        message: "This room is invite-only",
      };
    }

    if (room.joinPolicy === "approval") {
      await upsertMembership({
        roomName: input.roomName,
        privyUserId: input.privyUserId,
        role: "member",
        status: "pending",
        createdByPrivyUserId: null,
      });

      return {
        status: "pending",
        message: "Join request submitted. Waiting for approval",
      };
    }

    await upsertMembership({
      roomName: input.roomName,
      privyUserId: input.privyUserId,
      role: "member",
      status: "active",
      createdByPrivyUserId: null,
    });

    return {
      status: "active",
      message: "Joined room",
    };
  }

  async function listVisibleRoomsForUser(privyUserId: string, limit = 100) {
    const boundedLimit = normalizeLimit(limit, 100, 500);

    const result = await db.query<{
      room_name: string;
      created_at: Date;
      visibility: ChatRoomVisibility;
      join_policy: ChatRoomJoinPolicy;
      member_count: string;
      my_status: ChatRoomMembershipStatus | null;
      my_role: ChatRoomRole | null;
    }>(
      `
        SELECT
          r.room_name,
          r.created_at,
          r.visibility,
          r.join_policy,
          COUNT(active_members.privy_user_id)::text AS member_count,
          my_membership.status AS my_status,
          my_membership.role AS my_role
        FROM chat_rooms r
        LEFT JOIN chat_room_memberships active_members
          ON active_members.room_name = r.room_name
          AND active_members.status = 'active'
        LEFT JOIN chat_room_memberships my_membership
          ON my_membership.room_name = r.room_name
          AND my_membership.privy_user_id = $1
        WHERE
          (
            r.visibility = 'public'
            AND COALESCE(my_membership.status, '') NOT IN ('banned', 'removed')
          )
          OR my_membership.status IN ('active', 'pending', 'invited')
        GROUP BY
          r.room_name,
          r.created_at,
          r.visibility,
          r.join_policy,
          my_membership.status,
          my_membership.role
        ORDER BY r.created_at DESC
        LIMIT $2
      `,
      [privyUserId, boundedLimit],
    );

    return result.rows.map((row) => ({
      roomName: row.room_name,
      createdAt: row.created_at.toISOString(),
      memberCount: Number(row.member_count),
      visibility: row.visibility,
      joinPolicy: row.join_policy,
      myMembershipStatus: row.my_status,
      myRole: row.my_role,
      isMember: row.my_status === "active",
    }));
  }

  async function listActiveRoomMembers(roomName: string) {
    const result = await db.query<{
      room_name: string;
      privy_user_id: string;
      role: ChatRoomRole;
      status: ChatRoomMembershipStatus;
      created_by_privy_user_id: string | null;
      created_at: Date;
      updated_at: Date;
      username: string | null;
    }>(
      `
        SELECT
          m.room_name,
          m.privy_user_id,
          m.role,
          m.status,
          m.created_by_privy_user_id,
          m.created_at,
          m.updated_at,
          u.username
        FROM chat_room_memberships m
        LEFT JOIN app_users u ON u.privy_user_id = m.privy_user_id
        WHERE m.room_name = $1 AND m.status = 'active'
        ORDER BY
          CASE m.role
            WHEN 'owner' THEN 0
            WHEN 'admin' THEN 1
            ELSE 2
          END,
          m.created_at ASC
      `,
      [roomName],
    );

    return result.rows.map(mapMembershipRow);
  }

  async function listPendingRoomRequests(roomName: string) {
    const result = await db.query<{
      room_name: string;
      privy_user_id: string;
      role: ChatRoomRole;
      status: ChatRoomMembershipStatus;
      created_by_privy_user_id: string | null;
      created_at: Date;
      updated_at: Date;
      username: string | null;
    }>(
      `
        SELECT
          m.room_name,
          m.privy_user_id,
          m.role,
          m.status,
          m.created_by_privy_user_id,
          m.created_at,
          m.updated_at,
          u.username
        FROM chat_room_memberships m
        LEFT JOIN app_users u ON u.privy_user_id = m.privy_user_id
        WHERE m.room_name = $1
          AND m.status IN ('pending', 'invited')
        ORDER BY m.updated_at DESC
      `,
      [roomName],
    );

    return result.rows.map(mapMembershipRow);
  }

  async function inviteUserByUsername(
    roomName: string,
    inviterPrivyUserId: string,
    targetUsername: string,
  ): Promise<RoomInviteResult> {
    const targetResult = await db.query<{
      privy_user_id: string;
      username: string | null;
    }>(
      `
        SELECT privy_user_id, username
        FROM app_users
        WHERE username IS NOT NULL
          AND LOWER(username) = LOWER($1)
        LIMIT 1
      `,
      [targetUsername],
    );

    if (targetResult.rowCount === 0) {
      return {
        status: "not_found",
        message: "Target username not found",
        targetPrivyUserId: null,
        targetUsername: null,
      };
    }

    const target = targetResult.rows[0];
    const targetPrivyUserId = target.privy_user_id;
    const normalizedUsername = target.username;

    if (!normalizedUsername || targetPrivyUserId === inviterPrivyUserId) {
      return {
        status: "invalid",
        message: "Invalid invite target",
        targetPrivyUserId,
        targetUsername: normalizedUsername,
      };
    }

    const existing = await getRoomMembership(roomName, targetPrivyUserId);
    if (existing?.status === "active") {
      return {
        status: "already_member",
        message: "User is already a room member",
        targetPrivyUserId,
        targetUsername: normalizedUsername,
      };
    }

    if (existing?.status === "banned") {
      return {
        status: "banned",
        message: "User is banned from this room",
        targetPrivyUserId,
        targetUsername: normalizedUsername,
      };
    }

    await upsertChatProfile(normalizedUsername);

    await upsertMembership({
      roomName,
      privyUserId: targetPrivyUserId,
      role: existing?.role ?? "member",
      status: "invited",
      createdByPrivyUserId: inviterPrivyUserId,
    });

    return {
      status: "invited",
      message: "User invited to room",
      targetPrivyUserId,
      targetUsername: normalizedUsername,
    };
  }

  async function approvePendingRoomRequest(
    roomName: string,
    targetPrivyUserId: string,
  ) {
    const result = await db.query(
      `
        UPDATE chat_room_memberships
        SET status = 'active', updated_at = NOW()
        WHERE room_name = $1
          AND privy_user_id = $2
          AND status IN ('pending', 'invited')
      `,
      [roomName, targetPrivyUserId],
    );

    return result.rowCount > 0;
  }

  async function rejectPendingRoomRequest(
    roomName: string,
    targetPrivyUserId: string,
  ) {
    const result = await db.query(
      `
        UPDATE chat_room_memberships
        SET status = 'removed', updated_at = NOW()
        WHERE room_name = $1
          AND privy_user_id = $2
          AND status IN ('pending', 'invited')
      `,
      [roomName, targetPrivyUserId],
    );

    return result.rowCount > 0;
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

  async function loadRecentRoomMessages(
    roomName: string,
    limit = 50,
  ): Promise<ChatMessage[]> {
    const boundedLimit = normalizeLimit(limit, 50, 200);

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
      [roomName, boundedLimit],
    );

    return result.rows.reverse().map((row) => ({
      id: row.id,
      type: MSG.MESSAGE_RECEIVED,
      room: row.room_name,
      userId: row.user_id,
      username: row.username,
      content: row.content,
      timestamp: new Date(row.created_at).toISOString(),
    }));
  }

  async function loadRecentPrivateMessages(
    usernameA: string,
    usernameB: string,
    limit = 50,
  ) {
    const boundedLimit = normalizeLimit(limit, 50, 200);

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
      [usernameA, usernameB, boundedLimit],
    );

    return result.rows.reverse().map((row) => ({
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
    createRoom,
    getRoomByName,
    getRoomMembership,
    hasActiveRoomMembership,
    isRoomAdmin,
    resolveJoinForUser,
    listVisibleRoomsForUser,
    listActiveRoomMembers,
    listPendingRoomRequests,
    inviteUserByUsername,
    approvePendingRoomRequest,
    rejectPendingRoomRequest,
    saveRoomMessage,
    savePrivateMessage,
    loadRecentRoomMessages,
    loadRecentPrivateMessages,
  };
}
