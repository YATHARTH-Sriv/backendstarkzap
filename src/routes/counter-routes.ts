import express, { Router } from "express";
import type { Call, StarkZap } from "starkzap";
import type { TxActivityRepository } from "../db/tx-activity-repo.ts";
import type { WalletRepository } from "../db/wallet-repo.ts";
import type { RequestWithPrivyUser } from "../middleware/require-privy-user.ts";
import { getErrorMessage } from "../services/error-utils.ts";
import {
  STARK_FIELD_PRIME,
  parsePositiveIntAsBigInt,
  toFeltHex,
} from "../services/felt-utils.ts";
import type { StarknetWalletService } from "../services/starknet-wallet.ts";

export function createCounterRouter(params: {
  sdk: StarkZap;
  counterContractAddress: string;
  requirePrivyUser: express.RequestHandler;
  walletRepo: WalletRepository;
  walletService: StarknetWalletService;
  txActivityRepo: TxActivityRepository;
}) {
  const { sdk, counterContractAddress, requirePrivyUser, walletRepo, walletService, txActivityRepo } = params;
  const router = Router();

  router.get("/api/counter/count", async (_req, res) => {
    try {
      const result = await sdk.callContract({
        contractAddress: counterContractAddress,
        entrypoint: "get_count",
        calldata: [],
      });

      const raw = result[0] ?? "0x0";
      const count = BigInt(raw).toString();

      return res.json({ count, raw });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Counter read failed";
      return res.status(500).json({ error: message });
    }
  });

  router.post("/api/counter/increment", requirePrivyUser, async (req, res) => {
    const typedReq = req as RequestWithPrivyUser;
    const userId = typedReq.privyUserId;

    if (!userId) {
      return res.status(401).json({ error: "User not authenticated" });
    }

    const amount = parsePositiveIntAsBigInt(req.body?.amount ?? 1);
    if (!amount) {
      return res.status(400).json({ error: "amount must be a positive integer" });
    }

    if (amount >= STARK_FIELD_PRIME) {
      return res.status(400).json({ error: "amount is too large for felt252" });
    }

    const wallet = await walletRepo.getWalletByPrivyUserId(userId);
    if (!wallet) {
      return res.status(404).json({
        error: "No Starknet wallet found for user. Call POST /api/wallet/starknet first.",
      });
    }

    try {
      let userWallet;

      try {
        userWallet = await walletService.ensureWalletReadyForWrites(wallet);
      } catch (error) {
        const walletNotReady = walletService.buildWalletNotReadyResponse(error, wallet.address);
        return res.status(walletNotReady.statusCode).json(walletNotReady.payload);
      }

      const call: Call = {
        contractAddress: counterContractAddress,
        entrypoint: "increment",
        calldata: [toFeltHex(amount)],
      };

      const execution = await walletService.executeWithOogRetry(userWallet, call);

      await txActivityRepo.record({
        privyUserId: userId,
        action: "Counter Increment",
        status: "success",
        txHash: execution.txHash,
        explorerUrl: execution.explorerUrl,
        metadata: { amount: amount.toString() },
      });

      return res.json({
        message: "Counter increment transaction submitted",
        amount: amount.toString(),
        txHash: execution.txHash,
        explorerUrl: execution.explorerUrl,
        executionMode: execution.executionMode,
      });
    } catch (error) {
      console.error("Counter increment failed", {
        userId,
        walletId: wallet.id,
        amount: amount.toString(),
        details: getErrorMessage(error),
      });

      const message = error instanceof Error ? error.message : "Counter increment failed";
      await txActivityRepo.record({
        privyUserId: userId,
        action: "Counter Increment",
        status: "failed",
        details: message,
        metadata: { amount: amount.toString() },
      });
      return res.status(500).json({ error: message });
    }
  });

  return router;
}
