import express, { Router } from "express";
import type { StarkZap } from "starkzap";
import { v4 as uuidv4 } from "uuid";
import type { ChatRepository } from "../db/chat-repo.ts";
import type { RoomMarketRepository } from "../db/room-market-repo.ts";
import type { UserProfileRepository } from "../db/user-profile-repo.ts";
import type { WalletRepository } from "../db/wallet-repo.ts";
import type { RequestWithPrivyUser } from "../middleware/require-privy-user.ts";
import {
    parseNonNegativeIntAsBigInt,
    parsePositiveIntAsBigInt,
    toFeltHex,
} from "../services/felt-utils.ts";
import { fetchExternalMarketPreviewByUrl } from "../services/market-source.ts";
import { parseU256FromCallResult } from "../services/u256-utils.ts";

const MAX_U32 = 4294967295n;

function parsePageValue(
  raw: unknown,
  defaultValue: number,
  maxValue: number,
): number {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return defaultValue;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return defaultValue;
  }

  return Math.min(Math.trunc(parsed), maxValue);
}

function normalizeRoomName(rawRoom: string | string[] | undefined): string {
  const candidate = Array.isArray(rawRoom) ? rawRoom[0] : rawRoom;
  if (typeof candidate !== "string") {
    return "";
  }

  return candidate
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[^\x20-\x7E]/g, "")
    .slice(0, 40);
}

function toAsciiFromFeltHex(feltHex: string): string | null {
  if (!/^0x[0-9a-fA-F]+$/.test(feltHex)) {
    return null;
  }

  let hex = feltHex.slice(2);
  if (hex.length % 2 === 1) {
    hex = `0${hex}`;
  }

  const bytes: number[] = [];

  for (let i = 0; i < hex.length; i += 2) {
    const byteHex = hex.slice(i, i + 2);
    const parsed = Number.parseInt(byteHex, 16);

    if (Number.isNaN(parsed)) {
      return null;
    }

    bytes.push(parsed);
  }

  while (bytes.length > 0 && bytes[0] === 0) {
    bytes.shift();
  }

  if (bytes.length === 0) {
    return "";
  }

  if (bytes.some((byte) => byte < 32 || byte > 126)) {
    return null;
  }

  return String.fromCharCode(...bytes);
}

function normalizeHexAddress(raw: string): string | null {
  if (!/^0x[0-9a-fA-F]+$/.test(raw)) {
    return null;
  }

  try {
    return `0x${BigInt(raw).toString(16)}`;
  } catch {
    return null;
  }
}

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const maybeCode = (error as { code?: unknown }).code;
  return maybeCode === "23505";
}

class MarketNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarketNotFoundError";
  }
}

async function callSingleFelt(
  sdk: StarkZap,
  predictionContractAddress: string,
  entrypoint: string,
  calldata: string[],
): Promise<string> {
  const result = await sdk.callContract({
    contractAddress: predictionContractAddress,
    entrypoint,
    calldata,
  });

  return result[0] ?? "0x0";
}

async function readRoomMarketSnapshot(
  sdk: StarkZap,
  predictionContractAddress: string,
  marketId: bigint,
) {
  const countRaw = await callSingleFelt(
    sdk,
    predictionContractAddress,
    "get_market_count",
    [],
  );
  const marketCount = BigInt(countRaw);

  if (marketId >= marketCount) {
    throw new MarketNotFoundError(
      "marketId does not exist on prediction contract",
    );
  }

  const marketCalldata = [toFeltHex(marketId)];

  const [
    questionFelt,
    creator,
    deadlineRaw,
    yesPoolResult,
    noPoolResult,
    resolvedRaw,
    winningOutcomeRaw,
  ] = await Promise.all([
    callSingleFelt(
      sdk,
      predictionContractAddress,
      "get_market_question",
      marketCalldata,
    ),
    callSingleFelt(
      sdk,
      predictionContractAddress,
      "get_market_creator",
      marketCalldata,
    ),
    callSingleFelt(
      sdk,
      predictionContractAddress,
      "get_market_deadline",
      marketCalldata,
    ),
    sdk.callContract({
      contractAddress: predictionContractAddress,
      entrypoint: "get_market_yes_pool",
      calldata: marketCalldata,
    }),
    sdk.callContract({
      contractAddress: predictionContractAddress,
      entrypoint: "get_market_no_pool",
      calldata: marketCalldata,
    }),
    callSingleFelt(
      sdk,
      predictionContractAddress,
      "get_market_resolved",
      marketCalldata,
    ),
    callSingleFelt(
      sdk,
      predictionContractAddress,
      "get_market_winning_outcome",
      marketCalldata,
    ),
  ]);

  const yesPool = parseU256FromCallResult(yesPoolResult).value;
  const noPool = parseU256FromCallResult(noPoolResult).value;

  return {
    marketId: marketId.toString(),
    marketCount: marketCount.toString(),
    questionFelt,
    questionAscii: toAsciiFromFeltHex(questionFelt),
    creator,
    deadlineUnix: BigInt(deadlineRaw).toString(),
    yesPool: yesPool.toString(),
    noPool: noPool.toString(),
    totalPool: (yesPool + noPool).toString(),
    resolved: BigInt(resolvedRaw) !== 0n,
    winningOutcome: BigInt(winningOutcomeRaw) !== 0n,
  };
}

export function createRoomMarketRouter(params: {
  sdk: StarkZap;
  predictionContractAddress: string;
  requirePrivyUser: express.RequestHandler;
  walletRepo: WalletRepository;
  userProfileRepo: UserProfileRepository;
  chatRepo: ChatRepository;
  roomMarketRepo: RoomMarketRepository;
}) {
  const {
    sdk,
    predictionContractAddress,
    requirePrivyUser,
    walletRepo,
    userProfileRepo,
    chatRepo,
    roomMarketRepo,
  } = params;

  const router = Router();

  async function requireActiveRoomMember(
    req: express.Request,
    res: express.Response,
    roomName: string,
  ): Promise<string | null> {
    const typedReq = req as RequestWithPrivyUser;
    const userId = typedReq.privyUserId;

    if (!userId) {
      res.status(401).json({ error: "User not authenticated" });
      return null;
    }

    const room = await chatRepo.getRoomByName(roomName);
    if (!room) {
      res.status(404).json({ error: "Room not found" });
      return null;
    }

    const isMember = await chatRepo.hasActiveRoomMembership(roomName, userId);
    if (!isMember) {
      res
        .status(403)
        .json({ error: "Only active room members can access room markets" });
      return null;
    }

    return userId;
  }

  router.post(
    "/api/chat/rooms/:room/external-markets",
    requirePrivyUser,
    async (req, res) => {
      const roomName = normalizeRoomName(req.params.room);
      const { url } = req.body as {
        url?: unknown;
      };

      if (!roomName) {
        return res.status(400).json({ error: "room is required" });
      }

      const userId = await requireActiveRoomMember(req, res, roomName);
      if (!userId) {
        return;
      }

      if (typeof url !== "string" || url.trim().length === 0) {
        return res.status(400).json({ error: "url is required" });
      }

      try {
        const profile = await userProfileRepo.getByPrivyUserId(userId);
        if (!profile?.username) {
          return res
            .status(409)
            .json({
              error:
                "Set username in onboarding before linking external markets",
            });
        }

        await chatRepo.upsertChatProfile(profile.username);

        const preview = await fetchExternalMarketPreviewByUrl(url.trim());

        const record = await roomMarketRepo.saveExternalMarketLink({
          id: uuidv4(),
          roomName,
          source: preview.source,
          sourceUrl: preview.sourceUrl,
          externalId: preview.externalId,
          title: preview.title,
          description: preview.description,
          image: preview.image,
          outcomes: preview.outcomes,
          outcomePrices: preview.outcomePrices,
          closesAt: preview.closesAt,
          rawPayload: preview.raw,
          linkedByUsername: profile.username,
        });

        return res.status(201).json({
          room: roomName,
          externalMarket: record,
        });
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Failed to save external market link";
        return res.status(400).json({ error: message });
      }
    },
  );

  router.get(
    "/api/chat/rooms/:room/external-markets",
    requirePrivyUser,
    async (req, res) => {
      const roomName = normalizeRoomName(req.params.room);
      const limit = parsePageValue(req.query.limit, 20, 100);
      const offset = parsePageValue(req.query.offset, 0, 1000);

      if (!roomName) {
        return res.status(400).json({ error: "room is required" });
      }

      const userId = await requireActiveRoomMember(req, res, roomName);
      if (!userId) {
        return;
      }

      try {
        const externalMarkets = await roomMarketRepo.listExternalMarketLinks(
          roomName,
          limit,
          offset,
        );
        return res.json({ room: roomName, limit, offset, externalMarkets });
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Failed to list external market links";
        return res.status(500).json({ error: message });
      }
    },
  );

  router.post(
    "/api/chat/rooms/:room/markets/attach",
    requirePrivyUser,
    async (req, res) => {
      const roomName = normalizeRoomName(req.params.room);

      if (!roomName) {
        return res.status(400).json({ error: "room is required" });
      }

      const userId = await requireActiveRoomMember(req, res, roomName);
      if (!userId) {
        return;
      }

      const {
        marketId,
        externalMarketLinkId,
        title,
        deadlineUnix,
        createTxHash,
      } = req.body as {
        marketId?: unknown;
        externalMarketLinkId?: unknown;
        title?: unknown;
        deadlineUnix?: unknown;
        createTxHash?: unknown;
      };

      const parsedMarketId = parseNonNegativeIntAsBigInt(marketId);
      if (parsedMarketId === null || parsedMarketId > MAX_U32) {
        return res
          .status(400)
          .json({ error: "marketId must be a valid u32 integer" });
      }

      const parsedDeadlineUnix =
        deadlineUnix === undefined || deadlineUnix === null
          ? null
          : parsePositiveIntAsBigInt(deadlineUnix);

      if (
        deadlineUnix !== undefined &&
        deadlineUnix !== null &&
        !parsedDeadlineUnix
      ) {
        return res
          .status(400)
          .json({ error: "deadlineUnix must be a positive unix timestamp" });
      }

      const normalizedExternalMarketLinkId =
        typeof externalMarketLinkId === "string" &&
        externalMarketLinkId.trim().length > 0
          ? externalMarketLinkId.trim()
          : null;

      const normalizedTitle =
        typeof title === "string" && title.trim().length > 0
          ? title.trim().slice(0, 120)
          : null;

      const normalizedTxHash =
        typeof createTxHash === "string" && createTxHash.trim().length > 0
          ? createTxHash.trim()
          : null;

      const wallet = await walletRepo.getWalletByPrivyUserId(userId);
      if (!wallet) {
        return res.status(404).json({
          error:
            "No Starknet wallet found for user. Call POST /api/wallet/starknet first.",
        });
      }

      try {
        if (normalizedExternalMarketLinkId) {
          const externalLink = await roomMarketRepo.getExternalMarketLinkById(
            normalizedExternalMarketLinkId,
          );
          if (!externalLink) {
            return res
              .status(404)
              .json({ error: "externalMarketLinkId not found" });
          }

          if (externalLink.roomName !== roomName) {
            return res
              .status(400)
              .json({
                error:
                  "externalMarketLinkId does not belong to the provided room",
              });
          }
        }

        const savedMarket = await roomMarketRepo.attachRoomContractMarket({
          id: uuidv4(),
          roomName,
          predictionContractAddress,
          marketId: parsedMarketId,
          title: normalizedTitle ?? undefined,
          deadlineUnix: parsedDeadlineUnix ?? undefined,
          createTxHash: normalizedTxHash ?? undefined,
          createdByPrivyUserId: userId,
          createdByWalletAddress: wallet.address,
          externalMarketLinkId: normalizedExternalMarketLinkId ?? undefined,
        });

        return res.status(201).json({
          room: roomName,
          market: savedMarket,
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          return res.status(409).json({
            error: "Market already attached",
            hint: "This on-chain market is already mapped in room metadata",
          });
        }

        const message =
          error instanceof Error
            ? error.message
            : "Failed to attach room market";
        return res.status(500).json({ error: message });
      }
    },
  );

  router.get(
    "/api/chat/rooms/:room/markets",
    requirePrivyUser,
    async (req, res) => {
      const roomName = normalizeRoomName(req.params.room);
      const limit = parsePageValue(req.query.limit, 20, 100);
      const offset = parsePageValue(req.query.offset, 0, 1000);

      if (!roomName) {
        return res.status(400).json({ error: "room is required" });
      }

      const userId = await requireActiveRoomMember(req, res, roomName);
      if (!userId) {
        return;
      }

      try {
        const markets = await roomMarketRepo.listRoomContractMarkets(
          roomName,
          limit,
          offset,
        );
        return res.json({ room: roomName, limit, offset, markets });
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Failed to list room markets";
        return res.status(500).json({ error: message });
      }
    },
  );

  router.get(
    "/api/chat/rooms/:room/markets/:marketId/details",
    requirePrivyUser,
    async (req, res) => {
      const roomName = normalizeRoomName(req.params.room);
      const parsedMarketId = parseNonNegativeIntAsBigInt(req.params.marketId);

      if (!roomName) {
        return res.status(400).json({ error: "room is required" });
      }

      if (parsedMarketId === null || parsedMarketId > MAX_U32) {
        return res
          .status(400)
          .json({ error: "marketId must be a valid u32 integer" });
      }

      const userId = await requireActiveRoomMember(req, res, roomName);
      if (!userId) {
        return;
      }

      try {
        const roomMarket = await roomMarketRepo.getRoomContractMarket(
          roomName,
          predictionContractAddress,
          parsedMarketId,
        );

        if (!roomMarket) {
          return res.status(404).json({
            error: "Room market mapping not found",
            hint: "Attach the on-chain market to this room first",
          });
        }

        const chain = await readRoomMarketSnapshot(
          sdk,
          predictionContractAddress,
          parsedMarketId,
        );

        return res.json({
          room: roomName,
          market: roomMarket,
          chain,
        });
      } catch (error) {
        if (error instanceof MarketNotFoundError) {
          return res.status(404).json({ error: error.message });
        }

        const message =
          error instanceof Error
            ? error.message
            : "Failed to read room market details";
        return res.status(500).json({ error: message });
      }
    },
  );

  router.get(
    "/api/chat/rooms/:room/markets/:marketId/can-resolve",
    requirePrivyUser,
    async (req, res) => {
      const roomName = normalizeRoomName(req.params.room);
      const parsedMarketId = parseNonNegativeIntAsBigInt(req.params.marketId);

      if (!roomName) {
        return res.status(400).json({ error: "room is required" });
      }

      if (parsedMarketId === null || parsedMarketId > MAX_U32) {
        return res
          .status(400)
          .json({ error: "marketId must be a valid u32 integer" });
      }

      const userId = await requireActiveRoomMember(req, res, roomName);
      if (!userId) {
        return;
      }

      const wallet = await walletRepo.getWalletByPrivyUserId(userId);
      if (!wallet) {
        return res.status(404).json({
          error:
            "No Starknet wallet found for user. Call POST /api/wallet/starknet first.",
        });
      }

      try {
        const roomMarket = await roomMarketRepo.getRoomContractMarket(
          roomName,
          predictionContractAddress,
          parsedMarketId,
        );

        if (!roomMarket) {
          return res.status(404).json({
            error: "Room market mapping not found",
            hint: "Attach the on-chain market to this room first",
          });
        }

        const chain = await readRoomMarketSnapshot(
          sdk,
          predictionContractAddress,
          parsedMarketId,
        );

        const normalizedCaller = normalizeHexAddress(wallet.address);
        const normalizedCreator = normalizeHexAddress(chain.creator);

        const isCreator =
          normalizedCaller !== null &&
          normalizedCreator !== null &&
          normalizedCaller === normalizedCreator;
        const canResolve = isCreator && !chain.resolved;

        return res.json({
          room: roomName,
          marketId: parsedMarketId.toString(),
          canResolve,
          isCreator,
          isResolved: chain.resolved,
          callerWalletAddress: wallet.address,
          marketCreator: chain.creator,
        });
      } catch (error) {
        if (error instanceof MarketNotFoundError) {
          return res.status(404).json({ error: error.message });
        }

        const message =
          error instanceof Error
            ? error.message
            : "Failed to evaluate resolver permissions";
        return res.status(500).json({ error: message });
      }
    },
  );

  return router;
}
