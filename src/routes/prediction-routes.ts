import express, { Router } from "express";
import type { Call, StarkZap } from "starkzap";
import type { TxActivityRepository } from "../db/tx-activity-repo.ts";
import type { WalletRecord, WalletRepository } from "../db/wallet-repo.ts";
import type { RequestWithPrivyUser } from "../middleware/require-privy-user.ts";
import { getErrorMessage } from "../services/error-utils.ts";
import {
  STARK_FIELD_PRIME,
  parseNonNegativeIntAsBigInt,
  parsePositiveIntAsBigInt,
  stringToFelt252,
  toFeltHex,
} from "../services/felt-utils.ts";
import type { StarknetWalletService } from "../services/starknet-wallet.ts";
import { createErc20BalanceReader, toU256Calldata } from "../services/u256-utils.ts";

export function createPredictionRouter(params: {
  sdk: StarkZap;
  predictionContractAddress: string;
  strkTokenContractAddress: string;
  requirePrivyUser: express.RequestHandler;
  walletRepo: WalletRepository;
  walletService: StarknetWalletService;
  txActivityRepo: TxActivityRepository;
}) {
  const {
    sdk,
    predictionContractAddress,
    strkTokenContractAddress,
    requirePrivyUser,
    walletRepo,
    walletService,
    txActivityRepo,
  } = params;
  const router = Router();
  const readErc20Balance = createErc20BalanceReader(sdk, strkTokenContractAddress);

  router.get("/api/market-count", async (_req, res) => {
    try {
      const response = await sdk.callContract({
        contractAddress: predictionContractAddress,
        entrypoint: "get_market_count",
        calldata: [],
      });

      const raw = response[0] ?? "0x0";
      const count = BigInt(raw).toString();

      return res.json({ count, raw });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Market count read failed";
      return res.status(500).json({ error: message });
    }
  });

  router.get("/api/prediction/balances", requirePrivyUser, async (req, res) => {
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
      const userBalance = await readErc20Balance(wallet.address);
      const treasuryBalance = await readErc20Balance(predictionContractAddress);

      return res.json({
        tokenContractAddress: strkTokenContractAddress,
        walletAddress: wallet.address,
        treasuryAddress: predictionContractAddress,
        symbol: "STRK",
        userBalance: userBalance.value.toString(),
        userBalanceRaw: {
          low: userBalance.lowHex,
          high: userBalance.highHex,
        },
        treasuryBalance: treasuryBalance.value.toString(),
        treasuryBalanceRaw: {
          low: treasuryBalance.lowHex,
          high: treasuryBalance.highHex,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Prediction balances read failed";
      return res.status(500).json({ error: message });
    }
  });

  router.post("/create-market", requirePrivyUser, async (req, res) => {
    const typedReq = req as RequestWithPrivyUser;
    const userId = typedReq.privyUserId;

    if (!userId) {
      return res.status(401).json({ error: "User not authenticated" });
    }

    const { title, time } = req.body as {
      title?: string;
      time?: unknown;
    };

    if (typeof title !== "string" || title.trim().length === 0) {
      return res.status(400).json({ error: "title is required" });
    }

    const normalizedTitle = title.trim();

    if (!/^[\x20-\x7E]{1,31}$/.test(normalizedTitle)) {
      return res.status(400).json({
        error: "title must be ASCII and between 1 and 31 characters",
      });
    }

    const deadline = parsePositiveIntAsBigInt(time);
    if (!deadline) {
      return res.status(400).json({
        error: "time must be a positive unix timestamp",
      });
    }

    if (deadline >= STARK_FIELD_PRIME) {
      return res.status(400).json({ error: "time is too large for felt252" });
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

      const questionFelt = stringToFelt252(normalizedTitle);

      const call: Call = {
        contractAddress: predictionContractAddress,
        entrypoint: "create_market",
        calldata: [questionFelt, toFeltHex(deadline)],
      };

      const execution = await walletService.executeWithOogRetry(userWallet, call);

      await txActivityRepo.record({
        privyUserId: userId,
        action: "Market Created",
        status: "success",
        txHash: execution.txHash,
        explorerUrl: execution.explorerUrl,
        metadata: { title: normalizedTitle, deadline: deadline.toString() },
      });

      return res.json({
        message: "Market created transaction submitted",
        title: normalizedTitle,
        deadline: deadline.toString(),
        txHash: execution.txHash,
        explorerUrl: execution.explorerUrl,
        executionMode: execution.executionMode,
      });
    } catch (error) {
      console.error("Create market failed", {
        userId,
        walletId: wallet.id,
        title: normalizedTitle,
        deadline: deadline.toString(),
        details: getErrorMessage(error),
      });

      const message = error instanceof Error ? error.message : "Create market failed";
      await txActivityRepo.record({
        privyUserId: userId,
        action: "Market Created",
        status: "failed",
        details: message,
        metadata: { title: normalizedTitle, deadline: deadline.toString() },
      });
      return res.status(500).json({ error: message });
    }
  });

  router.post("/place-bet", requirePrivyUser, async (req, res) => {
    const typedReq = req as RequestWithPrivyUser;
    const userId = typedReq.privyUserId;

    if (!userId) {
      return res.status(401).json({ error: "User not authenticated" });
    }

    const { marketId, outcome, amount } = req.body as {
      marketId?: unknown;
      outcome?: unknown;
      amount?: unknown;
    };

    const parsedMarketId = parseNonNegativeIntAsBigInt(marketId);
    if (parsedMarketId === null) {
      return res.status(400).json({
        error: "marketId must be a non-negative integer",
      });
    }

    if (parsedMarketId >= STARK_FIELD_PRIME) {
      return res.status(400).json({ error: "marketId is too large for felt252" });
    }

    if (typeof outcome !== "boolean") {
      return res.status(400).json({ error: "outcome must be a boolean" });
    }

    const parsedAmount = parsePositiveIntAsBigInt(amount);
    if (!parsedAmount) {
      return res.status(400).json({ error: "amount must be a positive integer string in wei" });
    }

    let wallet: WalletRecord | null = null;

    try {
      const marketCountRead = await sdk.callContract({
        contractAddress: predictionContractAddress,
        entrypoint: "get_market_count",
        calldata: [],
      });
      const currentMarketCount = BigInt(marketCountRead[0] ?? "0x0");

      if (parsedMarketId >= currentMarketCount) {
        return res.status(400).json({
          error: "marketId does not exist",
          currentMarketCount: currentMarketCount.toString(),
          hint: "Create a market first or refresh market count before placing bets",
        });
      }

      wallet = await walletRepo.getWalletByPrivyUserId(userId);
      if (!wallet) {
        return res.status(404).json({
          error: "No Starknet wallet found for user. Call POST /api/wallet/starknet first.",
        });
      }

      let userWallet;

      try {
        userWallet = await walletService.ensureWalletReadyForWrites(wallet);
      } catch (error) {
        const walletNotReady = walletService.buildWalletNotReadyResponse(error, wallet.address);
        return res.status(walletNotReady.statusCode).json(walletNotReady.payload);
      }

      const [amountLow, amountHigh] = toU256Calldata(parsedAmount);

      const approveCall: Call = {
        contractAddress: strkTokenContractAddress,
        entrypoint: "approve",
        calldata: [predictionContractAddress, amountLow, amountHigh],
      };

      const betCall: Call = {
        contractAddress: predictionContractAddress,
        entrypoint: "place_bet",
        calldata: [toFeltHex(parsedMarketId), outcome ? "0x1" : "0x0", amountLow, amountHigh],
      };

      const execution = await walletService.executeCallsWithOogRetry(userWallet, [approveCall, betCall]);

      await txActivityRepo.record({
        privyUserId: userId,
        action: "Bet Placed",
        status: "success",
        txHash: execution.txHash,
        explorerUrl: execution.explorerUrl,
        metadata: {
          marketId: parsedMarketId.toString(),
          outcome,
          amount: parsedAmount.toString(),
        },
      });

      return res.json({
        message: "Bet placed transaction submitted",
        marketId: parsedMarketId.toString(),
        outcome,
        amount: parsedAmount.toString(),
        txHash: execution.txHash,
        explorerUrl: execution.explorerUrl,
        executionMode: execution.executionMode,
      });
    } catch (error) {
      console.error("Place bet failed", {
        userId,
        walletId: wallet?.id,
        marketId: parsedMarketId.toString(),
        outcome,
        amount: parsedAmount.toString(),
        details: getErrorMessage(error),
      });

      const message = error instanceof Error ? error.message : "Place bet failed";
      await txActivityRepo.record({
        privyUserId: userId,
        action: "Bet Placed",
        status: "failed",
        details: message,
        metadata: {
          marketId: parsedMarketId.toString(),
          outcome,
          amount: parsedAmount.toString(),
        },
      });
      return res.status(500).json({ error: message });
    }
  });

  router.post("/resolve-market", requirePrivyUser, async (req, res) => {
    const typedReq = req as RequestWithPrivyUser;
    const userId = typedReq.privyUserId;

    if (!userId) {
      return res.status(401).json({ error: "User not authenticated" });
    }

    const { marketId, winningOutcome } = req.body as {
      marketId?: unknown;
      winningOutcome?: unknown;
    };

    const parsedMarketId = parseNonNegativeIntAsBigInt(marketId);
    if (parsedMarketId === null) {
      return res.status(400).json({
        error: "marketId must be a non-negative integer",
      });
    }

    if (parsedMarketId >= STARK_FIELD_PRIME) {
      return res.status(400).json({ error: "marketId is too large for felt252" });
    }

    if (typeof winningOutcome !== "boolean") {
      return res.status(400).json({ error: "winningOutcome must be a boolean" });
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
        contractAddress: predictionContractAddress,
        entrypoint: "resolve_market",
        calldata: [toFeltHex(parsedMarketId), winningOutcome ? "0x1" : "0x0"],
      };

      const execution = await walletService.executeWithOogRetry(userWallet, call);

      await txActivityRepo.record({
        privyUserId: userId,
        action: "Market Resolved",
        status: "success",
        txHash: execution.txHash,
        explorerUrl: execution.explorerUrl,
        metadata: {
          marketId: parsedMarketId.toString(),
          winningOutcome,
        },
      });

      return res.json({
        message: "Market resolved transaction submitted",
        marketId: parsedMarketId.toString(),
        winningOutcome,
        txHash: execution.txHash,
        explorerUrl: execution.explorerUrl,
        executionMode: execution.executionMode,
      });
    } catch (error) {
      console.error("Resolve market failed", {
        userId,
        walletId: wallet.id,
        marketId: parsedMarketId.toString(),
        winningOutcome,
        details: getErrorMessage(error),
      });

      const message = error instanceof Error ? error.message : "Resolve market failed";
      await txActivityRepo.record({
        privyUserId: userId,
        action: "Market Resolved",
        status: "failed",
        details: message,
        metadata: {
          marketId: parsedMarketId.toString(),
          winningOutcome,
        },
      });
      return res.status(500).json({ error: message });
    }
  });

  router.post("/claim-winnings", requirePrivyUser, async (req, res) => {
    const typedReq = req as RequestWithPrivyUser;
    const userId = typedReq.privyUserId;

    if (!userId) {
      return res.status(401).json({ error: "User not authenticated" });
    }

    const { marketId } = req.body as {
      marketId?: unknown;
    };

    const parsedMarketId = parseNonNegativeIntAsBigInt(marketId);
    if (parsedMarketId === null) {
      return res.status(400).json({
        error: "marketId must be a non-negative integer",
      });
    }

    if (parsedMarketId >= STARK_FIELD_PRIME) {
      return res.status(400).json({ error: "marketId is too large for felt252" });
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
        contractAddress: predictionContractAddress,
        entrypoint: "claim_winnings",
        calldata: [toFeltHex(parsedMarketId)],
      };

      const execution = await walletService.executeWithOogRetry(userWallet, call);

      await txActivityRepo.record({
        privyUserId: userId,
        action: "Winnings Claimed",
        status: "success",
        txHash: execution.txHash,
        explorerUrl: execution.explorerUrl,
        metadata: { marketId: parsedMarketId.toString() },
      });

      return res.json({
        message: "Winnings claim transaction submitted",
        marketId: parsedMarketId.toString(),
        txHash: execution.txHash,
        explorerUrl: execution.explorerUrl,
        executionMode: execution.executionMode,
      });
    } catch (error) {
      console.error("Claim winnings failed", {
        userId,
        walletId: wallet.id,
        marketId: parsedMarketId.toString(),
        details: getErrorMessage(error),
      });

      const message = error instanceof Error ? error.message : "Claim winnings failed";
      await txActivityRepo.record({
        privyUserId: userId,
        action: "Winnings Claimed",
        status: "failed",
        details: message,
        metadata: { marketId: parsedMarketId.toString() },
      });
      return res.status(500).json({ error: message });
    }
  });

  return router;
}
