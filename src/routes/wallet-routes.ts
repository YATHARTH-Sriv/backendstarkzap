import { PrivyClient } from "@privy-io/node";
import express, { Router } from "express";
import {
  Amount,
  ArgentXV050Preset,
  ChainId,
  StarkSigner,
  fromAddress,
  getPresets,
  type StarkZap,
} from "starkzap";
import type { OnboardingFundingRepository } from "../db/onboarding-funding-repo.ts";
import type { TxActivityRepository } from "../db/tx-activity-repo.ts";
import type { WalletRecord, WalletRepository } from "../db/wallet-repo.ts";
import type { RequestWithPrivyUser } from "../middleware/require-privy-user.ts";
import { getErrorMessage } from "../services/error-utils.ts";
import { isStarknetFeltHex } from "../services/felt-utils.ts";
import type { StarknetWalletService } from "../services/starknet-wallet.ts";
import {
  createErc20BalanceReader,
  toU256Calldata,
} from "../services/u256-utils.ts";

type FundingStatus =
  | "disabled"
  | "ready_to_fund"
  | "pending"
  | "funded"
  | "failed";

type WalletFundingState = {
  enabled: boolean;
  configured: boolean;
  status: FundingStatus;
  amountStrk: string;
  amountRaw: string;
  tokenAddress: string;
  currentBalanceStrk: string;
  currentBalanceRaw: string;
  canDeploy: boolean;
  txHash: string | null;
  explorerUrl: string | null;
  error: string | null;
};

function sanitizeFundingErrorMessage(rawMessage: string): string {
  const message = rawMessage.trim();

  if (/starknet_addInvokeTransaction/i.test(message)) {
    return "Funding transaction submission was rejected by Starknet RPC";
  }

  if (message.length > 320) {
    return "Onboarding funding failed while submitting transfer";
  }

  return message || "Onboarding funding failed";
}

function buildFundingDisabledError(chainId: ChainId): string {
  return `In-app onboarding funding is disabled for chain ${chainId.toLiteral()}`;
}

export function createWalletRouter(params: {
  sdk: StarkZap;
  chainId: ChainId;
  privy: PrivyClient;
  walletRepo: WalletRepository;
  onboardingFundingRepo: OnboardingFundingRepository;
  requirePrivyUser: express.RequestHandler;
  walletService: StarknetWalletService;
  txActivityRepo: TxActivityRepository;
  onboardingFundingEnabled: boolean;
  onboardingFundingAmountStrk: string;
  onboardingFunderAddress: string | null;
  onboardingFunderPrivateKey: string | null;
}) {
  const {
    sdk,
    chainId,
    privy,
    walletRepo,
    onboardingFundingRepo,
    requirePrivyUser,
    walletService,
    txActivityRepo,
    onboardingFundingEnabled,
    onboardingFundingAmountStrk,
    onboardingFunderAddress,
    onboardingFunderPrivateKey,
  } = params;

  const router = Router();

  const presets = getPresets(chainId);
  const STRK = presets.STRK;

  if (!STRK) {
    throw new Error("STRK token preset not available for configured chain");
  }

  const grantAmount = Amount.parse(onboardingFundingAmountStrk, STRK);
  const grantAmountRaw = BigInt(grantAmount.toBase().toString());
  const readStrkBalance = createErc20BalanceReader(sdk, STRK.address);
  const fundingEnabledOnChain = onboardingFundingEnabled && chainId.isSepolia();
  const normalizedFunderAddress = (() => {
    if (!onboardingFunderAddress) {
      return null;
    }

    try {
      return fromAddress(onboardingFunderAddress);
    } catch {
      return null;
    }
  })();

  const fundingConfigured =
    fundingEnabledOnChain &&
    Boolean(onboardingFunderPrivateKey) &&
    Boolean(normalizedFunderAddress);

  async function ensureWalletRecord(
    userId: string,
  ): Promise<{ wallet: WalletRecord; wasCreated: boolean }> {
    const existing = await walletRepo.getWalletByPrivyUserId(userId);

    if (existing) {
      return { wallet: existing, wasCreated: false };
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

    await txActivityRepo.record({
      privyUserId: userId,
      action: "Wallet Created",
      status: "success",
      details: "Embedded Starknet wallet created",
      metadata: {
        walletId: walletRecord.id,
      },
    });

    return {
      wallet: walletRecord,
      wasCreated: true,
    };
  }

  async function buildFundingState(
    userId: string,
    walletAddress: string,
  ): Promise<WalletFundingState> {
    const [balance, fundingRecord] = await Promise.all([
      readStrkBalance(walletAddress),
      onboardingFundingRepo.getByPrivyUserId(userId),
    ]);

    const balanceAmount = Amount.fromRaw(balance.value, STRK);
    const fundedByBalance = balance.value >= grantAmountRaw;
    const fundedByRecord = fundingRecord?.status === "success";

    let status: FundingStatus;
    let canDeploy: boolean;
    let error: string | null = null;

    if (!fundingEnabledOnChain) {
      status = "disabled";
      canDeploy = true;
    } else if (!fundingConfigured) {
      status = "disabled";
      canDeploy = balance.value > 0n;
      error = "Server onboarding funding is not configured";
    } else if (fundedByBalance || fundedByRecord) {
      status = "funded";
      canDeploy = true;
    } else if (fundingRecord?.status === "pending") {
      status = "pending";
      canDeploy = false;
    } else if (fundingRecord?.status === "failed") {
      status = "failed";
      canDeploy = false;
      error = fundingRecord.errorDetails ?? "Funding transfer failed";
    } else {
      status = "ready_to_fund";
      canDeploy = false;
    }

    return {
      enabled: fundingEnabledOnChain,
      configured: fundingConfigured,
      status,
      amountStrk: grantAmount.toUnit(),
      amountRaw: grantAmountRaw.toString(),
      tokenAddress: STRK.address,
      currentBalanceStrk: balanceAmount.toUnit(),
      currentBalanceRaw: balance.value.toString(),
      canDeploy,
      txHash: fundingRecord?.txHash ?? null,
      explorerUrl: fundingRecord?.explorerUrl ?? null,
      error,
    };
  }

  async function buildOnboardingPayload(userId: string, wallet: WalletRecord) {
    const funding = await buildFundingState(userId, wallet.address);

    const deploymentMessage = funding.canDeploy
      ? "Wallet is funded. Use Deploy/Check to make it transaction-ready."
      : `Fund wallet with ${grantAmount.toUnit()} STRK before deploy.`;

    return {
      wallet,
      deployment: walletService.deploymentResponse(
        false,
        deploymentMessage,
        wallet.address,
      ),
      funding,
    };
  }

  router.post("/api/wallet/starknet", requirePrivyUser, async (req, res) => {
    const typedReq = req as RequestWithPrivyUser;
    const userId = typedReq.privyUserId;

    if (!userId) {
      return res.status(401).json({ error: "User not authenticated" });
    }

    try {
      const { wallet } = await ensureWalletRecord(userId);
      return res.json(await buildOnboardingPayload(userId, wallet));
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Wallet creation failed";
      return res.status(500).json({ error: message });
    }
  });

  router.get(
    "/api/wallet/onboarding-state",
    requirePrivyUser,
    async (req, res) => {
      const typedReq = req as RequestWithPrivyUser;
      const userId = typedReq.privyUserId;

      if (!userId) {
        return res.status(401).json({ error: "User not authenticated" });
      }

      const wallet = await walletRepo.getWalletByPrivyUserId(userId);
      if (!wallet) {
        return res.status(404).json({
          error:
            "No Starknet wallet found for user. Call POST /api/wallet/starknet first.",
        });
      }

      try {
        return res.json(await buildOnboardingPayload(userId, wallet));
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Failed to load onboarding wallet state";
        return res.status(500).json({ error: message });
      }
    },
  );

  router.post(
    "/api/wallet/fund-onboarding",
    requirePrivyUser,
    async (req, res) => {
      const typedReq = req as RequestWithPrivyUser;
      const userId = typedReq.privyUserId;

      if (!userId) {
        return res.status(401).json({ error: "User not authenticated" });
      }

      try {
        const { wallet } = await ensureWalletRecord(userId);
        const fundingState = await buildFundingState(userId, wallet.address);

        if (!fundingState.enabled) {
          return res.status(409).json({
            error: buildFundingDisabledError(chainId),
            wallet,
            funding: fundingState,
          });
        }

        if (
          !fundingState.configured ||
          !normalizedFunderAddress ||
          !onboardingFunderPrivateKey
        ) {
          return res.status(503).json({
            error: "Server onboarding funding is not configured",
            wallet,
            funding: fundingState,
          });
        }

        if (fundingState.canDeploy) {
          return res.json({
            wallet,
            funding: fundingState,
            message: "Wallet already has onboarding funding",
          });
        }

        if (fundingState.status === "pending") {
          return res.status(202).json({
            wallet,
            funding: fundingState,
            message: "Funding transaction is pending confirmation",
          });
        }

        await onboardingFundingRepo.upsertPending({
          privyUserId: userId,
          walletAddress: wallet.address,
          tokenContractAddress: STRK.address,
          amountRaw: grantAmountRaw.toString(),
          amountStrk: grantAmount.toUnit(),
          fundedByAddress: normalizedFunderAddress,
        });

        try {
          const funderWallet = await sdk.connectWallet({
            account: {
              signer: new StarkSigner(onboardingFunderPrivateKey),
              accountClass: ArgentXV050Preset,
            },
            accountAddress: normalizedFunderAddress,
            feeMode: "user_pays",
          });

          await funderWallet.ensureReady({
            deploy: "never",
          });

          const [amountLow, amountHigh] = toU256Calldata(grantAmountRaw);

          const execution = await walletService.executeWithOogRetry(
            funderWallet,
            {
              contractAddress: STRK.address,
              entrypoint: "transfer",
              calldata: [fromAddress(wallet.address), amountLow, amountHigh],
            },
          );

          await onboardingFundingRepo.markSuccess({
            privyUserId: userId,
            walletAddress: wallet.address,
            tokenContractAddress: STRK.address,
            amountRaw: grantAmountRaw.toString(),
            amountStrk: grantAmount.toUnit(),
            txHash: execution.txHash,
            explorerUrl: execution.explorerUrl,
            fundedByAddress: normalizedFunderAddress,
          });

          await txActivityRepo.record({
            privyUserId: userId,
            action: "Wallet Funded",
            status: "success",
            txHash: execution.txHash,
            explorerUrl: execution.explorerUrl,
            details: `Granted ${grantAmount.toUnit()} STRK for onboarding`,
            metadata: {
              walletId: wallet.id,
              fundedByAddress: normalizedFunderAddress,
              tokenAddress: STRK.address,
              amountRaw: grantAmountRaw.toString(),
              amountUnit: grantAmount.toUnit(),
              executionMode: execution.executionMode,
            },
          });

          return res.json({
            wallet,
            funding: await buildFundingState(userId, wallet.address),
            transaction: execution,
          });
        } catch (error) {
          const message = sanitizeFundingErrorMessage(getErrorMessage(error));

          await onboardingFundingRepo.markFailed({
            privyUserId: userId,
            walletAddress: wallet.address,
            tokenContractAddress: STRK.address,
            amountRaw: grantAmountRaw.toString(),
            amountStrk: grantAmount.toUnit(),
            errorDetails: message,
            fundedByAddress: normalizedFunderAddress,
          });

          await txActivityRepo.record({
            privyUserId: userId,
            action: "Wallet Funded",
            status: "failed",
            details: message,
            metadata: {
              walletId: wallet.id,
              fundedByAddress: normalizedFunderAddress,
              tokenAddress: STRK.address,
              amountRaw: grantAmountRaw.toString(),
              amountUnit: grantAmount.toUnit(),
            },
          });

          return res.status(502).json({
            error: message,
            wallet,
            funding: await buildFundingState(userId, wallet.address),
          });
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Onboarding funding failed";
        return res.status(500).json({ error: message });
      }
    },
  );

  router.post("/api/wallet/deploy", requirePrivyUser, async (req, res) => {
    const typedReq = req as RequestWithPrivyUser;
    const userId = typedReq.privyUserId;

    if (!userId) {
      return res.status(401).json({ error: "User not authenticated" });
    }

    const wallet = await walletRepo.getWalletByPrivyUserId(userId);
    if (!wallet) {
      return res.status(404).json({
        error:
          "No Starknet wallet found for user. Call POST /api/wallet/starknet first.",
      });
    }

    const funding = await buildFundingState(userId, wallet.address);

    if (funding.enabled && funding.configured && !funding.canDeploy) {
      return res.status(409).json({
        error: `Fund wallet with at least ${funding.amountStrk} STRK before deploy`,
        wallet,
        funding,
        deployment: walletService.deploymentResponse(
          false,
          `Fund wallet with ${funding.amountStrk} STRK before deploy.`,
          wallet.address,
        ),
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
        funding,
        deployment: walletService.deploymentResponse(
          true,
          undefined,
          wallet.address,
        ),
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
        funding,
        deployment: walletService.deploymentResponse(
          false,
          message,
          wallet.address,
        ),
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
        error:
          "hash must be a valid Starknet felt (0x-prefixed hex and within Stark field range)",
      });
    }

    const wallet = await walletRepo.getWalletByPrivyUserId(userId);
    if (!wallet || wallet.id !== walletId) {
      return res
        .status(403)
        .json({ error: "Wallet does not belong to authenticated user" });
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
