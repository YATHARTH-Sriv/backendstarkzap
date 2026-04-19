import express from "express";
import { PrivyClient } from "@privy-io/node";
import type { WalletRepository } from "../db/wallet-repo.ts";

export type RequestWithPrivyUser = express.Request & {
  privyUserId?: string;
};

function getBearerToken(req: express.Request): string | null {
  const authHeader = req.header("authorization");
  if (!authHeader) {
    return null;
  }

  const [scheme, token] = authHeader.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) {
    return null;
  }

  return token;
}

export function createRequirePrivyUser(
  privy: PrivyClient,
  walletRepo: WalletRepository,
): express.RequestHandler {
  return async (req, res, next) => {
    const typedReq = req as RequestWithPrivyUser;

    try {
      const token = getBearerToken(req);

      if (!token) {
        return res.status(401).json({ error: "Missing bearer token" });
      }

      const claims = await privy.utils().auth().verifyAccessToken(token);

      if (!claims.user_id) {
        return res.status(401).json({ error: "Invalid Privy token" });
      }

      typedReq.privyUserId = claims.user_id;
      await walletRepo.ensureAppUser(claims.user_id);
      next();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Auth failed";
      return res.status(401).json({ error: message });
    }
  };
}
