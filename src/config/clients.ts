import { PrivyClient } from "@privy-io/node";
import { Pool } from "pg";
import { StarkZap } from "starkzap";
import type { AppConfig } from "./env.ts";

export function createPrivyClient(env: NodeJS.ProcessEnv = process.env): PrivyClient {
  const appId = env.PRIVY_APP_ID ?? "";
  const appSecret = env.PRIVY_APP_SECRET ?? "";

  if (!appId) {
    throw new Error("Missing PRIVY_APP_ID in environment");
  }

  if (!appSecret) {
    throw new Error("Missing PRIVY_APP_SECRET in environment");
  }

  return new PrivyClient({
    appId,
    appSecret,
  });
}

export function createStarkZap(config: AppConfig): StarkZap {
  return new StarkZap({
    rpcUrl: config.rpcUrl,
    chainId: config.chainId,
  });
}

export function createDbPool(config: AppConfig): Pool {
  return new Pool({
    connectionString: config.databaseUrl,
  });
}
