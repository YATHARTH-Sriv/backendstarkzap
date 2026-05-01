import express, { Router } from "express";
import {
  Amount,
  ChainId,
  fromAddress,
  getPresets,
  mainnetValidators,
  sepoliaValidators,
  type Address,
  type Pool,
  type PoolMember,
  type StarkZap,
  type Validator,
} from "starkzap";
import type { TxActivityRepository } from "../db/tx-activity-repo.ts";
import type { WalletRepository } from "../db/wallet-repo.ts";
import type { RequestWithPrivyUser } from "../middleware/require-privy-user.ts";
import {
  getErrorMessage,
  isLikelyFundingOrFeeConfigError,
} from "../services/error-utils.ts";
import type { StarknetWalletService } from "../services/starknet-wallet.ts";

const DEFAULT_SEPOLIA_STRK_POOL =
  "0x03588c95936917c9e6ba35e667ea33df501f595eb444301f7ecf1742a66f4676" as Address;

function normalizeAmount(raw: unknown): string {
  return typeof raw === "string" ? raw.trim() : "";
}

function normalizePool(raw: unknown): Address | null {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return null;
  }

  try {
    return fromAddress(raw.trim());
  } catch {
    return null;
  }
}

function toAmountPayload(amount: Amount) {
  return {
    unit: amount.toUnit(),
    raw: amount.toBase().toString(),
    formatted: amount.toFormatted(true),
  };
}

function toPositionPayload(position: PoolMember | null) {
  if (!position) {
    return null;
  }

  return {
    staked: toAmountPayload(position.staked),
    rewards: toAmountPayload(position.rewards),
    total: toAmountPayload(position.total),
    unpooling: toAmountPayload(position.unpooling),
    unpoolTime: position.unpoolTime?.toISOString() ?? null,
    commissionPercent: position.commissionPercent,
    rewardAddress: position.rewardAddress,
  };
}

function toPoolPayload(pool: Pool, validator?: Validator) {
  return {
    poolContract: pool.poolContract,
    token: {
      symbol: pool.token.symbol,
      name: pool.token.name,
      address: pool.token.address,
      decimals: pool.token.decimals,
    },
    delegated: toAmountPayload(pool.amount),
    validator: validator
      ? {
          name: validator.name,
          stakerAddress: validator.stakerAddress,
          logoUrl: validator.logoUrl?.toString() ?? null,
        }
      : null,
  };
}

function sanitizeDefiErrorMessage(rawMessage: string): string {
  const message = rawMessage.trim();

  if (/starknet_addInvokeTransaction/i.test(message)) {
    return "Staking transaction submission was rejected by Starknet RPC";
  }

  if (message.length > 320) {
    return "Staking operation failed on chain";
  }

  return message || "Staking operation failed";
}

function buildDefiHint(rawMessage: string): string | undefined {
  if (isLikelyFundingOrFeeConfigError(rawMessage)) {
    return "Ensure your wallet has enough STRK for the action and network fees.";
  }

  return undefined;
}

export function createDefiRouter(params: {
  sdk: StarkZap;
  chainId: ChainId;
  requirePrivyUser: express.RequestHandler;
  walletRepo: WalletRepository;
  walletService: StarknetWalletService;
  txActivityRepo: TxActivityRepository;
  estimatedApy: number;
  fallbackPoolAddress: string;
}) {
  const {
    sdk,
    chainId,
    requirePrivyUser,
    walletRepo,
    walletService,
    txActivityRepo,
    estimatedApy,
    fallbackPoolAddress,
  } = params;

  const router = Router();
  const presets = getPresets(chainId);
  const STRK = presets.STRK;
  const validators = chainId.isMainnet() ? mainnetValidators : sepoliaValidators;
  const validatorEntries = Object.values(validators);

  if (!STRK) {
    throw new Error("STRK token preset is required for staking");
  }

  async function getAuthenticatedWallet(userId: string) {
    const wallet = await walletRepo.getWalletByPrivyUserId(userId);
    if (!wallet) {
      return null;
    }
    return wallet;
  }

  async function discoverStrkPools(limit = 8) {
    const pools: ReturnType<typeof toPoolPayload>[] = [];

    for (const validator of validatorEntries) {
      if (pools.length >= limit) {
        break;
      }

      try {
        const validatorPools = await sdk.getStakerPools(validator.stakerAddress);
        const strkPool = validatorPools.find((pool) => pool.token.symbol === "STRK");
        if (strkPool) {
          pools.push(toPoolPayload(strkPool, validator));
        }
      } catch (error) {
        console.warn(`Failed to load pools for ${validator.name}`, getErrorMessage(error));
      }
    }

    return pools;
  }

  async function loadPrimaryPool() {
    const discovered = await discoverStrkPools(8);
    const configuredPool = chainId.isSepolia()
      ? discovered.find((pool) => pool.poolContract === fromAddress(fallbackPoolAddress))
      : undefined;

    return {
      primaryPool:
        configuredPool ??
        discovered[0] ??
        toPoolPayload(
          {
            poolContract: fromAddress(fallbackPoolAddress),
            token: STRK,
            amount: Amount.fromRaw(0n, STRK),
          },
          undefined,
        ),
      pools: discovered,
    };
  }

  router.get("/api/defi/staking/summary", requirePrivyUser, async (req, res) => {
    const typedReq = req as RequestWithPrivyUser;
    const userId = typedReq.privyUserId;

    if (!userId) {
      return res.status(401).json({ error: "User not authenticated" });
    }

    const wallet = await getAuthenticatedWallet(userId);
    if (!wallet) {
      return res.status(404).json({
        error: "No Starknet wallet found for user. Call POST /api/wallet/starknet first.",
      });
    }

    try {
      const [{ primaryPool, pools }, userWallet] = await Promise.all([
        loadPrimaryPool(),
        walletService.getUserWalletInterface(wallet),
      ]);

      const [walletBalance, position] = await Promise.all([
        userWallet.balanceOf(STRK),
        userWallet.getPoolPosition(primaryPool.poolContract as Address).catch(() => null),
      ]);

      const rewardsUnit = Number(position?.rewards.toUnit() ?? "0") || 0;
      const stakedUnit = Number(position?.staked.toUnit() ?? "0") || 0;
      const projectedYearlyRewards = stakedUnit * (estimatedApy / 100);

      return res.json({
        chainId: chainId.toLiteral(),
        walletAddress: wallet.address,
        token: {
          symbol: STRK.symbol,
          name: STRK.name,
          address: STRK.address,
          decimals: STRK.decimals,
        },
        walletBalance: toAmountPayload(walletBalance),
        primaryPool,
        pools,
        position: toPositionPayload(position),
        stats: {
          estimatedApy,
          projectedYearlyRewards: projectedYearlyRewards.toFixed(4),
          rewardsUnit: rewardsUnit.toString(),
        },
      });
    } catch (error) {
      const message = sanitizeDefiErrorMessage(getErrorMessage(error));
      return res.status(500).json({
        error: message,
        hint: buildDefiHint(getErrorMessage(error)),
      });
    }
  });

  router.post("/api/defi/staking/stake", requirePrivyUser, async (req, res) => {
    const typedReq = req as RequestWithPrivyUser;
    const userId = typedReq.privyUserId;
    const amountInput = normalizeAmount((req.body as { amount?: unknown }).amount);
    const poolAddress = normalizePool((req.body as { poolAddress?: unknown }).poolAddress);

    if (!userId) {
      return res.status(401).json({ error: "User not authenticated" });
    }

    if (!poolAddress) {
      return res.status(400).json({ error: "poolAddress is required" });
    }

    if (!amountInput) {
      return res.status(400).json({ error: "amount is required" });
    }

    const wallet = await getAuthenticatedWallet(userId);
    if (!wallet) {
      return res.status(404).json({ error: "No Starknet wallet found for user" });
    }

    try {
      const amount = Amount.parse(amountInput, STRK);
      if (!amount.isPositive()) {
        return res.status(400).json({ error: "amount must be positive" });
      }

      const userWallet = await walletService.ensureWalletReadyForWrites(wallet);
      const balance = await userWallet.balanceOf(STRK);
      if (balance.lt(amount)) {
        return res.status(400).json({
          error: "Insufficient STRK balance",
          hint: `Available balance is ${balance.toUnit()} STRK but requested amount is ${amount.toUnit()} STRK.`,
        });
      }

      const tx = await userWallet.stake(poolAddress, amount);

      await txActivityRepo.record({
        privyUserId: userId,
        action: "Stake Deposited",
        status: "success",
        txHash: tx.hash,
        explorerUrl: tx.explorerUrl,
        details: `Staked ${amount.toUnit()} STRK`,
        metadata: {
          poolAddress,
          amountRaw: amount.toBase().toString(),
          amountUnit: amount.toUnit(),
          tokenSymbol: STRK.symbol,
        },
      });

      return res.json({
        message: "Stake transaction submitted",
        txHash: tx.hash,
        explorerUrl: tx.explorerUrl,
        amount: toAmountPayload(amount),
        poolAddress,
      });
    } catch (error) {
      const rawMessage = getErrorMessage(error);
      const message = sanitizeDefiErrorMessage(rawMessage);

      await txActivityRepo.record({
        privyUserId: userId,
        action: "Stake Deposited",
        status: "failed",
        details: message,
        metadata: { poolAddress, amountInput },
      });

      return res.status(isLikelyFundingOrFeeConfigError(rawMessage) ? 402 : 500).json({
        error: message,
        hint: buildDefiHint(rawMessage),
      });
    }
  });

  router.post("/api/defi/staking/claim", requirePrivyUser, async (req, res) => {
    const typedReq = req as RequestWithPrivyUser;
    const userId = typedReq.privyUserId;
    const poolAddress = normalizePool((req.body as { poolAddress?: unknown }).poolAddress);

    if (!userId) {
      return res.status(401).json({ error: "User not authenticated" });
    }

    if (!poolAddress) {
      return res.status(400).json({ error: "poolAddress is required" });
    }

    const wallet = await getAuthenticatedWallet(userId);
    if (!wallet) {
      return res.status(404).json({ error: "No Starknet wallet found for user" });
    }

    try {
      const userWallet = await walletService.ensureWalletReadyForWrites(wallet);
      const position = await userWallet.getPoolPosition(poolAddress);
      if (!position || position.rewards.isZero()) {
        return res.status(400).json({ error: "No staking rewards available to claim" });
      }

      const tx = await userWallet.claimPoolRewards(poolAddress);

      await txActivityRepo.record({
        privyUserId: userId,
        action: "Stake Rewards Claimed",
        status: "success",
        txHash: tx.hash,
        explorerUrl: tx.explorerUrl,
        details: `Claimed ${position.rewards.toUnit()} STRK`,
        metadata: {
          poolAddress,
          rewardsRaw: position.rewards.toBase().toString(),
          rewardsUnit: position.rewards.toUnit(),
        },
      });

      return res.json({
        message: "Rewards claim transaction submitted",
        txHash: tx.hash,
        explorerUrl: tx.explorerUrl,
        rewards: toAmountPayload(position.rewards),
        poolAddress,
      });
    } catch (error) {
      const rawMessage = getErrorMessage(error);
      const message = sanitizeDefiErrorMessage(rawMessage);
      await txActivityRepo.record({
        privyUserId: userId,
        action: "Stake Rewards Claimed",
        status: "failed",
        details: message,
        metadata: { poolAddress },
      });

      return res.status(isLikelyFundingOrFeeConfigError(rawMessage) ? 402 : 500).json({
        error: message,
        hint: buildDefiHint(rawMessage),
      });
    }
  });

  router.post("/api/defi/staking/exit-intent", requirePrivyUser, async (req, res) => {
    const typedReq = req as RequestWithPrivyUser;
    const userId = typedReq.privyUserId;
    const amountInput = normalizeAmount((req.body as { amount?: unknown }).amount);
    const poolAddress = normalizePool((req.body as { poolAddress?: unknown }).poolAddress);

    if (!userId) {
      return res.status(401).json({ error: "User not authenticated" });
    }

    if (!poolAddress) {
      return res.status(400).json({ error: "poolAddress is required" });
    }

    if (!amountInput) {
      return res.status(400).json({ error: "amount is required" });
    }

    const wallet = await getAuthenticatedWallet(userId);
    if (!wallet) {
      return res.status(404).json({ error: "No Starknet wallet found for user" });
    }

    try {
      const amount = Amount.parse(amountInput, STRK);
      if (!amount.isPositive()) {
        return res.status(400).json({ error: "amount must be positive" });
      }

      const userWallet = await walletService.ensureWalletReadyForWrites(wallet);
      const position = await userWallet.getPoolPosition(poolAddress);
      if (!position || position.staked.lt(amount)) {
        return res.status(400).json({ error: "Insufficient staked STRK" });
      }

      const tx = await userWallet.exitPoolIntent(poolAddress, amount);

      await txActivityRepo.record({
        privyUserId: userId,
        action: "Stake Withdrawal Started",
        status: "success",
        txHash: tx.hash,
        explorerUrl: tx.explorerUrl,
        details: `Started withdrawal for ${amount.toUnit()} STRK`,
        metadata: {
          poolAddress,
          amountRaw: amount.toBase().toString(),
          amountUnit: amount.toUnit(),
        },
      });

      return res.json({
        message: "Withdrawal intent transaction submitted",
        txHash: tx.hash,
        explorerUrl: tx.explorerUrl,
        amount: toAmountPayload(amount),
        poolAddress,
      });
    } catch (error) {
      const rawMessage = getErrorMessage(error);
      const message = sanitizeDefiErrorMessage(rawMessage);
      await txActivityRepo.record({
        privyUserId: userId,
        action: "Stake Withdrawal Started",
        status: "failed",
        details: message,
        metadata: { poolAddress, amountInput },
      });

      return res.status(isLikelyFundingOrFeeConfigError(rawMessage) ? 402 : 500).json({
        error: message,
        hint: buildDefiHint(rawMessage),
      });
    }
  });

  router.post("/api/defi/staking/exit", requirePrivyUser, async (req, res) => {
    const typedReq = req as RequestWithPrivyUser;
    const userId = typedReq.privyUserId;
    const poolAddress = normalizePool((req.body as { poolAddress?: unknown }).poolAddress);

    if (!userId) {
      return res.status(401).json({ error: "User not authenticated" });
    }

    if (!poolAddress) {
      return res.status(400).json({ error: "poolAddress is required" });
    }

    const wallet = await getAuthenticatedWallet(userId);
    if (!wallet) {
      return res.status(404).json({ error: "No Starknet wallet found for user" });
    }

    try {
      const userWallet = await walletService.ensureWalletReadyForWrites(wallet);
      const position = await userWallet.getPoolPosition(poolAddress);
      if (!position?.unpoolTime || new Date() < position.unpoolTime) {
        return res.status(400).json({ error: "Withdrawal is not ready to complete yet" });
      }

      const tx = await userWallet.exitPool(poolAddress);

      await txActivityRepo.record({
        privyUserId: userId,
        action: "Stake Withdrawal Completed",
        status: "success",
        txHash: tx.hash,
        explorerUrl: tx.explorerUrl,
        details: "Completed staking withdrawal",
        metadata: { poolAddress },
      });

      return res.json({
        message: "Withdrawal completion transaction submitted",
        txHash: tx.hash,
        explorerUrl: tx.explorerUrl,
        poolAddress,
      });
    } catch (error) {
      const rawMessage = getErrorMessage(error);
      const message = sanitizeDefiErrorMessage(rawMessage);
      await txActivityRepo.record({
        privyUserId: userId,
        action: "Stake Withdrawal Completed",
        status: "failed",
        details: message,
        metadata: { poolAddress },
      });

      return res.status(isLikelyFundingOrFeeConfigError(rawMessage) ? 402 : 500).json({
        error: message,
        hint: buildDefiHint(rawMessage),
      });
    }
  });

  return router;
}
