import express, { Router } from "express";
import { PrivyClient } from "@privy-io/node";
import type { TxActivityRepository } from "../db/tx-activity-repo.ts";
import type { WalletRecord, WalletRepository } from "../db/wallet-repo.ts";
import type { RequestWithPrivyUser } from "../middleware/require-privy-user.ts";
import { getErrorMessage } from "../services/error-utils.ts";
import { isStarknetFeltHex } from "../services/felt-utils.ts";
import type { StarknetWalletService } from "../services/starknet-wallet.ts";

export function createWalletRouter(params: {
  privy: PrivyClient;
  walletRepo: WalletRepository;
  requirePrivyUser: express.RequestHandler;
  walletService: StarknetWalletService;
  txActivityRepo: TxActivityRepository;
}) {
  const { privy, walletRepo, requirePrivyUser, walletService, txActivityRepo } = params;
  const router = Router();

  router.post("/api/wallet/starknet", requirePrivyUser, async (req, res) => {
    const typedReq = req as RequestWithPrivyUser;
    const userId = typedReq.privyUserId;

    if (!userId) {
      return res.status(401).json({ error: "User not authenticated" });
    }

    try {
      const existing = await walletRepo.getWalletByPrivyUserId(userId);
      if (existing) {
        try {
          await walletService.ensureWalletReadyForWrites(existing);
          await txActivityRepo.record({
            privyUserId: userId,
            action: "Wallet Check",
            status: "success",
            details: "Wallet already deployed and ready",
            metadata: { walletId: existing.id },
          });
          return res.json({
            wallet: existing,
            deployment: walletService.deploymentResponse(true, undefined, existing.address),
          });
        } catch (error) {
          const message = getErrorMessage(error);
          await txActivityRepo.record({
            privyUserId: userId,
            action: "Wallet Check",
            status: "failed",
            details: message,
            metadata: { walletId: existing.id },
          });
          return res.json({
            wallet: existing,
            deployment: walletService.deploymentResponse(false, message, existing.address),
          });
        }
      }

      const wallet = await privy.wallets().create({
        chain_type: "starknet",
      });

      const walletRecord: WalletRecord = {
        id: wallet.id,
        address: wallet.address,
        publicKey: wallet.public_key,
      };

      await walletRepo.upsertWalletForPrivyUser(userId, walletRecord);

      try {
        await walletService.ensureWalletReadyForWrites(walletRecord);
        await txActivityRepo.record({
          privyUserId: userId,
          action: "Wallet Created",
          status: "success",
          details: "Embedded Starknet wallet created and ready",
          metadata: { walletId: walletRecord.id },
        });
        return res.json({
          wallet: walletRecord,
          deployment: walletService.deploymentResponse(true, undefined, walletRecord.address),
        });
      } catch (error) {
        const message = getErrorMessage(error);
        await txActivityRepo.record({
          privyUserId: userId,
          action: "Wallet Created",
          status: "failed",
          details: message,
          metadata: { walletId: walletRecord.id },
        });
        return res.json({
          wallet: walletRecord,
          deployment: walletService.deploymentResponse(false, message, walletRecord.address),
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Wallet creation failed";
      return res.status(500).json({ error: message });
    }
  });

  router.post("/api/wallet/deploy", requirePrivyUser, async (req, res) => {
    const typedReq = req as RequestWithPrivyUser;
    const userId = typedReq.privyUserId;

    if (!userId) {
      return res.status(401).json({ error: "User not authenticated" });
    }

    const wallet = await walletRepo.getWalletByPrivyUserId(userId);
    if (!wallet) {
      return res.status(404).json({
        error: "No Starknet wallet found for user. Call POST /api/wallet/starknet first.",
      });
    }

    try {
      await walletService.ensureWalletReadyForWrites(wallet);
      await txActivityRepo.record({
        privyUserId: userId,
        action: "Wallet Deploy",
        status: "success",
        details: "Wallet deployed and ready",
        metadata: { walletId: wallet.id },
      });
      return res.json({
        wallet,
        deployment: walletService.deploymentResponse(true, undefined, wallet.address),
      });
    } catch (error) {
      const message = getErrorMessage(error);
      await txActivityRepo.record({
        privyUserId: userId,
        action: "Wallet Deploy",
        status: "failed",
        details: message,
        metadata: { walletId: wallet.id },
      });
      return res.status(409).json({
        wallet,
        deployment: walletService.deploymentResponse(false, message, wallet.address),
      });
    }
  });

  router.post("/api/wallet/sign", requirePrivyUser, async (req, res) => {
    const typedReq = req as RequestWithPrivyUser;
    const userId = typedReq.privyUserId;
    const { walletId, hash } = req.body as {
      walletId?: string;
      hash?: string;
    };

    if (!userId) {
      return res.status(401).json({ error: "User not authenticated" });
    }

    if (!walletId || !hash) {
      return res.status(400).json({ error: "walletId and hash are required" });
    }

    if (!isStarknetFeltHex(hash)) {
      return res.status(400).json({
        error: "hash must be a valid Starknet felt (0x-prefixed hex and within Stark field range)",
      });
    }

    const wallet = await walletRepo.getWalletByPrivyUserId(userId);
    if (!wallet || wallet.id !== walletId) {
      return res.status(403).json({ error: "Wallet does not belong to authenticated user" });
    }

    try {
      const result = await privy.wallets().rawSign(walletId, {
        params: { hash },
      });

      await txActivityRepo.record({
        privyUserId: userId,
        action: "Message Signed",
        status: "success",
        details: "Wallet signature generated",
        metadata: { walletId },
      });

      return res.json({ signature: result.signature });
    } catch (error) {
      console.error("Privy rawSign failed", {
        userId,
        walletId,
        hash,
        details: getErrorMessage(error),
      });

      const message = error instanceof Error ? error.message : "Sign failed";
      await txActivityRepo.record({
        privyUserId: userId,
        action: "Message Signed",
        status: "failed",
        details: message,
        metadata: { walletId },
      });
      return res.status(500).json({
        error: message,
        hint: "Check server logs for rawSign details",
      });
    }
  });

  return router;
}
