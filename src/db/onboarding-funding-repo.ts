import type { Pool } from "pg";
import { v4 as uuidv4 } from "uuid";

export type OnboardingFundingStatus = "pending" | "success" | "failed";

export type OnboardingFundingRecord = {
  id: string;
  privyUserId: string;
  walletAddress: string;
  tokenContractAddress: string;
  amountRaw: string;
  amountStrk: string;
  status: OnboardingFundingStatus;
  txHash: string | null;
  explorerUrl: string | null;
  errorDetails: string | null;
  fundedByAddress: string | null;
  createdAt: string;
  updatedAt: string;
};

type OnboardingFundingRow = {
  id: string;
  privy_user_id: string;
  wallet_address: string;
  token_contract_address: string;
  amount_raw: string;
  amount_strk: string;
  status: OnboardingFundingStatus;
  tx_hash: string | null;
  explorer_url: string | null;
  error_details: string | null;
  funded_by_address: string | null;
  created_at: Date;
  updated_at: Date;
};

function mapRow(row: OnboardingFundingRow): OnboardingFundingRecord {
  return {
    id: row.id,
    privyUserId: row.privy_user_id,
    walletAddress: row.wallet_address,
    tokenContractAddress: row.token_contract_address,
    amountRaw: row.amount_raw,
    amountStrk: row.amount_strk,
    status: row.status,
    txHash: row.tx_hash,
    explorerUrl: row.explorer_url,
    errorDetails: row.error_details,
    fundedByAddress: row.funded_by_address,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export interface OnboardingFundingRepository {
  getByPrivyUserId(
    privyUserId: string,
  ): Promise<OnboardingFundingRecord | null>;
  upsertPending(input: {
    privyUserId: string;
    walletAddress: string;
    tokenContractAddress: string;
    amountRaw: string;
    amountStrk: string;
    fundedByAddress: string;
  }): Promise<OnboardingFundingRecord>;
  markSuccess(input: {
    privyUserId: string;
    walletAddress: string;
    tokenContractAddress: string;
    amountRaw: string;
    amountStrk: string;
    txHash: string;
    explorerUrl: string;
    fundedByAddress: string;
  }): Promise<OnboardingFundingRecord>;
  markFailed(input: {
    privyUserId: string;
    walletAddress: string;
    tokenContractAddress: string;
    amountRaw: string;
    amountStrk: string;
    errorDetails: string;
    fundedByAddress: string;
  }): Promise<OnboardingFundingRecord>;
}

export function createOnboardingFundingRepository(
  db: Pool,
): OnboardingFundingRepository {
  async function getByPrivyUserId(privyUserId: string) {
    const result = await db.query<OnboardingFundingRow>(
      `
        SELECT
          id,
          privy_user_id,
          wallet_address,
          token_contract_address,
          amount_raw,
          amount_strk,
          status,
          tx_hash,
          explorer_url,
          error_details,
          funded_by_address,
          created_at,
          updated_at
        FROM user_onboarding_funding
        WHERE privy_user_id = $1
        LIMIT 1
      `,
      [privyUserId],
    );

    if (result.rowCount === 0) {
      return null;
    }

    return mapRow(result.rows[0]);
  }

  async function upsertPending(input: {
    privyUserId: string;
    walletAddress: string;
    tokenContractAddress: string;
    amountRaw: string;
    amountStrk: string;
    fundedByAddress: string;
  }) {
    const result = await db.query<OnboardingFundingRow>(
      `
        INSERT INTO user_onboarding_funding (
          id,
          privy_user_id,
          wallet_address,
          token_contract_address,
          amount_raw,
          amount_strk,
          status,
          funded_by_address,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, NOW())
        ON CONFLICT (privy_user_id)
        DO UPDATE SET
          wallet_address = EXCLUDED.wallet_address,
          token_contract_address = EXCLUDED.token_contract_address,
          amount_raw = EXCLUDED.amount_raw,
          amount_strk = EXCLUDED.amount_strk,
          status = 'pending',
          tx_hash = NULL,
          explorer_url = NULL,
          error_details = NULL,
          funded_by_address = EXCLUDED.funded_by_address,
          updated_at = NOW()
        RETURNING
          id,
          privy_user_id,
          wallet_address,
          token_contract_address,
          amount_raw,
          amount_strk,
          status,
          tx_hash,
          explorer_url,
          error_details,
          funded_by_address,
          created_at,
          updated_at
      `,
      [
        uuidv4(),
        input.privyUserId,
        input.walletAddress,
        input.tokenContractAddress,
        input.amountRaw,
        input.amountStrk,
        input.fundedByAddress,
      ],
    );

    return mapRow(result.rows[0]);
  }

  async function markSuccess(input: {
    privyUserId: string;
    walletAddress: string;
    tokenContractAddress: string;
    amountRaw: string;
    amountStrk: string;
    txHash: string;
    explorerUrl: string;
    fundedByAddress: string;
  }) {
    const result = await db.query<OnboardingFundingRow>(
      `
        INSERT INTO user_onboarding_funding (
          id,
          privy_user_id,
          wallet_address,
          token_contract_address,
          amount_raw,
          amount_strk,
          status,
          tx_hash,
          explorer_url,
          funded_by_address,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, 'success', $7, $8, $9, NOW())
        ON CONFLICT (privy_user_id)
        DO UPDATE SET
          wallet_address = EXCLUDED.wallet_address,
          token_contract_address = EXCLUDED.token_contract_address,
          amount_raw = EXCLUDED.amount_raw,
          amount_strk = EXCLUDED.amount_strk,
          status = 'success',
          tx_hash = EXCLUDED.tx_hash,
          explorer_url = EXCLUDED.explorer_url,
          error_details = NULL,
          funded_by_address = EXCLUDED.funded_by_address,
          updated_at = NOW()
        RETURNING
          id,
          privy_user_id,
          wallet_address,
          token_contract_address,
          amount_raw,
          amount_strk,
          status,
          tx_hash,
          explorer_url,
          error_details,
          funded_by_address,
          created_at,
          updated_at
      `,
      [
        uuidv4(),
        input.privyUserId,
        input.walletAddress,
        input.tokenContractAddress,
        input.amountRaw,
        input.amountStrk,
        input.txHash,
        input.explorerUrl,
        input.fundedByAddress,
      ],
    );

    return mapRow(result.rows[0]);
  }

  async function markFailed(input: {
    privyUserId: string;
    walletAddress: string;
    tokenContractAddress: string;
    amountRaw: string;
    amountStrk: string;
    errorDetails: string;
    fundedByAddress: string;
  }) {
    const result = await db.query<OnboardingFundingRow>(
      `
        INSERT INTO user_onboarding_funding (
          id,
          privy_user_id,
          wallet_address,
          token_contract_address,
          amount_raw,
          amount_strk,
          status,
          error_details,
          funded_by_address,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, 'failed', $7, $8, NOW())
        ON CONFLICT (privy_user_id)
        DO UPDATE SET
          wallet_address = EXCLUDED.wallet_address,
          token_contract_address = EXCLUDED.token_contract_address,
          amount_raw = EXCLUDED.amount_raw,
          amount_strk = EXCLUDED.amount_strk,
          status = 'failed',
          tx_hash = NULL,
          explorer_url = NULL,
          error_details = EXCLUDED.error_details,
          funded_by_address = EXCLUDED.funded_by_address,
          updated_at = NOW()
        RETURNING
          id,
          privy_user_id,
          wallet_address,
          token_contract_address,
          amount_raw,
          amount_strk,
          status,
          tx_hash,
          explorer_url,
          error_details,
          funded_by_address,
          created_at,
          updated_at
      `,
      [
        uuidv4(),
        input.privyUserId,
        input.walletAddress,
        input.tokenContractAddress,
        input.amountRaw,
        input.amountStrk,
        input.errorDetails,
        input.fundedByAddress,
      ],
    );

    return mapRow(result.rows[0]);
  }

  return {
    getByPrivyUserId,
    upsertPending,
    markSuccess,
    markFailed,
  };
}
