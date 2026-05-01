import express, { Router } from "express";
import {
  Amount,
  ChainId,
  fromAddress,
  getPresets,
  type StarkZap,
  type Token,
} from "starkzap";
import type { TxActivityRepository } from "../db/tx-activity-repo.ts";
import type { WalletRepository } from "../db/wallet-repo.ts";
import type { RequestWithPrivyUser } from "../middleware/require-privy-user.ts";
import {
  getErrorMessage,
  isLikelyFundingOrFeeConfigError,
} from "../services/error-utils.ts";
import type { StarknetWalletService } from "../services/starknet-wallet.ts";

type SwapTokenSymbol = "STRK" | "USDC";
type SwapProviderId = "avnu" | "ekubo";
type ParsedSwapRequest = {
  inputSymbol: SwapTokenSymbol;
  outputSymbol: SwapTokenSymbol;
  inputToken: Token;
  outputToken: Token;
  parsedAmount: Amount;
  normalizedProvider: SwapProviderId | undefined;
  normalizedSlippageBps: bigint;
};

const TOKEN_SYMBOLS = new Set<SwapTokenSymbol>(["STRK", "USDC"]);
const PROVIDERS = new Set<SwapProviderId>(["avnu", "ekubo"]);

function normalizeToken(raw: unknown): SwapTokenSymbol | null {
  if (typeof raw !== "string") {
    return null;
  }

  const upper = raw.trim().toUpperCase();
  return TOKEN_SYMBOLS.has(upper as SwapTokenSymbol)
    ? (upper as SwapTokenSymbol)
    : null;
}

function normalizeAmount(raw: unknown): string {
  return typeof raw === "string" ? raw.trim() : "";
}

function normalizeProvider(raw: unknown): SwapProviderId | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }

  const lower = raw.trim().toLowerCase();
  return PROVIDERS.has(lower as SwapProviderId)
    ? (lower as SwapProviderId)
    : undefined;
}

function normalizeSlippageBps(raw: unknown): bigint {
  if (raw === undefined || raw === null || raw === "") {
    return 50n;
  }

  const parsed =
    typeof raw === "number"
      ? raw
      : typeof raw === "string"
        ? Number(raw.trim())
        : Number.NaN;

  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 500) {
    throw new Error("slippageBps must be between 1 and 500");
  }

  return BigInt(Math.trunc(parsed));
}

function tokenForSymbol(
  symbol: SwapTokenSymbol,
  tokens: { STRK?: Token; USDC?: Token },
): Token | null {
  return symbol === "STRK" ? tokens.STRK ?? null : tokens.USDC ?? null;
}

function quotePayload(params: {
  tokenIn: Token;
  tokenOut: Token;
  amountIn: Amount;
  amountOutBase: bigint;
  amountInBase: bigint;
  provider?: string;
  priceImpactBps?: bigint | null;
  routeCallCount?: number;
  slippageBps: bigint;
}) {
  const amountOut = Amount.fromRaw(params.amountOutBase, params.tokenOut);
  const quotedAmountIn = Amount.fromRaw(params.amountInBase, params.tokenIn);

  return {
    tokenIn: {
      symbol: params.tokenIn.symbol,
      address: params.tokenIn.address,
      decimals: params.tokenIn.decimals,
    },
    tokenOut: {
      symbol: params.tokenOut.symbol,
      address: params.tokenOut.address,
      decimals: params.tokenOut.decimals,
    },
    amountIn: quotedAmountIn.toUnit(),
    amountInRaw: params.amountInBase.toString(),
    amountOut: amountOut.toUnit(),
    amountOutRaw: params.amountOutBase.toString(),
    amountOutFormatted: amountOut.toFormatted(true),
    provider: params.provider ?? "avnu",
    priceImpactBps: params.priceImpactBps?.toString() ?? null,
    routeCallCount: params.routeCallCount ?? null,
    slippageBps: params.slippageBps.toString(),
  };
}

function sanitizeSwapErrorMessage(rawMessage: string): string {
  const message = rawMessage.trim();

  if (/starknet_addInvokeTransaction/i.test(message)) {
    return "Swap transaction submission was rejected by Starknet RPC";
  }

  if (/returned no calls|no route|could not build/i.test(message)) {
    return "No swap route found for this pair and amount";
  }

  if (message.length > 320) {
    return "Swap failed on chain";
  }

  return message || "Swap failed";
}

function buildSwapHint(rawMessage: string): string | undefined {
  const message = rawMessage.trim();

  if (
    /starknet_addInvokeTransaction/i.test(message) ||
    isLikelyFundingOrFeeConfigError(message)
  ) {
    return "Ensure the wallet has enough token balance plus network fees, then retry.";
  }

  if (/returned no calls|no route|could not build/i.test(message)) {
    return "Try a smaller amount or switch the route provider.";
  }

  return undefined;
}

async function getQuoteWithFallback(params: {
  userWallet: Awaited<ReturnType<StarknetWalletService["getUserWalletInterface"]>>;
  parsed: ParsedSwapRequest;
}) {
  const { userWallet, parsed } = params;
  const providerOrder: Array<SwapProviderId | undefined> = parsed.normalizedProvider
    ? [parsed.normalizedProvider]
    : ["avnu", "ekubo"];
  const failures: string[] = [];

  for (const provider of providerOrder) {
    try {
      const quote = await userWallet.getQuote({
        tokenIn: parsed.inputToken,
        tokenOut: parsed.outputToken,
        amountIn: parsed.parsedAmount,
        slippageBps: parsed.normalizedSlippageBps,
        provider,
      });

      return {
        quote,
        provider,
      };
    } catch (error) {
      failures.push(`${provider ?? "default"}: ${getErrorMessage(error)}`);
    }
  }

  throw new Error(failures.join(" | "));
}

async function prepareSwapWithFallback(params: {
  userWallet: Awaited<ReturnType<StarknetWalletService["getUserWalletInterface"]>>;
  parsed: ParsedSwapRequest;
}) {
  const { userWallet, parsed } = params;
  const providerOrder: Array<SwapProviderId | undefined> = parsed.normalizedProvider
    ? [parsed.normalizedProvider]
    : ["avnu", "ekubo"];
  const failures: string[] = [];

  for (const provider of providerOrder) {
    try {
      const prepared = await userWallet.prepareSwap({
        tokenIn: parsed.inputToken,
        tokenOut: parsed.outputToken,
        amountIn: parsed.parsedAmount,
        slippageBps: parsed.normalizedSlippageBps,
        provider,
      });

      return {
        prepared,
        provider,
      };
    } catch (error) {
      failures.push(`${provider ?? "default"}: ${getErrorMessage(error)}`);
    }
  }

  throw new Error(failures.join(" | "));
}

export function createSwapRouter(params: {
  sdk: StarkZap;
  chainId: ChainId;
  requirePrivyUser: express.RequestHandler;
  walletRepo: WalletRepository;
  walletService: StarknetWalletService;
  txActivityRepo: TxActivityRepository;
}) {
  const {
    chainId,
    requirePrivyUser,
    walletRepo,
    walletService,
    txActivityRepo,
  } = params;

  const router = Router();
  const presets = getPresets(chainId);
  const STRK = presets.STRK;
  const USDC = presets.USDC;

  if (!STRK || !USDC) {
    throw new Error("STRK and USDC token presets are required for swaps");
  }

  function parseSwapRequest(req: express.Request): ParsedSwapRequest {
    const { tokenIn, tokenOut, amount, slippageBps, provider } = req.body as {
      tokenIn?: unknown;
      tokenOut?: unknown;
      amount?: unknown;
      slippageBps?: unknown;
      provider?: unknown;
    };

    const inputSymbol = normalizeToken(tokenIn);
    const outputSymbol = normalizeToken(tokenOut);
    const normalizedAmount = normalizeAmount(amount);
    const normalizedProvider = normalizeProvider(provider);
    const normalizedSlippageBps = normalizeSlippageBps(slippageBps);

    if (!inputSymbol || !outputSymbol) {
      throw new Error("tokenIn and tokenOut must be STRK or USDC");
    }

    if (inputSymbol === outputSymbol) {
      throw new Error("tokenIn and tokenOut must be different");
    }

    if (!normalizedAmount) {
      throw new Error("amount is required");
    }

    const inputToken = tokenForSymbol(inputSymbol, { STRK, USDC });
    const outputToken = tokenForSymbol(outputSymbol, { STRK, USDC });

    if (!inputToken || !outputToken) {
      throw new Error("Unsupported token pair");
    }

    const parsedAmount = Amount.parse(normalizedAmount, inputToken);
    if (!parsedAmount.isPositive()) {
      throw new Error("amount must be positive");
    }

    return {
      inputSymbol,
      outputSymbol,
      inputToken,
      outputToken,
      parsedAmount,
      normalizedProvider,
      normalizedSlippageBps,
    };
  }

  router.post("/api/swap/quote", requirePrivyUser, async (req, res) => {
    const typedReq = req as RequestWithPrivyUser;
    const userId = typedReq.privyUserId;

    if (!userId) {
      return res.status(401).json({ error: "User not authenticated" });
    }

    try {
      const wallet = await walletRepo.getWalletByPrivyUserId(userId);
      if (!wallet) {
        return res.status(404).json({
          error: "No Starknet wallet found for user. Call POST /api/wallet/starknet first.",
        });
      }

      const parsed = parseSwapRequest(req);

      fromAddress(wallet.address);
      const userWallet = await walletService.getUserWalletInterface(wallet);
      const { quote, provider } = await getQuoteWithFallback({
        userWallet,
        parsed,
      });

      return res.json(
        quotePayload({
          tokenIn: parsed.inputToken,
          tokenOut: parsed.outputToken,
          amountIn: parsed.parsedAmount,
          amountInBase: quote.amountInBase,
          amountOutBase: quote.amountOutBase,
          provider: quote.provider ?? provider,
          priceImpactBps: quote.priceImpactBps,
          routeCallCount: quote.routeCallCount,
          slippageBps: parsed.normalizedSlippageBps,
        }),
      );
    } catch (error) {
      const rawMessage = getErrorMessage(error);
      const message = sanitizeSwapErrorMessage(rawMessage);
      const statusCode = /must be|amount is|required|Unsupported/i.test(message)
        ? 400
        : 500;
      return res.status(statusCode).json({
        error: message,
        hint: buildSwapHint(rawMessage),
      });
    }
  });

  router.post("/api/swap/execute", requirePrivyUser, async (req, res) => {
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

    let parsed:
      | Awaited<ReturnType<typeof parseSwapRequest>>
      | null = null;

    try {
      parsed = parseSwapRequest(req);

      let userWallet;
      try {
        userWallet = await walletService.ensureWalletReadyForWrites(wallet);
      } catch (error) {
        const walletNotReady = walletService.buildWalletNotReadyResponse(
          error,
          wallet.address,
        );
        return res
          .status(walletNotReady.statusCode)
          .json(walletNotReady.payload);
      }

      const senderBalance = await userWallet.balanceOf(parsed.inputToken);
      if (senderBalance.lt(parsed.parsedAmount)) {
        return res.status(400).json({
          error: `Insufficient ${parsed.inputToken.symbol} balance`,
          hint: `Available balance is ${senderBalance.toUnit()} ${parsed.inputToken.symbol} but requested amount is ${parsed.parsedAmount.toUnit()} ${parsed.inputToken.symbol}.`,
        });
      }

      const { prepared, provider } = await prepareSwapWithFallback({
        userWallet,
        parsed,
      });

      const execution = await walletService.executeCallsWithOogRetry(
        userWallet,
        prepared.calls,
      );

      const responseQuote = quotePayload({
        tokenIn: parsed.inputToken,
        tokenOut: parsed.outputToken,
        amountIn: parsed.parsedAmount,
        amountInBase: prepared.quote.amountInBase,
        amountOutBase: prepared.quote.amountOutBase,
        provider: prepared.quote.provider ?? provider,
        priceImpactBps: prepared.quote.priceImpactBps,
        routeCallCount: prepared.quote.routeCallCount,
        slippageBps: parsed.normalizedSlippageBps,
      });

      await txActivityRepo.record({
        privyUserId: userId,
        action: "Swap Executed",
        status: "success",
        txHash: execution.txHash,
        explorerUrl: execution.explorerUrl,
        details: `${responseQuote.amountIn} ${parsed.inputToken.symbol} to ${responseQuote.amountOut} ${parsed.outputToken.symbol}`,
        metadata: {
          source: "swap",
          tokenIn: parsed.inputToken.symbol,
          tokenOut: parsed.outputToken.symbol,
          amountIn: responseQuote.amountIn,
          amountInRaw: responseQuote.amountInRaw,
          amountOut: responseQuote.amountOut,
          amountOutRaw: responseQuote.amountOutRaw,
          provider: responseQuote.provider,
          priceImpactBps: responseQuote.priceImpactBps,
          slippageBps: responseQuote.slippageBps,
          executionMode: execution.executionMode,
        },
      });

      return res.json({
        message: "Swap transaction submitted",
        ...responseQuote,
        txHash: execution.txHash,
        explorerUrl: execution.explorerUrl,
        executionMode: execution.executionMode,
      });
    } catch (error) {
      const rawMessage = getErrorMessage(error);
      const message = sanitizeSwapErrorMessage(rawMessage);
      const hint = buildSwapHint(rawMessage);

      console.error("Swap failed", {
        userId,
        walletId: wallet.id,
        tokenIn: parsed?.inputToken.symbol,
        tokenOut: parsed?.outputToken.symbol,
        amount: parsed?.parsedAmount.toUnit(),
        details: rawMessage,
      });

      await txActivityRepo.record({
        privyUserId: userId,
        action: "Swap Executed",
        status: "failed",
        details: message,
        metadata: {
          tokenIn: parsed?.inputToken.symbol,
          tokenOut: parsed?.outputToken.symbol,
          amount: parsed?.parsedAmount.toUnit(),
        },
      });

      const statusCode = /must be|amount is|required|Unsupported|Insufficient/i.test(
        message,
      )
        ? 400
        : isLikelyFundingOrFeeConfigError(rawMessage)
          ? 402
          : 500;

      return res.status(statusCode).json({
        error: message,
        hint,
      });
    }
  });

  return router;
}
