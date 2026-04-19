import { Router } from "express";
import type { ChatRepository } from "../db/chat-repo.ts";
import type { UserProfileRepository } from "../db/user-profile-repo.ts";
import type { RequestWithPrivyUser } from "../middleware/require-privy-user.ts";

function parseLimit(raw: unknown, defaultValue: number, maxValue: number): number {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return defaultValue;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return defaultValue;
  }

  return Math.min(Math.trunc(parsed), maxValue);
}

function normalizeRoomName(raw: unknown): string {
  if (typeof raw !== "string") {
    return "";
  }

  return raw
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[^\x20-\x7E]/g, "")
    .slice(0, 40);
}

export function createChatRouter(params: {
  chatRepo: ChatRepository;
  requirePrivyUser: import("express").RequestHandler;
  userProfileRepo: UserProfileRepository;
}) {
  const { chatRepo, requirePrivyUser, userProfileRepo } = params;
  const router = Router();

  router.get("/api/chat/rooms", async (req, res) => {
    const limit = parseLimit(req.query.limit, 100, 500);

    try {
      const rooms = await chatRepo.listRooms(limit);
      return res.json({ rooms });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to list rooms";
      return res.status(500).json({ error: message });
    }
  });

  router.get("/api/chat/rooms/:room/messages", async (req, res) => {
    const roomName = normalizeRoomName(req.params.room);
    const limit = parseLimit(req.query.limit, 50, 200);

    if (!roomName) {
      return res.status(400).json({ error: "room is required" });
    }

    try {
      const messages = await chatRepo.loadRecentRoomMessages(roomName, limit);
      return res.json({ room: roomName, messages });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load room messages";
      return res.status(500).json({ error: message });
    }
  });

  router.get("/api/chat/dm/history", requirePrivyUser, async (req, res) => {
    const typedReq = req as RequestWithPrivyUser;
    const userId = typedReq.privyUserId;
    const userB =
      typeof req.query.target === "string"
        ? req.query.target.trim()
        : typeof req.query.userB === "string"
          ? req.query.userB.trim()
          : "";
    const limit = parseLimit(req.query.limit, 50, 200);

    if (!userId) {
      return res.status(401).json({ error: "User not authenticated" });
    }

    if (!userB) {
      return res.status(400).json({ error: "target query param is required" });
    }

    try {
      const profile = await userProfileRepo.getByPrivyUserId(userId);
      if (!profile?.username) {
        return res.status(409).json({ error: "Set username in onboarding before loading DM history" });
      }

      const messages = await chatRepo.loadRecentPrivateMessages(profile.username, userB, limit);
      return res.json({ users: [profile.username, userB], messages });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load dm history";
      return res.status(500).json({ error: message });
    }
  });

  return router;
}
