import express, { Router } from "express";
import type { TxActivityRepository } from "../db/tx-activity-repo.ts";
import type { UserProfileRepository } from "../db/user-profile-repo.ts";
import type { WalletRepository } from "../db/wallet-repo.ts";
import type { RequestWithPrivyUser } from "../middleware/require-privy-user.ts";

const USERNAME_REGEX = /^[a-zA-Z0-9_]{3,20}$/;

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const maybeCode = (error as { code?: unknown }).code;
  return maybeCode === "23505";
}

function normalizeUsername(raw: unknown): string {
  if (typeof raw !== "string") {
    return "";
  }

  return raw.trim().slice(0, 20);
}

export function createProfileRouter(params: {
  requirePrivyUser: express.RequestHandler;
  walletRepo: WalletRepository;
  userProfileRepo: UserProfileRepository;
  txActivityRepo: TxActivityRepository;
}) {
  const { requirePrivyUser, walletRepo, userProfileRepo, txActivityRepo } = params;
  const router = Router();

  router.get("/api/profile/me", requirePrivyUser, async (req, res) => {
    const typedReq = req as RequestWithPrivyUser;
    const userId = typedReq.privyUserId;

    if (!userId) {
      return res.status(401).json({ error: "User not authenticated" });
    }

    try {
      await userProfileRepo.ensureUser(userId);

      const [profile, wallet] = await Promise.all([
        userProfileRepo.getByPrivyUserId(userId),
        walletRepo.getWalletByPrivyUserId(userId),
      ]);

      return res.json({ profile, wallet });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load profile";
      return res.status(500).json({ error: message });
    }
  });

  router.post("/api/profile/username", requirePrivyUser, async (req, res) => {
    const typedReq = req as RequestWithPrivyUser;
    const userId = typedReq.privyUserId;
    const username = normalizeUsername((req.body as { username?: unknown })?.username);

    if (!userId) {
      return res.status(401).json({ error: "User not authenticated" });
    }

    if (!USERNAME_REGEX.test(username)) {
      return res.status(400).json({
        error: "username must be 3-20 chars and only letters, numbers, or underscore",
      });
    }

    try {
      const profile = await userProfileRepo.setUsername(userId, username);

      return res.json({ profile });
    } catch (error) {
      if (isUniqueViolation(error)) {
        return res.status(409).json({ error: "username is already taken" });
      }

      const message = error instanceof Error ? error.message : "Failed to set username";
      return res.status(500).json({ error: message });
    }
  });

  router.post("/api/profile/onboarding/complete", requirePrivyUser, async (req, res) => {
    const typedReq = req as RequestWithPrivyUser;
    const userId = typedReq.privyUserId;

    if (!userId) {
      return res.status(401).json({ error: "User not authenticated" });
    }

    try {
      const [profile, wallet] = await Promise.all([
        userProfileRepo.getByPrivyUserId(userId),
        walletRepo.getWalletByPrivyUserId(userId),
      ]);

      if (!profile?.username) {
        return res.status(409).json({ error: "Set a username before completing onboarding" });
      }

      if (!wallet) {
        return res.status(409).json({ error: "Create wallet before completing onboarding" });
      }

      const updatedProfile = await userProfileRepo.markOnboardingComplete(userId);
      return res.json({ profile: updatedProfile, wallet });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to complete onboarding";
      return res.status(500).json({ error: message });
    }
  });

  router.get("/api/profile/transactions", requirePrivyUser, async (req, res) => {
    const typedReq = req as RequestWithPrivyUser;
    const userId = typedReq.privyUserId;

    if (!userId) {
      return res.status(401).json({ error: "User not authenticated" });
    }

    const parsedLimit = Number.parseInt(String(req.query.limit ?? "12"), 10);
    const limit = Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 50) : 12;

    try {
      const transactions = await txActivityRepo.listRecentByPrivyUserId(userId, limit);
      return res.json({ transactions, limit });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load transactions";
      return res.status(500).json({ error: message });
    }
  });

  return router;
}
