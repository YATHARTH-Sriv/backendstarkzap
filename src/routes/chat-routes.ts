import { Router } from "express";
import type {
    ChatRepository,
    ChatRoomJoinPolicy,
    ChatRoomVisibility,
} from "../db/chat-repo.ts";
import type { UserProfileRepository } from "../db/user-profile-repo.ts";
import type { RequestWithPrivyUser } from "../middleware/require-privy-user.ts";

function parseLimit(
  raw: unknown,
  defaultValue: number,
  maxValue: number,
): number {
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

function normalizeUsername(raw: unknown): string {
  if (typeof raw !== "string") {
    return "";
  }

  return raw
    .trim()
    .replace(/[^a-zA-Z0-9_]/g, "")
    .slice(0, 20);
}

function parseRoomVisibility(raw: unknown): ChatRoomVisibility | null {
  if (raw === "public" || raw === "private") {
    return raw;
  }

  return null;
}

function parseJoinPolicy(raw: unknown): ChatRoomJoinPolicy | null {
  if (raw === "open" || raw === "approval" || raw === "invite_only") {
    return raw;
  }

  return null;
}

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  return (error as { code?: unknown }).code === "23505";
}

export function createChatRouter(params: {
  chatRepo: ChatRepository;
  requirePrivyUser: import("express").RequestHandler;
  userProfileRepo: UserProfileRepository;
}) {
  const { chatRepo, requirePrivyUser, userProfileRepo } = params;
  const router = Router();

  router.get("/api/chat/rooms", requirePrivyUser, async (req, res) => {
    const typedReq = req as RequestWithPrivyUser;
    const userId = typedReq.privyUserId;
    const limit = parseLimit(req.query.limit, 100, 500);

    if (!userId) {
      return res.status(401).json({ error: "User not authenticated" });
    }

    try {
      const rooms = await chatRepo.listVisibleRoomsForUser(userId, limit);
      return res.json({ rooms });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to list rooms";
      return res.status(500).json({ error: message });
    }
  });

  router.post("/api/chat/rooms", requirePrivyUser, async (req, res) => {
    const typedReq = req as RequestWithPrivyUser;
    const userId = typedReq.privyUserId;
    const roomName = normalizeRoomName(
      (req.body as { roomName?: unknown })?.roomName,
    );
    const requestedVisibility = parseRoomVisibility(
      (req.body as { visibility?: unknown })?.visibility,
    );
    const requestedJoinPolicy = parseJoinPolicy(
      (req.body as { joinPolicy?: unknown })?.joinPolicy,
    );

    if (!userId) {
      return res.status(401).json({ error: "User not authenticated" });
    }

    if (!roomName) {
      return res.status(400).json({ error: "roomName is required" });
    }

    if (
      (req.body as { visibility?: unknown })?.visibility !== undefined &&
      !requestedVisibility
    ) {
      return res
        .status(400)
        .json({ error: "visibility must be public or private" });
    }

    if (
      (req.body as { joinPolicy?: unknown })?.joinPolicy !== undefined &&
      !requestedJoinPolicy
    ) {
      return res
        .status(400)
        .json({ error: "joinPolicy must be open, approval, or invite_only" });
    }

    const visibility = requestedVisibility ?? "public";
    const joinPolicy =
      requestedJoinPolicy ??
      (visibility === "private" ? "invite_only" : "open");

    try {
      const profile = await userProfileRepo.getByPrivyUserId(userId);
      if (!profile?.username) {
        return res
          .status(409)
          .json({ error: "Set username in onboarding before creating rooms" });
      }

      await chatRepo.upsertChatProfile(profile.username);

      const room = await chatRepo.createRoom({
        roomName,
        visibility,
        joinPolicy,
        createdByPrivyUserId: userId,
      });

      return res.status(201).json({ room });
    } catch (error) {
      if (isUniqueViolation(error)) {
        return res.status(409).json({ error: "Room already exists" });
      }

      const message =
        error instanceof Error ? error.message : "Failed to create room";
      return res.status(500).json({ error: message });
    }
  });

  router.get(
    "/api/chat/rooms/:room/messages",
    requirePrivyUser,
    async (req, res) => {
      const typedReq = req as RequestWithPrivyUser;
      const userId = typedReq.privyUserId;
      const roomName = normalizeRoomName(req.params.room);
      const limit = parseLimit(req.query.limit, 50, 200);

      if (!userId) {
        return res.status(401).json({ error: "User not authenticated" });
      }

      if (!roomName) {
        return res.status(400).json({ error: "room is required" });
      }

      try {
        const hasAccess = await chatRepo.hasActiveRoomMembership(
          roomName,
          userId,
        );
        if (!hasAccess) {
          return res
            .status(403)
            .json({ error: "Only room members can read room messages" });
        }

        const messages = await chatRepo.loadRecentRoomMessages(roomName, limit);
        return res.json({ room: roomName, messages });
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Failed to load room messages";
        return res.status(500).json({ error: message });
      }
    },
  );

  router.get(
    "/api/chat/rooms/:room/members",
    requirePrivyUser,
    async (req, res) => {
      const typedReq = req as RequestWithPrivyUser;
      const userId = typedReq.privyUserId;
      const roomName = normalizeRoomName(req.params.room);

      if (!userId) {
        return res.status(401).json({ error: "User not authenticated" });
      }

      if (!roomName) {
        return res.status(400).json({ error: "room is required" });
      }

      try {
        const hasAccess = await chatRepo.hasActiveRoomMembership(
          roomName,
          userId,
        );
        if (!hasAccess) {
          return res
            .status(403)
            .json({ error: "Only room members can view members" });
        }

        const members = await chatRepo.listActiveRoomMembers(roomName);
        return res.json({ room: roomName, members });
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Failed to load room members";
        return res.status(500).json({ error: message });
      }
    },
  );

  router.get(
    "/api/chat/rooms/:room/requests",
    requirePrivyUser,
    async (req, res) => {
      const typedReq = req as RequestWithPrivyUser;
      const userId = typedReq.privyUserId;
      const roomName = normalizeRoomName(req.params.room);

      if (!userId) {
        return res.status(401).json({ error: "User not authenticated" });
      }

      if (!roomName) {
        return res.status(400).json({ error: "room is required" });
      }

      try {
        const isAdmin = await chatRepo.isRoomAdmin(roomName, userId);
        if (!isAdmin) {
          return res
            .status(403)
            .json({ error: "Only room admins can manage requests" });
        }

        const requests = await chatRepo.listPendingRoomRequests(roomName);
        return res.json({ room: roomName, requests });
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Failed to load room requests";
        return res.status(500).json({ error: message });
      }
    },
  );

  router.post(
    "/api/chat/rooms/:room/invite",
    requirePrivyUser,
    async (req, res) => {
      const typedReq = req as RequestWithPrivyUser;
      const userId = typedReq.privyUserId;
      const roomName = normalizeRoomName(req.params.room);
      const targetUsername = normalizeUsername(
        (req.body as { username?: unknown })?.username,
      );

      if (!userId) {
        return res.status(401).json({ error: "User not authenticated" });
      }

      if (!roomName) {
        return res.status(400).json({ error: "room is required" });
      }

      if (!targetUsername) {
        return res.status(400).json({ error: "username is required" });
      }

      try {
        const isAdmin = await chatRepo.isRoomAdmin(roomName, userId);
        if (!isAdmin) {
          return res
            .status(403)
            .json({ error: "Only room admins can invite members" });
        }

        const result = await chatRepo.inviteUserByUsername(
          roomName,
          userId,
          targetUsername,
        );

        if (result.status === "not_found") {
          return res.status(404).json({ error: result.message });
        }

        if (result.status === "invalid") {
          return res.status(400).json({ error: result.message });
        }

        if (result.status === "banned") {
          return res.status(409).json({ error: result.message });
        }

        return res.json(result);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to invite user";
        return res.status(500).json({ error: message });
      }
    },
  );

  router.post(
    "/api/chat/rooms/:room/requests/:targetPrivyUserId/approve",
    requirePrivyUser,
    async (req, res) => {
      const typedReq = req as RequestWithPrivyUser;
      const userId = typedReq.privyUserId;
      const roomName = normalizeRoomName(req.params.room);
      const targetPrivyUserId = req.params.targetPrivyUserId?.trim();

      if (!userId) {
        return res.status(401).json({ error: "User not authenticated" });
      }

      if (!roomName || !targetPrivyUserId) {
        return res
          .status(400)
          .json({ error: "room and targetPrivyUserId are required" });
      }

      try {
        const isAdmin = await chatRepo.isRoomAdmin(roomName, userId);
        if (!isAdmin) {
          return res
            .status(403)
            .json({ error: "Only room admins can approve requests" });
        }

        const approved = await chatRepo.approvePendingRoomRequest(
          roomName,
          targetPrivyUserId,
        );
        if (!approved) {
          return res.status(404).json({ error: "Pending request not found" });
        }

        return res.json({
          room: roomName,
          targetPrivyUserId,
          status: "approved",
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to approve request";
        return res.status(500).json({ error: message });
      }
    },
  );

  router.post(
    "/api/chat/rooms/:room/requests/:targetPrivyUserId/reject",
    requirePrivyUser,
    async (req, res) => {
      const typedReq = req as RequestWithPrivyUser;
      const userId = typedReq.privyUserId;
      const roomName = normalizeRoomName(req.params.room);
      const targetPrivyUserId = req.params.targetPrivyUserId?.trim();

      if (!userId) {
        return res.status(401).json({ error: "User not authenticated" });
      }

      if (!roomName || !targetPrivyUserId) {
        return res
          .status(400)
          .json({ error: "room and targetPrivyUserId are required" });
      }

      try {
        const isAdmin = await chatRepo.isRoomAdmin(roomName, userId);
        if (!isAdmin) {
          return res
            .status(403)
            .json({ error: "Only room admins can reject requests" });
        }

        const rejected = await chatRepo.rejectPendingRoomRequest(
          roomName,
          targetPrivyUserId,
        );
        if (!rejected) {
          return res.status(404).json({ error: "Pending request not found" });
        }

        return res.json({
          room: roomName,
          targetPrivyUserId,
          status: "rejected",
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to reject request";
        return res.status(500).json({ error: message });
      }
    },
  );

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
        return res
          .status(409)
          .json({
            error: "Set username in onboarding before loading DM history",
          });
      }

      const messages = await chatRepo.loadRecentPrivateMessages(
        profile.username,
        userB,
        limit,
      );
      return res.json({ users: [profile.username, userB], messages });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to load dm history";
      return res.status(500).json({ error: message });
    }
  });

  return router;
}
