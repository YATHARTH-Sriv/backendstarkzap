import type { Pool } from "pg";

export type WalletRecord = {
  id: string;
  address: string;
  publicKey?: string;
};

export interface WalletRepository {
  ensureAppUser(privyUserId: string): Promise<void>;
  getWalletByPrivyUserId(privyUserId: string): Promise<WalletRecord | null>;
  upsertWalletForPrivyUser(privyUserId: string, wallet: WalletRecord): Promise<void>;
}

export function createWalletRepository(db: Pool): WalletRepository {
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

  async function getWalletByPrivyUserId(privyUserId: string): Promise<WalletRecord | null> {
    const result = await db.query<{
      wallet_id: string;
      wallet_address: string;
      public_key: string | null;
    }>(
      `
        SELECT wallet_id, wallet_address, public_key
        FROM user_wallets
        WHERE privy_user_id = $1
        LIMIT 1
      `,
      [privyUserId],
    );

    if (result.rowCount === 0) {
      return null;
    }

    const row = result.rows[0];
    return {
      id: row.wallet_id,
      address: row.wallet_address,
      publicKey: row.public_key ?? undefined,
    };
  }

  async function upsertWalletForPrivyUser(privyUserId: string, wallet: WalletRecord) {
    await ensureAppUser(privyUserId);

    await db.query(
      `
        INSERT INTO user_wallets (
          privy_user_id,
          wallet_id,
          wallet_address,
          public_key,
          updated_at
        )
        VALUES ($1, $2, $3, $4, NOW())
        ON CONFLICT (privy_user_id)
        DO UPDATE SET
          wallet_id = EXCLUDED.wallet_id,
          wallet_address = EXCLUDED.wallet_address,
          public_key = EXCLUDED.public_key,
          updated_at = NOW()
      `,
      [privyUserId, wallet.id, wallet.address, wallet.publicKey ?? null],
    );
  }

  return {
    ensureAppUser,
    getWalletByPrivyUserId,
    upsertWalletForPrivyUser,
  };
}
