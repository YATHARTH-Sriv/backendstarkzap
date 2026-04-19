import express, { Router } from "express";
import { Amount, ChainId, fromAddress, getPresets } from "starkzap";
import type { DirectPaymentRepository } from "../db/direct-payment-repo.ts";
import type { TxActivityRepository } from "../db/tx-activity-repo.ts";
import type { UserProfileRepository } from "../db/user-profile-repo.ts";
import type { WalletRepository } from "../db/wallet-repo.ts";
import type { RequestWithPrivyUser } from "../middleware/require-privy-user.ts";
import { getErrorMessage, isLikelyFundingOrFeeConfigError } from "../services/error-utils.ts";
import type { StarknetWalletService } from "../services/starknet-wallet.ts";
import { toU256Calldata } from "../services/u256-utils.ts";

function parseLimit(raw: unknown, fallback: number, max: number): number {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return fallback;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.min(Math.trunc(parsed), max);
}

function normalizeUsernameQuery(raw: unknown): string {
  if (typeof raw !== "string") {
    return "";
  }

  return raw.trim().replace(/[^a-zA-Z0-9_]/g, "").slice(0, 20);
}

function normalizeAmount(raw: unknown): string {
  if (typeof raw !== "string") {
    return "";
  }

  return raw.trim();
}

function normalizeRecipientInput(raw: unknown): string {
  if (typeof raw !== "string") {
    return "";
  }

  return raw.trim().slice(0, 120);
}

function normalizeWalletAddress(raw: string): string | null {
  try {
    return fromAddress(raw);
  } catch {
    return null;
  }
}

function shortenWalletAddressForDisplay(address: string): string {
  if (address.length <= 14) {
    return address;
  }

  return `${address.slice(0, 8)}...${address.slice(-4)}`;
}

function sanitizePaymentErrorMessage(rawMessage: string): string {
  const message = rawMessage.trim();

  if (/starknet_addInvokeTransaction/i.test(message)) {
    return "Transaction submission was rejected by Starknet RPC";
  }

  if (message.length > 320) {
    return "Payment transaction failed on chain";
  }

  return message || "Payment failed";
}

function buildPaymentHint(rawMessage: string): string | undefined {
  const message = rawMessage.trim();

  if (/starknet_addInvokeTransaction/i.test(message) || isLikelyFundingOrFeeConfigError(message)) {
    return "Ensure the sender wallet has enough balance for transfer plus network fees, then retry.";
  }

  return undefined;
}

export function createPaymentsRouter(params: {
  chainId: ChainId;
  requirePrivyUser: express.RequestHandler;
  walletRepo: WalletRepository;
  userProfileRepo: UserProfileRepository;
  directPaymentRepo: DirectPaymentRepository;
  walletService: StarknetWalletService;
  txActivityRepo: TxActivityRepository;
}) {
  const {
    chainId,
    requirePrivyUser,
    walletRepo,
    userProfileRepo,
    directPaymentRepo,
    walletService,
    txActivityRepo,
  } = params;

  const router = Router();

  router.get("/api/payments/search-users", requirePrivyUser, async (req, res) => {
    const typedReq = req as RequestWithPrivyUser;
    const userId = typedReq.privyUserId;

    if (!userId) {
      return res.status(401).json({ error: "User not authenticated" });
    }

    const query = normalizeUsernameQuery(req.query.q);
    const limit = parseLimit(req.query.limit, 8, 25);

    if (!query) {
      return res.json({ users: [], query, limit });
    }

    try {
      const users = await directPaymentRepo.searchUsersByUsername(query, limit, userId);
      return res.json({ users, query, limit });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to search users";
      return res.status(500).json({ error: message });
    }
  });

  router.get("/api/payments/recent-contacts", requirePrivyUser, async (req, res) => {
    const typedReq = req as RequestWithPrivyUser;
    const userId = typedReq.privyUserId;

    if (!userId) {
      return res.status(401).json({ error: "User not authenticated" });
    }

    const limit = parseLimit(req.query.limit, 8, 20);

    try {
      const contacts = await directPaymentRepo.listRecentContacts(userId, limit);
      return res.json({ contacts, limit });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load recent contacts";
      return res.status(500).json({ error: message });
    }
  });

  router.get("/api/payments/history/:username", requirePrivyUser, async (req, res) => {
    const typedReq = req as RequestWithPrivyUser;
    const userId = typedReq.privyUserId;
    const targetInput = normalizeRecipientInput(req.params.username);
    const limit = parseLimit(req.query.limit, 30, 100);
    const before = typeof req.query.before === "string" && req.query.before.trim().length > 0 ? req.query.before : undefined;

    if (!userId) {
      return res.status(401).json({ error: "User not authenticated" });
    }

    if (!targetInput) {
      return res.status(400).json({ error: "recipient is required" });
    }

    try {
      let targetWalletAddress = normalizeWalletAddress(targetInput);
      let targetUsername: string | null = null;

      if (targetWalletAddress) {
        const userByWalletAddress = await directPaymentRepo.getUserByWalletAddress(targetWalletAddress);
        if (userByWalletAddress) {
          targetWalletAddress = userByWalletAddress.walletAddress;
          targetUsername = userByWalletAddress.username;
        }
      } else {
        const normalizedUsername = normalizeUsernameQuery(targetInput);
        if (!normalizedUsername) {
          return res.status(400).json({ error: "Invalid recipient username or wallet address" });
        }

        const userByUsername = await directPaymentRepo.getUserByUsername(normalizedUsername);
        if (!userByUsername) {
          return res.status(404).json({ error: "Recipient not found" });
        }

        targetWalletAddress = userByUsername.walletAddress;
        targetUsername = userByUsername.username;
      }

      if (!targetWalletAddress) {
        return res.status(400).json({ error: "Invalid recipient username or wallet address" });
      }

      const history = await directPaymentRepo.loadBilateralHistory({
        privyUserId: userId,
        otherWalletAddress: targetWalletAddress,
        limit,
        before,
      });

      return res.json({
        username: targetUsername,
        walletAddress: targetWalletAddress,
        displayName: targetUsername ?? shortenWalletAddressForDisplay(targetWalletAddress),
        history,
        limit,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load payment history";
      return res.status(500).json({ error: message });
    }
  });

  router.post("/api/payments/send", requirePrivyUser, async (req, res) => {
    const typedReq = req as RequestWithPrivyUser;
    const senderUserId = typedReq.privyUserId;

    if (!senderUserId) {
      return res.status(401).json({ error: "User not authenticated" });
    }

    const { recipient, username, walletAddress, amount } = req.body as {
      recipient?: unknown;
      username?: unknown;
      walletAddress?: unknown;
      amount?: unknown;
    };

    const recipientInput = normalizeRecipientInput(recipient ?? walletAddress ?? username);
    const normalizedAmount = normalizeAmount(amount);

    if (!recipientInput) {
      return res.status(400).json({ error: "recipient username or wallet address is required" });
    }

    if (!normalizedAmount) {
      return res.status(400).json({ error: "amount is required" });
    }

    try {
      const [senderProfile, senderWallet] = await Promise.all([
        userProfileRepo.getByPrivyUserId(senderUserId),
        walletRepo.getWalletByPrivyUserId(senderUserId),
      ]);

      if (!senderProfile?.username) {
        return res.status(409).json({ error: "Set username in onboarding before sending payments" });
      }

      if (!senderWallet) {
        return res.status(404).json({ error: "No Starknet wallet found for sender" });
      }

      let recipientWalletAddress = normalizeWalletAddress(recipientInput);
      let recipientUsername: string | null = null;
      let recipientPrivyUserId: string | null = null;

      if (recipientWalletAddress) {
        const recipientByWalletAddress = await directPaymentRepo.getUserByWalletAddress(recipientWalletAddress);
        if (recipientByWalletAddress) {
          recipientWalletAddress = recipientByWalletAddress.walletAddress;
          recipientUsername = recipientByWalletAddress.username;
          recipientPrivyUserId = recipientByWalletAddress.privyUserId;
        }
      } else {
        const recipientUsernameQuery = normalizeUsernameQuery(recipientInput);
        if (!recipientUsernameQuery) {
          return res.status(400).json({ error: "Invalid recipient username or wallet address" });
        }

        const recipientByUsername = await directPaymentRepo.getUserByUsername(recipientUsernameQuery);
        if (!recipientByUsername) {
          return res.status(404).json({ error: "Recipient username not found" });
        }

        recipientWalletAddress = recipientByUsername.walletAddress;
        recipientUsername = recipientByUsername.username;
        recipientPrivyUserId = recipientByUsername.privyUserId;
      }

      if (!recipientWalletAddress) {
        return res.status(400).json({ error: "Invalid recipient username or wallet address" });
      }

      const recipientDisplayName = recipientUsername ?? shortenWalletAddressForDisplay(recipientWalletAddress);

      if (
        recipientPrivyUserId === senderUserId
        || recipientWalletAddress.toLowerCase() === senderWallet.address.toLowerCase()
      ) {
        return res.status(400).json({ error: "You cannot send payment to yourself" });
      }

      const presets = getPresets(chainId);
      const STRK = presets.STRK;

      if (!STRK) {
        return res.status(500).json({ error: "STRK token preset not available for configured chain" });
      }

      const parsedAmount = Amount.parse(normalizedAmount, STRK);
      if (!parsedAmount.isPositive()) {
        return res.status(400).json({ error: "amount must be positive" });
      }

      let userWallet;

      try {
        userWallet = await walletService.ensureWalletReadyForWrites(senderWallet);
      } catch (error) {
        const walletNotReady = walletService.buildWalletNotReadyResponse(error, senderWallet.address);
        return res.status(walletNotReady.statusCode).json(walletNotReady.payload);
      }

      const senderBalance = await userWallet.balanceOf(STRK);
      if (senderBalance.lt(parsedAmount)) {
        return res.status(400).json({
          error: "Insufficient STRK balance",
          hint: `Available balance is ${senderBalance.toUnit()} STRK but requested amount is ${parsedAmount.toUnit()} STRK.`,
        });
      }

      const amountBase = BigInt(parsedAmount.toBase().toString());
      const [amountLow, amountHigh] = toU256Calldata(amountBase);

      const transferCall = {
        contractAddress: STRK.address,
        entrypoint: "transfer",
        calldata: [fromAddress(recipientWalletAddress), amountLow, amountHigh],
      };

      const execution = await walletService.executeWithOogRetry(userWallet, transferCall);

      const amountRaw = amountBase.toString();
      const amountUnit = parsedAmount.toUnit();

      await Promise.all([
        directPaymentRepo.savePayment({
          senderPrivyUserId: senderUserId,
          senderUsername: senderProfile.username,
          senderWalletAddress: senderWallet.address,
          recipientPrivyUserId,
          recipientUsername: recipientDisplayName,
          recipientWalletAddress,
          tokenSymbol: STRK.symbol,
          tokenContractAddress: STRK.address,
          amountRaw,
          amountUnit,
          txHash: execution.txHash,
          explorerUrl: execution.explorerUrl,
          status: "success",
          metadata: {
            source: "direct_payment",
            recipientUsername,
            recipientWalletAddress,
            recipientDisplayName,
            executionMode: execution.executionMode,
          },
        }),
        txActivityRepo.record({
          privyUserId: senderUserId,
          action: "Direct Payment Sent",
          status: "success",
          txHash: execution.txHash,
          explorerUrl: execution.explorerUrl,
          metadata: {
            recipientUsername,
            recipientWalletAddress,
            recipientDisplayName,
            amountRaw,
            amountUnit,
            tokenSymbol: STRK.symbol,
            executionMode: execution.executionMode,
          },
        }),
      ]);

      return res.json({
        message: "Payment transaction submitted",
        recipientUsername,
        recipientDisplayName,
        recipientWalletAddress,
        amountUnit,
        amountRaw,
        tokenSymbol: STRK.symbol,
        txHash: execution.txHash,
        explorerUrl: execution.explorerUrl,
        executionMode: execution.executionMode,
      });
    } catch (error) {
      const rawMessage = getErrorMessage(error);
      const message = sanitizePaymentErrorMessage(rawMessage);
      const hint = buildPaymentHint(rawMessage);

      console.error("Direct payment failed", {
        senderUserId,
        recipientInput,
        amountInput: normalizedAmount,
        details: rawMessage,
      });

      try {
        const senderProfile = await userProfileRepo.getByPrivyUserId(senderUserId);
        if (senderProfile?.username) {
          await txActivityRepo.record({
            privyUserId: senderUserId,
            action: "Direct Payment Sent",
            status: "failed",
            details: message,
            metadata: {
              recipientInput,
              amountInput: normalizedAmount,
            },
          });
        }
      } catch {
        // Ignore logging failures.
      }

      return res.status(isLikelyFundingOrFeeConfigError(rawMessage) ? 402 : 500).json({
        error: message,
        hint,
      });
    }
  });

  return router;
}
