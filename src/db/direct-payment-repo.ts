import type { Pool } from "pg";
import { v4 as uuidv4 } from "uuid";

export type DirectPaymentStatus = "success" | "failed";

export type UserPaymentContact = {
  username: string;
  walletAddress: string;
  lastPaidAt: string;
  isExternal: boolean;
};

export type DirectPaymentRecord = {
  id: string;
  senderPrivyUserId: string;
  senderUsername: string;
  senderWalletAddress: string;
  recipientPrivyUserId: string | null;
  recipientUsername: string;
  recipientWalletAddress: string;
  tokenSymbol: string;
  tokenContractAddress: string;
  amountRaw: string;
  amountUnit: string;
  txHash: string | null;
  explorerUrl: string | null;
  status: DirectPaymentStatus;
  details: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type UserDirectoryEntry = {
  privyUserId: string;
  username: string;
  walletAddress: string;
};

export interface DirectPaymentRepository {
  savePayment(entry: {
    senderPrivyUserId: string;
    senderUsername: string;
    senderWalletAddress: string;
    recipientPrivyUserId?: string | null;
    recipientUsername: string;
    recipientWalletAddress: string;
    tokenSymbol: string;
    tokenContractAddress: string;
    amountRaw: string;
    amountUnit: string;
    txHash?: string;
    explorerUrl?: string;
    status: DirectPaymentStatus;
    details?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void>;
  searchUsersByUsername(
    query: string,
    limit: number,
    excludePrivyUserId: string,
  ): Promise<UserDirectoryEntry[]>;
  getUserByUsername(username: string): Promise<UserDirectoryEntry | null>;
  getUserByWalletAddress(
    walletAddress: string,
  ): Promise<UserDirectoryEntry | null>;
  listRecentContacts(
    privyUserId: string,
    limit: number,
  ): Promise<UserPaymentContact[]>;
  loadBilateralHistory(params: {
    privyUserId: string;
    otherWalletAddress: string;
    otherPrivyUserId?: string;
    limit: number;
    before?: string;
  }): Promise<DirectPaymentRecord[]>;
}

function normalizeLimit(limit: number, fallback: number, max: number): number {
  if (!Number.isFinite(limit) || limit <= 0) {
    return fallback;
  }

  return Math.min(Math.trunc(limit), max);
}

function normalizedAddressSql(valueExpression: string): string {
  return `COALESCE(NULLIF(regexp_replace(LOWER(${valueExpression}), '^0x0*', ''), ''), '0')`;
}

export function createDirectPaymentRepository(
  db: Pool,
): DirectPaymentRepository {
  async function savePayment(entry: {
    senderPrivyUserId: string;
    senderUsername: string;
    senderWalletAddress: string;
    recipientPrivyUserId?: string | null;
    recipientUsername: string;
    recipientWalletAddress: string;
    tokenSymbol: string;
    tokenContractAddress: string;
    amountRaw: string;
    amountUnit: string;
    txHash?: string;
    explorerUrl?: string;
    status: DirectPaymentStatus;
    details?: string;
    metadata?: Record<string, unknown>;
  }) {
    await db.query(
      `
        INSERT INTO user_direct_payments (
          id,
          sender_privy_user_id,
          sender_username,
          sender_wallet_address,
          recipient_privy_user_id,
          recipient_username,
          recipient_wallet_address,
          token_symbol,
          token_contract_address,
          amount_raw,
          amount_unit,
          tx_hash,
          explorer_url,
          status,
          details,
          metadata,
          created_at
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8,
          $9,
          $10,
          $11,
          $12,
          $13,
          $14,
          $15,
          $16::jsonb,
          NOW()
        )
      `,
      [
        uuidv4(),
        entry.senderPrivyUserId,
        entry.senderUsername,
        entry.senderWalletAddress,
        entry.recipientPrivyUserId ?? null,
        entry.recipientUsername,
        entry.recipientWalletAddress,
        entry.tokenSymbol,
        entry.tokenContractAddress,
        entry.amountRaw,
        entry.amountUnit,
        entry.txHash ?? null,
        entry.explorerUrl ?? null,
        entry.status,
        entry.details ?? null,
        JSON.stringify(entry.metadata ?? {}),
      ],
    );
  }

  async function searchUsersByUsername(
    query: string,
    limit: number,
    excludePrivyUserId: string,
  ) {
    const boundedLimit = normalizeLimit(limit, 8, 25);

    const result = await db.query<{
      privy_user_id: string;
      username: string;
      wallet_address: string;
    }>(
      `
        SELECT
          u.privy_user_id,
          u.username,
          w.wallet_address
        FROM app_users u
        INNER JOIN user_wallets w ON w.privy_user_id = u.privy_user_id
        WHERE
          u.onboarding_completed = TRUE
          AND u.username IS NOT NULL
          AND u.privy_user_id <> $2
          AND LOWER(u.username) LIKE LOWER($1)
        ORDER BY LOWER(u.username) ASC
        LIMIT $3
      `,
      [`${query}%`, excludePrivyUserId, boundedLimit],
    );

    return result.rows.map((row) => ({
      privyUserId: row.privy_user_id,
      username: row.username,
      walletAddress: row.wallet_address,
    }));
  }

  async function getUserByUsername(
    username: string,
  ): Promise<UserDirectoryEntry | null> {
    const result = await db.query<{
      privy_user_id: string;
      username: string;
      wallet_address: string;
    }>(
      `
        SELECT
          u.privy_user_id,
          u.username,
          w.wallet_address
        FROM app_users u
        INNER JOIN user_wallets w ON w.privy_user_id = u.privy_user_id
        WHERE
          u.onboarding_completed = TRUE
          AND u.username IS NOT NULL
          AND LOWER(u.username) = LOWER($1)
        LIMIT 1
      `,
      [username],
    );

    if (result.rowCount === 0) {
      return null;
    }

    const row = result.rows[0];
    return {
      privyUserId: row.privy_user_id,
      username: row.username,
      walletAddress: row.wallet_address,
    };
  }

  async function getUserByWalletAddress(
    walletAddress: string,
  ): Promise<UserDirectoryEntry | null> {
    const result = await db.query<{
      privy_user_id: string;
      username: string;
      wallet_address: string;
    }>(
      `
        SELECT
          u.privy_user_id,
          u.username,
          w.wallet_address
        FROM app_users u
        INNER JOIN user_wallets w ON w.privy_user_id = u.privy_user_id
        WHERE
          u.onboarding_completed = TRUE
          AND u.username IS NOT NULL
          AND ${normalizedAddressSql("w.wallet_address")} = ${normalizedAddressSql("$1")}
        LIMIT 1
      `,
      [walletAddress],
    );

    if (result.rowCount === 0) {
      return null;
    }

    const row = result.rows[0];
    return {
      privyUserId: row.privy_user_id,
      username: row.username,
      walletAddress: row.wallet_address,
    };
  }

  async function listRecentContacts(privyUserId: string, limit: number) {
    const boundedLimit = normalizeLimit(limit, 8, 20);

    const result = await db.query<{
      username: string;
      wallet_address: string;
      last_paid_at: Date;
      is_external: boolean;
    }>(
      `
        SELECT
          partner.username,
          partner.wallet_address,
          MAX(partner.created_at) AS last_paid_at,
          BOOL_OR(partner.is_external) AS is_external
        FROM (
          SELECT
            recipient_username AS username,
            recipient_wallet_address AS wallet_address,
            created_at,
            recipient_privy_user_id IS NULL AS is_external
          FROM user_direct_payments
          WHERE sender_privy_user_id = $1

          UNION ALL

          SELECT
            sender_username AS username,
            sender_wallet_address AS wallet_address,
            created_at,
            FALSE AS is_external
          FROM user_direct_payments
          WHERE recipient_privy_user_id = $1
        ) partner
        GROUP BY partner.username, partner.wallet_address
        ORDER BY last_paid_at DESC
        LIMIT $2
      `,
      [privyUserId, boundedLimit],
    );

    return result.rows.map((row) => ({
      username: row.username,
      walletAddress: row.wallet_address,
      lastPaidAt: row.last_paid_at.toISOString(),
      isExternal: row.is_external,
    }));
  }

  async function loadBilateralHistory(params: {
    privyUserId: string;
    otherWalletAddress: string;
    otherPrivyUserId?: string;
    limit: number;
    before?: string;
  }) {
    const boundedLimit = normalizeLimit(params.limit, 30, 100);

    const values: Array<string | number> = [params.privyUserId];
    let peerMatchClause: string;

    if (params.otherPrivyUserId) {
      values.push(params.otherPrivyUserId, params.otherWalletAddress);

      peerMatchClause = `(
        (sender_privy_user_id = $1 AND recipient_privy_user_id = $2)
        OR
        (recipient_privy_user_id = $1 AND sender_privy_user_id = $2)
        OR
        (sender_privy_user_id = $1 AND ${normalizedAddressSql("recipient_wallet_address")} = ${normalizedAddressSql("$3")})
        OR
        (recipient_privy_user_id = $1 AND ${normalizedAddressSql("sender_wallet_address")} = ${normalizedAddressSql("$3")})
      )`;
    } else {
      values.push(params.otherWalletAddress);

      peerMatchClause = `(
        (sender_privy_user_id = $1 AND ${normalizedAddressSql("recipient_wallet_address")} = ${normalizedAddressSql("$2")})
        OR
        (recipient_privy_user_id = $1 AND ${normalizedAddressSql("sender_wallet_address")} = ${normalizedAddressSql("$2")})
      )`;
    }

    const clauses = [peerMatchClause];

    if (params.before) {
      const beforePlaceholder = `$${values.length + 1}`;
      clauses.push(`created_at < ${beforePlaceholder}::timestamptz`);
      values.push(params.before);
    }

    const limitPlaceholder = `$${values.length + 1}`;
    values.push(boundedLimit);

    const result = await db.query<{
      id: string;
      sender_privy_user_id: string;
      sender_username: string;
      sender_wallet_address: string;
      recipient_privy_user_id: string | null;
      recipient_username: string;
      recipient_wallet_address: string;
      token_symbol: string;
      token_contract_address: string;
      amount_raw: string;
      amount_unit: string;
      tx_hash: string | null;
      explorer_url: string | null;
      status: DirectPaymentStatus;
      details: string | null;
      metadata: Record<string, unknown> | null;
      created_at: Date;
    }>(
      `
        SELECT
          id,
          sender_privy_user_id,
          sender_username,
          sender_wallet_address,
          recipient_privy_user_id,
          recipient_username,
          recipient_wallet_address,
          token_symbol,
          token_contract_address,
          amount_raw,
          amount_unit,
          tx_hash,
          explorer_url,
          status,
          details,
          metadata,
          created_at
        FROM user_direct_payments
        WHERE ${clauses.join(" AND ")}
        ORDER BY created_at DESC
        LIMIT ${limitPlaceholder}
      `,
      values,
    );

    return result.rows.map((row) => ({
      id: row.id,
      senderPrivyUserId: row.sender_privy_user_id,
      senderUsername: row.sender_username,
      senderWalletAddress: row.sender_wallet_address,
      recipientPrivyUserId: row.recipient_privy_user_id,
      recipientUsername: row.recipient_username,
      recipientWalletAddress: row.recipient_wallet_address,
      tokenSymbol: row.token_symbol,
      tokenContractAddress: row.token_contract_address,
      amountRaw: row.amount_raw,
      amountUnit: row.amount_unit,
      txHash: row.tx_hash,
      explorerUrl: row.explorer_url,
      status: row.status,
      details: row.details,
      metadata: row.metadata ?? {},
      createdAt: row.created_at.toISOString(),
    }));
  }

  return {
    savePayment,
    searchUsersByUsername,
    getUserByUsername,
    getUserByWalletAddress,
    listRecentContacts,
    loadBilateralHistory,
  };
}
