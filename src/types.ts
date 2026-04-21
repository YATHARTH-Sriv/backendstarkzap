export const MSG = {
  SET_USERNAME: "set_username",
  JOIN_ROOM: "join_room",
  LEAVE_ROOM: "leave_room",
  CHAT_MESSAGE: "chat_message",
  PRIVATE_MESSAGE: "private_message",
  TYPING_START: "typing_start",
  TYPING_STOP: "typing_stop",
  USERNAME_SET: "username_set",
  ROOM_JOINED: "room_joined",
  ROOM_LEFT: "room_left",
  USER_JOINED: "user_joined",
  USER_LEFT: "user_left",
  MESSAGE_RECEIVED: "message_received",
  TYPING_INDICATOR: "typing_indicator",
  ERROR: "error",
  ROOM_USERS: "room_users",
  MESSAGE_HISTORY: "message_history",
  ROOM_ACCESS_UPDATE: "room_access_update",
} as const;

export interface ClientRecord {
  id: string;
  privyUserId: string;
  username: string | null;
  currentRoom: string | null;
  isTyping: boolean;
}

export interface RoomUser {
  id: string;
  username: string;
}

export interface ChatMessage {
  id: string;
  type: typeof MSG.MESSAGE_RECEIVED;
  room: string;
  userId: string;
  username: string;
  content: string;
  timestamp: string;
}

export interface IncomingClientMessage {
  type?: string;
  username?: string;
  room?: string;
  content?: string;
  targetId?: string;
}

export interface RoomUsersMessage {
  type: typeof MSG.ROOM_USERS;
  users: RoomUser[];
}

export type ServerMessage =
  | { type: typeof MSG.ERROR; message: string }
  | { type: typeof MSG.USERNAME_SET; username: string }
  | { type: typeof MSG.ROOM_JOINED; room: string }
  | { type: typeof MSG.ROOM_LEFT; room: string }
  | {
      type: typeof MSG.ROOM_ACCESS_UPDATE;
      room: string;
      status: "pending" | "denied";
      message: string;
    }
  | { type: typeof MSG.USER_JOINED; username: string; userId: string }
  | { type: typeof MSG.USER_LEFT; username: string | null; userId: string }
  | ChatMessage
  | {
      type: typeof MSG.TYPING_INDICATOR;
      userId: string;
      username: string;
      isTyping: boolean;
    }
  | { type: typeof MSG.MESSAGE_HISTORY; messages: ChatMessage[] }
  | {
      type: typeof MSG.PRIVATE_MESSAGE | "private_message_sent";
      fromId: string;
      fromUsername: string;
      toId: string;
      toUsername: string;
      content: string;
      timestamp: string;
    };
