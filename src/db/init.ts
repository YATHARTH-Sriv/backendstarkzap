import type { Pool } from "pg";

export async function initDatabase(db: Pool) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS app_users (
      privy_user_id TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE app_users
      ADD COLUMN IF NOT EXISTS username TEXT;

    ALTER TABLE app_users
      ADD COLUMN IF NOT EXISTS onboarding_step TEXT NOT NULL DEFAULT 'welcome';

    ALTER TABLE app_users
      ADD COLUMN IF NOT EXISTS onboarding_completed BOOLEAN NOT NULL DEFAULT FALSE;

    ALTER TABLE app_users
      ADD COLUMN IF NOT EXISTS onboarding_completed_at TIMESTAMPTZ;

    CREATE UNIQUE INDEX IF NOT EXISTS idx_app_users_username_unique_ci
      ON app_users ((LOWER(username)))
      WHERE username IS NOT NULL;

    CREATE TABLE IF NOT EXISTS user_wallets (
      privy_user_id TEXT PRIMARY KEY REFERENCES app_users(privy_user_id) ON DELETE CASCADE,
      wallet_id TEXT NOT NULL UNIQUE,
      wallet_address TEXT NOT NULL UNIQUE,
      public_key TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS user_transaction_activity (
      id UUID PRIMARY KEY,
      privy_user_id TEXT NOT NULL REFERENCES app_users(privy_user_id) ON DELETE CASCADE,
      action TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('success', 'failed')),
      tx_hash TEXT,
      explorer_url TEXT,
      details TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_user_transaction_activity_user_created_at
      ON user_transaction_activity(privy_user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS user_direct_payments (
      id UUID PRIMARY KEY,
      sender_privy_user_id TEXT NOT NULL REFERENCES app_users(privy_user_id) ON DELETE CASCADE,
      sender_username TEXT NOT NULL,
      sender_wallet_address TEXT NOT NULL,
      recipient_privy_user_id TEXT REFERENCES app_users(privy_user_id) ON DELETE CASCADE,
      recipient_username TEXT NOT NULL,
      recipient_wallet_address TEXT NOT NULL,
      token_symbol TEXT NOT NULL,
      token_contract_address TEXT NOT NULL,
      amount_raw TEXT NOT NULL,
      amount_unit TEXT NOT NULL,
      tx_hash TEXT,
      explorer_url TEXT,
      status TEXT NOT NULL CHECK (status IN ('success', 'failed')),
      details TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE user_direct_payments
      ALTER COLUMN recipient_privy_user_id DROP NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_user_direct_payments_sender_created_at
      ON user_direct_payments(sender_privy_user_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_user_direct_payments_recipient_created_at
      ON user_direct_payments(recipient_privy_user_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_user_direct_payments_pair_created_at
      ON user_direct_payments(
        LEAST(sender_privy_user_id, recipient_privy_user_id),
        GREATEST(sender_privy_user_id, recipient_privy_user_id),
        created_at DESC
      );

    CREATE INDEX IF NOT EXISTS idx_user_direct_payments_sender_wallet_created_at
      ON user_direct_payments(sender_privy_user_id, recipient_wallet_address, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_user_direct_payments_recipient_wallet_created_at
      ON user_direct_payments(recipient_privy_user_id, sender_wallet_address, created_at DESC);

    CREATE TABLE IF NOT EXISTS chat_profiles (
      username TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS chat_rooms (
      room_name TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS chat_room_members (
      room_name TEXT NOT NULL REFERENCES chat_rooms(room_name) ON DELETE CASCADE,
      username TEXT NOT NULL REFERENCES chat_profiles(username) ON DELETE CASCADE,
      joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (room_name, username)
    );

    CREATE TABLE IF NOT EXISTS chat_messages (
      id UUID PRIMARY KEY,
      room_name TEXT NOT NULL REFERENCES chat_rooms(room_name) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      username TEXT NOT NULL REFERENCES chat_profiles(username) ON DELETE RESTRICT,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_chat_messages_room_created_at
      ON chat_messages(room_name, created_at DESC);

    CREATE TABLE IF NOT EXISTS chat_private_messages (
      id UUID PRIMARY KEY,
      from_user_id TEXT NOT NULL,
      from_username TEXT NOT NULL REFERENCES chat_profiles(username) ON DELETE RESTRICT,
      to_user_id TEXT NOT NULL,
      to_username TEXT NOT NULL REFERENCES chat_profiles(username) ON DELETE RESTRICT,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_chat_private_messages_created_at
      ON chat_private_messages(created_at DESC);

    CREATE TABLE IF NOT EXISTS room_external_markets (
      id UUID PRIMARY KEY,
      room_name TEXT NOT NULL REFERENCES chat_rooms(room_name) ON DELETE CASCADE,
      source TEXT NOT NULL CHECK (source IN ('polymarket', 'kalshi')),
      source_url TEXT NOT NULL,
      external_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      image TEXT,
      outcomes JSONB NOT NULL DEFAULT '[]'::jsonb,
      outcome_prices JSONB NOT NULL DEFAULT '[]'::jsonb,
      closes_at TIMESTAMPTZ,
      raw_payload JSONB NOT NULL,
      linked_by_username TEXT REFERENCES chat_profiles(username) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_room_external_markets_room_created_at
      ON room_external_markets(room_name, created_at DESC);

    CREATE TABLE IF NOT EXISTS room_contract_markets (
      id UUID PRIMARY KEY,
      room_name TEXT NOT NULL REFERENCES chat_rooms(room_name) ON DELETE CASCADE,
      prediction_contract_address TEXT NOT NULL,
      market_id BIGINT NOT NULL,
      title TEXT,
      deadline_unix BIGINT,
      create_tx_hash TEXT,
      created_by_privy_user_id TEXT NOT NULL REFERENCES app_users(privy_user_id) ON DELETE RESTRICT,
      created_by_wallet_address TEXT NOT NULL,
      external_market_link_id UUID REFERENCES room_external_markets(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (prediction_contract_address, market_id),
      UNIQUE (room_name, prediction_contract_address, market_id)
    );

    CREATE INDEX IF NOT EXISTS idx_room_contract_markets_room_created_at
      ON room_contract_markets(room_name, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_room_contract_markets_contract_market
      ON room_contract_markets(prediction_contract_address, market_id);
  `);

  console.log("Database initialized");
}
