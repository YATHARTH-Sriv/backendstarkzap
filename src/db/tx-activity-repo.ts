import type { Pool } from "pg";
import { v4 as uuidv4 } from "uuid";

export type TxActivityStatus = "success" | "failed";

export type TxActivityRecord = {
  id: string;
  action: string;
  status: TxActivityStatus;
  txHash: string | null;
  explorerUrl: string | null;
  details: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export interface TxActivityRepository {
  record(entry: {
    privyUserId: string;
    action: string;
    status: TxActivityStatus;
    txHash?: string;
    explorerUrl?: string;
    details?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void>;
  listRecentByPrivyUserId(privyUserId: string, limit: number): Promise<TxActivityRecord[]>;
}

export function createTxActivityRepository(db: Pool): TxActivityRepository {
  async function ensureAppUser(privyUserId: string) {
    await db.query(
      `
        INSERT INTO app_users (privy_user_id, updated_at)
        VALUES ($1, NOW())
        ON CONFLICT (privy_user_id)
        DO UPDATE SET updated_at = NOW()
      `,
      [privyUserId],
    );
  }

  async function record(entry: {
    privyUserId: string;
    action: string;
    status: TxActivityStatus;
    txHash?: string;
    explorerUrl?: string;
    details?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    await ensureAppUser(entry.privyUserId);

    await db.query(
      `
        INSERT INTO user_transaction_activity (
          id,
          privy_user_id,
          action,
          status,
          tx_hash,
          explorer_url,
          details,
          metadata,
          created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, NOW())
      `,
      [
        uuidv4(),
        entry.privyUserId,
        entry.action,
        entry.status,
        entry.txHash ?? null,
        entry.explorerUrl ?? null,
        entry.details ?? null,
        JSON.stringify(entry.metadata ?? {}),
      ],
    );
  }

  async function listRecentByPrivyUserId(privyUserId: string, limit: number): Promise<TxActivityRecord[]> {
    const boundedLimit = Math.min(Math.max(limit, 1), 50);

    const result = await db.query<{
      id: string;
      action: string;
      status: TxActivityStatus;
      tx_hash: string | null;
      explorer_url: string | null;
      details: string | null;
      metadata: Record<string, unknown> | null;
      created_at: Date;
    }>(
      `
        SELECT
          id,
          action,
          status,
          tx_hash,
          explorer_url,
          details,
          metadata,
          created_at
        FROM user_transaction_activity
        WHERE privy_user_id = $1
        ORDER BY created_at DESC
        LIMIT $2
      `,
      [privyUserId, boundedLimit],
    );

    return result.rows.map((row) => ({
      id: row.id,
      action: row.action,
      status: row.status,
      txHash: row.tx_hash,
      explorerUrl: row.explorer_url,
      details: row.details,
      metadata: row.metadata ?? {},
      createdAt: row.created_at.toISOString(),
    }));
  }

  return {
    record,
    listRecentByPrivyUserId,
  };
}
