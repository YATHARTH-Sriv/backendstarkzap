import express, { Router } from "express";
import type { Call, StarkZap } from "starkzap";
import { Amount, mainnetTokens, sepoliaTokens, ChainId, fromAddress } from "starkzap";
import type { TxActivityRepository } from "../db/tx-activity-repo.ts";
import type { WalletRecord, WalletRepository } from "../db/wallet-repo.ts";
import type { RequestWithPrivyUser } from "../middleware/require-privy-user.ts";
import { getErrorMessage } from "../services/error-utils.ts";
import {
  STARK_FIELD_PRIME,
  parseNonNegativeIntAsBigInt,
  parsePositiveIntAsBigInt,
  stringToFelt252,
  felt252ToString,
  toFeltHex,
} from "../services/felt-utils.ts";
import type { StarknetWalletService } from "../services/starknet-wallet.ts";
import { createErc20BalanceReader, toU256Calldata } from "../services/u256-utils.ts";

export function createPredictionRouter(params: {
  sdk: StarkZap;
  chainId: ChainId;
  predictionContractAddress: string;
  strkTokenContractAddress: string;
  requirePrivyUser: express.RequestHandler;
  walletRepo: WalletRepository;
  walletService: StarknetWalletService;
  txActivityRepo: TxActivityRepository;
}) {
  const {
    sdk,
    chainId,
    predictionContractAddress,
    strkTokenContractAddress,
    requirePrivyUser,
    walletRepo,
    walletService,
    txActivityRepo,
  } = params;
  const router = Router();

  const tokens = chainId.isMainnet() ? mainnetTokens : sepoliaTokens;
  const STRK = tokens.STRK;
  const USDC = tokens.USDC;

  console.log(`Prediction Router initialized on ${chainId.isMainnet() ? "Mainnet" : "Sepolia"}`);
  console.log(`STRK: ${STRK.address}, USDC: ${USDC.address}`);

  const readStrkBalance = createErc20BalanceReader(sdk, STRK.address);
  const readUsdcBalance = createErc20BalanceReader(sdk, USDC.address);

  async function fetchStrkMarketPriceUsd(): Promise<string> {
    try {
      const apiKey = process.env.COINMARKET_API_KEY;
      if (!apiKey) {
        console.warn("COINMARKET_API_KEY not found in environment variables");
        return "0";
      }

      // Using the exact structure provided by the user's curl command
      const response = await fetch(
        "https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest?id=22691&convert=USD",
        {
          headers: {
            "Accept": "application/json",
            "X-CMC_PRO_API_KEY": apiKey,
          },
        }
      );

      if (!response.ok) {
        console.warn(`CMC API error: ${response.status} ${response.statusText}`);
        return "0";
      }

      const data = await response.json() as any;
      // CoinMarketCap v1 response structure for id=22691
      const price = data?.data?.["22691"]?.quote?.USD?.price;
      
      if (typeof price === "number" && Number.isFinite(price) && price > 0) {
        return price.toString();
      }

      // Fallback to checking the structure the user might have been referring to if the above fails
      const fallbackPrice = data?.data?.[0]?.quote?.[0]?.price;
      if (typeof fallbackPrice === "number" && Number.isFinite(fallbackPrice) && fallbackPrice > 0) {
        return fallbackPrice.toString();
      }

      return "0";
    } catch (error) {
      console.warn("Failed to fetch STRK price from CoinMarketCap", error);
      return "0";
    }
  }

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

  router.get("/api/prediction/market/:id", requirePrivyUser, async (req, res) => {
    const typedReq = req as RequestWithPrivyUser;
    const userId = typedReq.privyUserId;
    const marketId = req.params.id;

    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const parsedMarketId = parseNonNegativeIntAsBigInt(marketId);
    if (parsedMarketId === null) {
      return res.status(400).json({ error: "Invalid market ID" });
    }

    try {
      const wallet = await walletRepo.getWalletByPrivyUserId(userId);
      const userAddress = wallet?.address || "0x0000000000000000000000000000000000000000000000000000000000000000";

      // Sequential calls for simplicity, could be multicall
      const [
        questionRaw,
        deadlineRaw,
        creatorRaw,
        yesPoolLow,
        yesPoolHigh,
        noPoolLow,
        noPoolHigh,
        resolvedRaw,
        winnerRaw,
        userBetLow,
        userBetHigh,
        userOutcomeRaw,
        userClaimedRaw
      ] = await Promise.all([
        sdk.callContract({ contractAddress: predictionContractAddress, entrypoint: "get_market_question", calldata: [toFeltHex(parsedMarketId)] }),
        sdk.callContract({ contractAddress: predictionContractAddress, entrypoint: "get_market_deadline", calldata: [toFeltHex(parsedMarketId)] }),
        sdk.callContract({ contractAddress: predictionContractAddress, entrypoint: "get_market_creator", calldata: [toFeltHex(parsedMarketId)] }),
        sdk.callContract({ contractAddress: predictionContractAddress, entrypoint: "get_market_yes_pool", calldata: [toFeltHex(parsedMarketId)] }).then(r => r[0]),
        sdk.callContract({ contractAddress: predictionContractAddress, entrypoint: "get_market_yes_pool", calldata: [toFeltHex(parsedMarketId)] }).then(r => r[1]),
        sdk.callContract({ contractAddress: predictionContractAddress, entrypoint: "get_market_no_pool", calldata: [toFeltHex(parsedMarketId)] }).then(r => r[0]),
        sdk.callContract({ contractAddress: predictionContractAddress, entrypoint: "get_market_no_pool", calldata: [toFeltHex(parsedMarketId)] }).then(r => r[1]),
        sdk.callContract({ contractAddress: predictionContractAddress, entrypoint: "get_market_resolved", calldata: [toFeltHex(parsedMarketId)] }),
        sdk.callContract({ contractAddress: predictionContractAddress, entrypoint: "get_market_winning_outcome", calldata: [toFeltHex(parsedMarketId)] }),
        sdk.callContract({ contractAddress: predictionContractAddress, entrypoint: "get_user_bet_amount", calldata: [toFeltHex(parsedMarketId), userAddress] }).then(r => r[0]),
        sdk.callContract({ contractAddress: predictionContractAddress, entrypoint: "get_user_bet_amount", calldata: [toFeltHex(parsedMarketId), userAddress] }).then(r => r[1]),
        sdk.callContract({ contractAddress: predictionContractAddress, entrypoint: "get_user_bet_outcome", calldata: [toFeltHex(parsedMarketId), userAddress] }),
        sdk.callContract({ contractAddress: predictionContractAddress, entrypoint: "get_user_bet_claimed", calldata: [toFeltHex(parsedMarketId), userAddress] }),
      ]);

      const questionFelt = questionRaw[0] || "0x0";
      const question = felt252ToString(questionFelt) || "Untitled Market";

      return res.json({
        id: parsedMarketId.toString(),
        question,
        deadline: BigInt(deadlineRaw[0] || "0").toString(),
        creator: creatorRaw[0] || "0x0",
        yesPool: (BigInt(yesPoolHigh || "0") << 128n | BigInt(yesPoolLow || "0")).toString(),
        noPool: (BigInt(noPoolHigh || "0") << 128n | BigInt(noPoolLow || "0")).toString(),
        resolved: (resolvedRaw[0] === "0x1"),
        winningOutcome: (winnerRaw[0] === "0x1"),
        userBet: {
          amount: (BigInt(userBetHigh || "0") << 128n | BigInt(userBetLow || "0")).toString(),
          outcome: (userOutcomeRaw[0] === "0x1"),
          claimed: (userClaimedRaw[0] === "0x1"),
          exists: (BigInt(userBetLow || "0") > 0n || BigInt(userBetHigh || "0") > 0n)
        },
        userAddress
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Market detail read failed";
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
      const normalizedAddress = fromAddress(wallet.address);
      const userStrk = await readStrkBalance(normalizedAddress);
      const userUsdc = await readUsdcBalance(normalizedAddress);
      const treasuryStrk = await readStrkBalance(predictionContractAddress);

      console.log(`Balances for ${normalizedAddress}: STRK=${userStrk.value}, USDC=${userUsdc.value}`);

      let strkPriceUsdc = await fetchStrkMarketPriceUsd();
      const usdcPriceUsdc = "1";

      if (chainId.isMainnet()) {
        if (strkPriceUsdc === "0") {
          try {
            const userWallet = await walletService.getUserWalletInterface(wallet);
            const quote = await userWallet.getQuote({
              tokenIn: STRK,
              tokenOut: USDC,
              amountIn: Amount.fromRaw(10n ** 18n, STRK),
            });
            strkPriceUsdc = (Number(quote.amountOutBase) / 10 ** USDC.decimals).toString();
          } catch (priceError) {
            console.warn("Failed to fetch mainnet STRK price quote from DEX", priceError);
            strkPriceUsdc = "0";
          }
        }
      }

      const responseData = {
        tokenContractAddress: STRK.address,
        usdcTokenContractAddress: USDC.address,
        walletAddress: wallet.address,
        treasuryAddress: predictionContractAddress,
        symbol: "STRK",
        userBalance: userStrk.value.toString(),
        userBalanceRaw: {
          low: userStrk.lowHex,
          high: userStrk.highHex,
        },
        userUsdcBalance: userUsdc.value.toString(),
        userUsdcBalanceRaw: {
          low: userUsdc.lowHex,
          high: userUsdc.highHex,
        },
        treasuryBalance: treasuryStrk.value.toString(),
        treasuryBalanceRaw: {
          low: treasuryStrk.lowHex,
          high: treasuryStrk.highHex,
        },
        strkPriceUsdc,
        usdcPriceUsdc,
      };

      console.log("Response Data:", JSON.stringify(responseData, null, 2));
      return res.json(responseData);
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
      const marketCountRead = await sdk.callContract({
        contractAddress: predictionContractAddress,
        entrypoint: "get_market_count",
        calldata: [],
      });
      const predictedMarketId = BigInt(marketCountRead[0] ?? "0x0").toString();

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
        metadata: { title: normalizedTitle, deadline: deadline.toString(), marketId: predictedMarketId },
      });

      return res.json({
        message: "Market created transaction submitted",
        title: normalizedTitle,
        deadline: deadline.toString(),
        predictedMarketId,
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

    let payoutAmount = "0";

    try {
      let userWallet;

      try {
        userWallet = await walletService.ensureWalletReadyForWrites(wallet);
      } catch (error) {
        const walletNotReady = walletService.buildWalletNotReadyResponse(error, wallet.address);
        return res.status(walletNotReady.statusCode).json(walletNotReady.payload);
      }

      try {
        const [
          yesPoolLow, yesPoolHigh,
          noPoolLow, noPoolHigh,
          winnerRaw,
          userBetLow, userBetHigh,
          userOutcomeRaw
        ] = await Promise.all([
          sdk.callContract({ contractAddress: predictionContractAddress, entrypoint: "get_market_yes_pool", calldata: [toFeltHex(parsedMarketId)] }).then(r => r[0]),
          sdk.callContract({ contractAddress: predictionContractAddress, entrypoint: "get_market_yes_pool", calldata: [toFeltHex(parsedMarketId)] }).then(r => r[1]),
          sdk.callContract({ contractAddress: predictionContractAddress, entrypoint: "get_market_no_pool", calldata: [toFeltHex(parsedMarketId)] }).then(r => r[0]),
          sdk.callContract({ contractAddress: predictionContractAddress, entrypoint: "get_market_no_pool", calldata: [toFeltHex(parsedMarketId)] }).then(r => r[1]),
          sdk.callContract({ contractAddress: predictionContractAddress, entrypoint: "get_market_winning_outcome", calldata: [toFeltHex(parsedMarketId)] }),
          sdk.callContract({ contractAddress: predictionContractAddress, entrypoint: "get_user_bet_amount", calldata: [toFeltHex(parsedMarketId), wallet.address] }).then(r => r[0]),
          sdk.callContract({ contractAddress: predictionContractAddress, entrypoint: "get_user_bet_amount", calldata: [toFeltHex(parsedMarketId), wallet.address] }).then(r => r[1]),
          sdk.callContract({ contractAddress: predictionContractAddress, entrypoint: "get_user_bet_outcome", calldata: [toFeltHex(parsedMarketId), wallet.address] }),
        ]);

        const yesPool = (BigInt(yesPoolHigh || "0") << 128n) | BigInt(yesPoolLow || "0");
        const noPool = (BigInt(noPoolHigh || "0") << 128n) | BigInt(noPoolLow || "0");
        const userBet = (BigInt(userBetHigh || "0") << 128n) | BigInt(userBetLow || "0");
        
        const isWinner = (winnerRaw[0] === "0x1");
        const userOutcome = (userOutcomeRaw[0] === "0x1");
        
        const totalPool = yesPool + noPool;
        const winningPool = isWinner ? yesPool : noPool;

        if (userOutcome === isWinner && winningPool > 0n) {
          const payout = (userBet * totalPool) / winningPool;
          payoutAmount = payout.toString();
        }
      } catch (err) {
        console.error("Failed to read expected payout", err);
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
        metadata: { marketId: parsedMarketId.toString(), amount: payoutAmount },
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
        metadata: { marketId: parsedMarketId.toString(), amount: payoutAmount },
      });
      return res.status(500).json({ error: message });
    }
  });

  return router;
}
