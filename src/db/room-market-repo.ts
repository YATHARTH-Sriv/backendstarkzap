import type { Pool } from "pg";
import type { ExternalMarketSource } from "../services/market-source.ts";

export interface RoomExternalMarketRecord {
  id: string;
  roomName: string;
  source: ExternalMarketSource;
  sourceUrl: string;
  externalId: string;
  title: string;
  description?: string;
  image?: string;
  outcomes: string[];
  outcomePrices: number[];
  closesAt?: string;
  linkedByUsername?: string;
  createdAt: string;
}

export interface LinkedExternalMarketSummary {
  id: string;
  source: ExternalMarketSource;
  sourceUrl: string;
  externalId: string;
  title: string;
}

export interface RoomContractMarketRecord {
  id: string;
  roomName: string;
  predictionContractAddress: string;
  marketId: string;
  title?: string;
  deadlineUnix?: string;
  createTxHash?: string;
  createdByPrivyUserId: string;
  createdByWalletAddress: string;
  externalMarketLinkId?: string;
  createdAt: string;
  linkedExternalMarket?: LinkedExternalMarketSummary;
}

export interface CreateExternalMarketLinkInput {
  id: string;
  roomName: string;
  source: ExternalMarketSource;
  sourceUrl: string;
  externalId: string;
  title: string;
  description?: string;
  image?: string;
  outcomes: string[];
  outcomePrices: number[];
  closesAt?: string;
  rawPayload: unknown;
  linkedByUsername?: string;
}

export interface AttachRoomContractMarketInput {
  id: string;
  roomName: string;
  predictionContractAddress: string;
  marketId: bigint;
  title?: string;
  deadlineUnix?: bigint;
  createTxHash?: string;
  createdByPrivyUserId: string;
  createdByWalletAddress: string;
  externalMarketLinkId?: string;
}

export interface RoomMarketRepository {
  saveExternalMarketLink(input: CreateExternalMarketLinkInput): Promise<RoomExternalMarketRecord>;
  listExternalMarketLinks(roomName: string, limit?: number, offset?: number): Promise<RoomExternalMarketRecord[]>;
  getExternalMarketLinkById(id: string): Promise<RoomExternalMarketRecord | null>;
  attachRoomContractMarket(input: AttachRoomContractMarketInput): Promise<RoomContractMarketRecord>;
  listRoomContractMarkets(roomName: string, limit?: number, offset?: number): Promise<RoomContractMarketRecord[]>;
  getRoomContractMarket(
    roomName: string,
    predictionContractAddress: string,
    marketId: bigint,
  ): Promise<RoomContractMarketRecord | null>;
}

type ExternalMarketRow = {
  id: string;
  room_name: string;
  source: ExternalMarketSource;
  source_url: string;
  external_id: string;
  title: string;
  description: string | null;
  image: string | null;
  outcomes: unknown;
  outcome_prices: unknown;
  closes_at: Date | null;
  linked_by_username: string | null;
  created_at: Date;
};

type ContractMarketRow = {
  id: string;
  room_name: string;
  prediction_contract_address: string;
  market_id: string;
  title: string | null;
  deadline_unix: string | null;
  create_tx_hash: string | null;
  created_by_privy_user_id: string;
  created_by_wallet_address: string;
  external_market_link_id: string | null;
  created_at: Date;
  linked_external_id: string | null;
  linked_external_source: ExternalMarketSource | null;
  linked_external_source_url: string | null;
  linked_external_external_id: string | null;
  linked_external_title: string | null;
};

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string");
}

function toNumberArray(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => {
      if (typeof item === "number") {
        return item;
      }

      if (typeof item === "string") {
        const parsed = Number(item);
        return Number.isFinite(parsed) ? parsed : null;
      }

      return null;
    })
    .filter((item): item is number => item !== null);
}

function mapExternalMarketRow(row: ExternalMarketRow): RoomExternalMarketRecord {
  return {
    id: row.id,
    roomName: row.room_name,
    source: row.source,
    sourceUrl: row.source_url,
    externalId: row.external_id,
    title: row.title,
    description: row.description ?? undefined,
    image: row.image ?? undefined,
    outcomes: toStringArray(row.outcomes),
    outcomePrices: toNumberArray(row.outcome_prices),
    closesAt: row.closes_at?.toISOString(),
    linkedByUsername: row.linked_by_username ?? undefined,
    createdAt: row.created_at.toISOString(),
  };
}

function mapContractMarketRow(row: ContractMarketRow): RoomContractMarketRecord {
  const linkedExternalMarket =
    row.linked_external_id &&
    row.linked_external_source &&
    row.linked_external_source_url &&
    row.linked_external_external_id &&
    row.linked_external_title
      ? {
          id: row.linked_external_id,
          source: row.linked_external_source,
          sourceUrl: row.linked_external_source_url,
          externalId: row.linked_external_external_id,
          title: row.linked_external_title,
        }
      : undefined;

  return {
    id: row.id,
    roomName: row.room_name,
    predictionContractAddress: row.prediction_contract_address,
    marketId: row.market_id,
    title: row.title ?? undefined,
    deadlineUnix: row.deadline_unix ?? undefined,
    createTxHash: row.create_tx_hash ?? undefined,
    createdByPrivyUserId: row.created_by_privy_user_id,
    createdByWalletAddress: row.created_by_wallet_address,
    externalMarketLinkId: row.external_market_link_id ?? undefined,
    createdAt: row.created_at.toISOString(),
    linkedExternalMarket,
  };
}

export function createRoomMarketRepository(db: Pool): RoomMarketRepository {
  async function saveExternalMarketLink(input: CreateExternalMarketLinkInput) {
    const result = await db.query<ExternalMarketRow>(
      `
        INSERT INTO room_external_markets (
          id,
          room_name,
          source,
          source_url,
          external_id,
          title,
          description,
          image,
          outcomes,
          outcome_prices,
          closes_at,
          raw_payload,
          linked_by_username
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::timestamptz, $12::jsonb, $13)
        RETURNING
          id,
          room_name,
          source,
          source_url,
          external_id,
          title,
          description,
          image,
          outcomes,
          outcome_prices,
          closes_at,
          linked_by_username,
          created_at
      `,
      [
        input.id,
        input.roomName,
        input.source,
        input.sourceUrl,
        input.externalId,
        input.title,
        input.description ?? null,
        input.image ?? null,
        JSON.stringify(input.outcomes),
        JSON.stringify(input.outcomePrices),
        input.closesAt ?? null,
        JSON.stringify(input.rawPayload),
        input.linkedByUsername ?? null,
      ],
    );

    return mapExternalMarketRow(result.rows[0]);
  }

  async function listExternalMarketLinks(roomName: string, limit = 20, offset = 0) {
    const result = await db.query<ExternalMarketRow>(
      `
        SELECT
          id,
          room_name,
          source,
          source_url,
          external_id,
          title,
          description,
          image,
          outcomes,
          outcome_prices,
          closes_at,
          linked_by_username,
          created_at
        FROM room_external_markets
        WHERE room_name = $1
        ORDER BY created_at DESC
        LIMIT $2 OFFSET $3
      `,
      [roomName, limit, offset],
    );

    return result.rows.map(mapExternalMarketRow);
  }

  async function getExternalMarketLinkById(id: string) {
    const result = await db.query<ExternalMarketRow>(
      `
        SELECT
          id,
          room_name,
          source,
          source_url,
          external_id,
          title,
          description,
          image,
          outcomes,
          outcome_prices,
          closes_at,
          linked_by_username,
          created_at
        FROM room_external_markets
        WHERE id = $1
        LIMIT 1
      `,
      [id],
    );

    if (result.rowCount === 0) {
      return null;
    }

    return mapExternalMarketRow(result.rows[0]);
  }

  async function attachRoomContractMarket(input: AttachRoomContractMarketInput) {
    const result = await db.query<ContractMarketRow>(
      `
        INSERT INTO room_contract_markets (
          id,
          room_name,
          prediction_contract_address,
          market_id,
          title,
          deadline_unix,
          create_tx_hash,
          created_by_privy_user_id,
          created_by_wallet_address,
          external_market_link_id
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING
          id,
          room_name,
          prediction_contract_address,
          market_id,
          title,
          deadline_unix,
          create_tx_hash,
          created_by_privy_user_id,
          created_by_wallet_address,
          external_market_link_id,
          created_at,
          NULL::text AS linked_external_id,
          NULL::text AS linked_external_source,
          NULL::text AS linked_external_source_url,
          NULL::text AS linked_external_external_id,
          NULL::text AS linked_external_title
      `,
      [
        input.id,
        input.roomName,
        input.predictionContractAddress,
        input.marketId.toString(),
        input.title ?? null,
        input.deadlineUnix ? input.deadlineUnix.toString() : null,
        input.createTxHash ?? null,
        input.createdByPrivyUserId,
        input.createdByWalletAddress,
        input.externalMarketLinkId ?? null,
      ],
    );

    return mapContractMarketRow(result.rows[0]);
  }

  async function listRoomContractMarkets(roomName: string, limit = 20, offset = 0) {
    const result = await db.query<ContractMarketRow>(
      `
        SELECT
          cm.id,
          cm.room_name,
          cm.prediction_contract_address,
          cm.market_id,
          cm.title,
          cm.deadline_unix,
          cm.create_tx_hash,
          cm.created_by_privy_user_id,
          cm.created_by_wallet_address,
          cm.external_market_link_id,
          cm.created_at,
          em.id AS linked_external_id,
          em.source AS linked_external_source,
          em.source_url AS linked_external_source_url,
          em.external_id AS linked_external_external_id,
          em.title AS linked_external_title
        FROM room_contract_markets cm
        LEFT JOIN room_external_markets em ON em.id = cm.external_market_link_id
        WHERE cm.room_name = $1
        ORDER BY cm.created_at DESC
        LIMIT $2 OFFSET $3
      `,
      [roomName, limit, offset],
    );

    return result.rows.map(mapContractMarketRow);
  }

  async function getRoomContractMarket(
    roomName: string,
    predictionContractAddress: string,
    marketId: bigint,
  ) {
    const result = await db.query<ContractMarketRow>(
      `
        SELECT
          cm.id,
          cm.room_name,
          cm.prediction_contract_address,
          cm.market_id,
          cm.title,
          cm.deadline_unix,
          cm.create_tx_hash,
          cm.created_by_privy_user_id,
          cm.created_by_wallet_address,
          cm.external_market_link_id,
          cm.created_at,
          em.id AS linked_external_id,
          em.source AS linked_external_source,
          em.source_url AS linked_external_source_url,
          em.external_id AS linked_external_external_id,
          em.title AS linked_external_title
        FROM room_contract_markets cm
        LEFT JOIN room_external_markets em ON em.id = cm.external_market_link_id
        WHERE
          cm.room_name = $1
          AND cm.prediction_contract_address = $2
          AND cm.market_id = $3
        LIMIT 1
      `,
      [roomName, predictionContractAddress, marketId.toString()],
    );

    if (result.rowCount === 0) {
      return null;
    }

    return mapContractMarketRow(result.rows[0]);
  }

  return {
    saveExternalMarketLink,
    listExternalMarketLinks,
    getExternalMarketLinkById,
    attachRoomContractMarket,
    listRoomContractMarkets,
    getRoomContractMarket,
  };
}
