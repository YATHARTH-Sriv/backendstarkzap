import type { IncomingMessage, Server as HttpServer } from "node:http";
import { PrivyClient } from "@privy-io/node";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import { v4 as uuidv4 } from "uuid";
import type { ChatRepository } from "../db/chat-repo.ts";
import type { UserProfileRepository } from "../db/user-profile-repo.ts";
import { MSG, type ChatMessage, type ClientRecord, type IncomingClientMessage, type RoomUsersMessage, type ServerMessage } from "../types.ts";

function extractBearerToken(authorizationHeader: string | undefined): string | null {
  if (!authorizationHeader) {
    return null;
  }

  const [scheme, token] = authorizationHeader.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) {
    return null;
  }

  return token;
}

function extractWsToken(req: IncomingMessage): string | null {
  const fromHeader = extractBearerToken(req.headers.authorization);
  if (fromHeader) {
    return fromHeader;
  }

  try {
    const parsed = new URL(req.url ?? "/", "http://localhost");
    const fromQuery = parsed.searchParams.get("token");
    return fromQuery && fromQuery.trim().length > 0 ? fromQuery.trim() : null;
  } catch {
    return null;
  }
}

function normalizeRoomName(raw: string | undefined): string {
  if (typeof raw !== "string") {
    return "";
  }

  return raw
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[^\x20-\x7E]/g, "")
    .slice(0, 40);
}

export function attachChatServer(
  server: HttpServer,
  params: {
    chatRepo: ChatRepository;
    userProfileRepo: UserProfileRepository;
    privy: PrivyClient;
  },
) {
  const { chatRepo, userProfileRepo, privy } = params;
  const wss = new WebSocketServer({ server });
  const clients = new Map<WebSocket, ClientRecord>();
  const rooms = new Map<string, Set<WebSocket>>();

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    void handleConnection(ws, req);
  });

  async function handleConnection(ws: WebSocket, req: IncomingMessage): Promise<void> {
    const clientId = uuidv4();
    const token = extractWsToken(req);

    if (!token) {
      sendError(ws, "Missing websocket auth token");
      ws.close(1008, "auth required");
      return;
    }

    try {
      const claims = await privy.utils().auth().verifyAccessToken(token);
      if (!claims.user_id) {
        sendError(ws, "Invalid websocket auth token");
        ws.close(1008, "invalid auth");
        return;
      }

      await userProfileRepo.ensureUser(claims.user_id);
      const profile = await userProfileRepo.getByPrivyUserId(claims.user_id);

      clients.set(ws, {
        id: clientId,
        privyUserId: claims.user_id,
        username: profile?.username ?? null,
        currentRoom: null,
        isTyping: false,
      });

      sendJson(ws, {
        type: "connection",
        clientId,
      });

      if (profile?.username) {
        sendJson(ws, { type: MSG.USERNAME_SET, username: profile.username });
      }

      ws.on("message", (data: RawData) => {
        void handleMessage(ws, data);
      });

      ws.on("close", () => {
        void handleDisconnect(ws);
      });

      ws.on("error", console.error);
    } catch {
      sendError(ws, "Failed to authenticate websocket");
      ws.close(1008, "auth failed");
    }
  }

  async function syncClientUsername(client: ClientRecord): Promise<string | null> {
    const profile = await userProfileRepo.getByPrivyUserId(client.privyUserId);
    client.username = profile?.username ?? null;
    return client.username;
  }

  async function handleMessage(ws: WebSocket, data: RawData): Promise<void> {
    let msg: IncomingClientMessage;

    try {
      msg = JSON.parse(data.toString()) as IncomingClientMessage;
    } catch {
      sendError(ws, "Invalid JSON");
      return;
    }

    const client = clients.get(ws);
    if (!client) {
      return;
    }

    switch (msg.type) {
      case MSG.SET_USERNAME:
        await syncClientUsername(client);
        if (client.username) {
          sendJson(ws, { type: MSG.USERNAME_SET, username: client.username });
          sendError(ws, "Username is managed by onboarding profile");
        } else {
          sendError(ws, "Set username in onboarding before chatting");
        }
        break;
      case MSG.JOIN_ROOM:
        await joinRoom(ws, client, msg.room);
        break;
      case MSG.LEAVE_ROOM:
        await leaveRoom(ws, client);
        break;
      case MSG.CHAT_MESSAGE:
        await chatMessage(ws, client, msg.content);
        break;
      case MSG.PRIVATE_MESSAGE:
        await privateMessage(ws, client, msg.targetId, msg.content);
        break;
      case MSG.TYPING_START:
        setTyping(ws, client, true);
        break;
      case MSG.TYPING_STOP:
        setTyping(ws, client, false);
        break;
      default:
        sendError(ws, "Unknown message type");
    }
  }

  function sendJson(
    ws: WebSocket,
    message: ServerMessage | RoomUsersMessage | { type: "connection"; clientId: string },
  ): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  function sendError(ws: WebSocket, message: string): void {
    sendJson(ws, { type: MSG.ERROR, message });
  }

  async function joinRoom(ws: WebSocket, client: ClientRecord, roomName?: string): Promise<void> {
    const resolvedUsername = await syncClientUsername(client);

    if (!resolvedUsername) {
      sendError(ws, "Set username in onboarding before joining rooms");
      return;
    }

    const normalizedRoomName = normalizeRoomName(roomName);

    if (!normalizedRoomName) {
      sendError(ws, "Room name required");
      return;
    }

    await chatRepo.ensureChatRoom(normalizedRoomName);

    if (client.currentRoom === normalizedRoomName) {
      const recentMessages = await chatRepo.loadRecentRoomMessages(normalizedRoomName, 50);

      sendJson(ws, { type: MSG.ROOM_JOINED, room: normalizedRoomName });
      sendJson(ws, {
        type: MSG.MESSAGE_HISTORY,
        messages: recentMessages,
      });
      sendJson(ws, { type: MSG.ROOM_USERS, users: getUsersInRoom(normalizedRoomName) });
      return;
    }

    if (client.currentRoom) {
      await leaveRoom(ws, client);
    }

    if (!rooms.has(normalizedRoomName)) {
      rooms.set(normalizedRoomName, new Set<WebSocket>());
    }

    rooms.get(normalizedRoomName)?.add(ws);
    client.currentRoom = normalizedRoomName;
    client.isTyping = false;

    await chatRepo.upsertRoomMember(normalizedRoomName, resolvedUsername);

    const recentMessages = await chatRepo.loadRecentRoomMessages(normalizedRoomName, 50);

    sendJson(ws, { type: MSG.ROOM_JOINED, room: normalizedRoomName });
    sendJson(ws, {
      type: MSG.MESSAGE_HISTORY,
      messages: recentMessages,
    });
    sendJson(ws, { type: MSG.ROOM_USERS, users: getUsersInRoom(normalizedRoomName) });

    broadcastToRoom(
      normalizedRoomName,
      {
        type: MSG.USER_JOINED,
        username: resolvedUsername,
        userId: client.id,
      },
      ws,
    );

    broadcastRoomUsers(normalizedRoomName);
  }

  async function leaveRoom(
    ws: WebSocket,
    client: ClientRecord,
    notifySelf = true,
  ): Promise<void> {
    if (!client.currentRoom) {
      return;
    }

    const roomName = client.currentRoom;
    const room = rooms.get(roomName);

    client.currentRoom = null;
    client.isTyping = false;

    if (client.username) {
      await chatRepo.removeRoomMember(roomName, client.username);
    }

    if (room) {
      room.delete(ws);

      if (room.size === 0) {
        rooms.delete(roomName);
      } else {
        broadcastToRoom(roomName, {
          type: MSG.USER_LEFT,
          username: client.username,
          userId: client.id,
        });
        broadcastRoomUsers(roomName);
      }
    }

    if (notifySelf) {
      sendJson(ws, { type: MSG.ROOM_LEFT, room: roomName });
    }
  }

  async function chatMessage(ws: WebSocket, client: ClientRecord, content?: string): Promise<void> {
    const resolvedUsername = await syncClientUsername(client);

    if (!resolvedUsername) {
      sendError(ws, "Set username in onboarding before messaging");
      return;
    }

    if (!client.currentRoom) {
      sendError(ws, "Join a room first");
      return;
    }

    const normalizedContent = typeof content === "string" ? content.trim().slice(0, 1000) : "";
    if (!normalizedContent) {
      sendError(ws, "Message content required");
      return;
    }

    const message: ChatMessage = {
      id: uuidv4(),
      type: MSG.MESSAGE_RECEIVED,
      room: client.currentRoom,
      userId: client.id,
      username: resolvedUsername,
      content: normalizedContent,
      timestamp: new Date().toISOString(),
    };

    await chatRepo.saveRoomMessage(message);

    client.isTyping = false;
    broadcastToRoom(client.currentRoom, message);
  }

  async function privateMessage(
    ws: WebSocket,
    client: ClientRecord,
    targetId?: string,
    content?: string,
  ): Promise<void> {
    const resolvedUsername = await syncClientUsername(client);

    if (!resolvedUsername) {
      sendError(ws, "Set username in onboarding before messaging");
      return;
    }

    const normalizedContent = typeof content === "string" ? content.trim().slice(0, 1000) : "";
    if (!normalizedContent) {
      sendError(ws, "Message content required");
      return;
    }

    if (!targetId) {
      sendError(ws, "Target user required");
      return;
    }

    let targetWs: WebSocket | undefined;
    let targetClient: ClientRecord | undefined;

    for (const [candidateWs, candidateClient] of clients) {
      if (candidateClient.id === targetId) {
        targetWs = candidateWs;
        targetClient = candidateClient;
        break;
      }
    }

    if (!targetWs || !targetClient || !targetClient.username) {
      sendError(ws, "User not found");
      return;
    }

    if (targetWs.readyState !== WebSocket.OPEN) {
      sendError(ws, "User is offline");
      return;
    }

    await chatRepo.upsertChatProfile(resolvedUsername);
    await chatRepo.upsertChatProfile(targetClient.username);

    const timestamp = new Date().toISOString();

    const message = {
      type: MSG.PRIVATE_MESSAGE,
      fromId: client.id,
      fromUsername: resolvedUsername,
      toId: targetId,
      toUsername: targetClient.username,
      content: normalizedContent,
      timestamp,
    } as const;

    await chatRepo.savePrivateMessage({
      id: uuidv4(),
      fromId: client.id,
      fromUsername: resolvedUsername,
      toId: targetId,
      toUsername: targetClient.username,
      content: normalizedContent,
      timestamp,
    });

    sendJson(targetWs, message);
    sendJson(ws, { ...message, type: "private_message_sent" });
  }

  function setTyping(ws: WebSocket, client: ClientRecord, isTyping: boolean): void {
    if (!client.username || !client.currentRoom) {
      return;
    }

    if (client.isTyping === isTyping) {
      return;
    }

    client.isTyping = isTyping;

    broadcastToRoom(
      client.currentRoom,
      {
        type: MSG.TYPING_INDICATOR,
        userId: client.id,
        username: client.username,
        isTyping,
      },
      ws,
    );
  }

  async function handleDisconnect(ws: WebSocket): Promise<void> {
    const client = clients.get(ws);
    if (client?.currentRoom) {
      await leaveRoom(ws, client, false);
    }

    clients.delete(ws);
  }

  function getUsersInRoom(roomName: string) {
    const room = rooms.get(roomName);
    if (!room) {
      return [];
    }

    return Array.from(room)
      .map((socket) => clients.get(socket))
      .filter((client): client is ClientRecord & { username: string } => Boolean(client?.username))
      .map((client) => ({ id: client.id, username: client.username }));
  }

  function broadcastRoomUsers(roomName: string): void {
    broadcastToRoom(roomName, {
      type: MSG.ROOM_USERS,
      users: getUsersInRoom(roomName),
    });
  }

  function broadcastToRoom(
    roomName: string,
    message: ServerMessage | RoomUsersMessage,
    excludeWs: WebSocket | null = null,
  ): void {
    const room = rooms.get(roomName);
    if (!room) {
      return;
    }

    const serialized = JSON.stringify(message);

    for (const ws of room) {
      if (ws !== excludeWs && ws.readyState === WebSocket.OPEN) {
        ws.send(serialized);
      }
    }
  }

  return wss;
}
