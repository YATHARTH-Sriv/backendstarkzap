import { ChainId } from "starkzap";

export type ChainIdLiteral = "SN_MAIN" | "SN_SEPOLIA";
export type WalletDeployFeeMode = "user_pays" | "sponsored";

export interface AppConfig {
  rpcUrl: string;
  counterContractAddress: string;
  chainIdLiteral: ChainIdLiteral;
  walletDeployFeeMode: WalletDeployFeeMode;
  predictionContractAddress: string;
  strkTokenContractAddress: string;
  databaseUrl: string;
  chainId: ChainId;
  port: number;
}

function normalizeDatabaseUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    const sslMode = parsed.searchParams.get("sslmode");

    if (sslMode === "prefer" || sslMode === "require" || sslMode === "verify-ca") {
      parsed.searchParams.set("sslmode", "verify-full");
    }

    return parsed.toString();
  } catch {
    return rawUrl;
  }
}

function parseChainId(chainIdLiteral: string): { chainIdLiteral: ChainIdLiteral; chainId: ChainId } {
  if (chainIdLiteral === "SN_MAIN") {
    return {
      chainIdLiteral,
      chainId: ChainId.MAINNET,
    };
  }

  if (chainIdLiteral === "SN_SEPOLIA") {
    return {
      chainIdLiteral,
      chainId: ChainId.SEPOLIA,
    };
  }

  throw new Error("STARKNET_CHAIN_ID must be SN_MAIN or SN_SEPOLIA");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const rpcUrl = env.RPC_URL ?? "";
  const counterContractAddress = env.COUNTER_CONTRACT_ADDRESS ?? "";
  const walletDeployFeeMode = env.WALLET_DEPLOY_FEE_MODE ?? "user_pays";
  const predictionContractAddress = env.PREDICTION_CONTRACT ?? "";
  const strkTokenContractAddress =
    env.STRK_TOKEN_CONTRACT_ADDRESS ?? env.STRK_TOKEN ?? "";
  const databaseUrlRaw = env.DATABASE_URL ?? env.DB_URL ?? "";
  const chainIdLiteralRaw = env.STARKNET_CHAIN_ID ?? "SN_SEPOLIA";
  const port = Number(env.PORT ?? 8001);

  if (!rpcUrl) {
    throw new Error("Missing RPC_URL in environment");
  }

  if (!counterContractAddress) {
    throw new Error("Missing COUNTER_CONTRACT_ADDRESS in environment");
  }

  if (!predictionContractAddress) {
    throw new Error("Missing PREDICTION_CONTRACT in environment");
  }

  if (!strkTokenContractAddress) {
    throw new Error("Missing STRK_TOKEN_CONTRACT_ADDRESS (or STRK_TOKEN) in environment");
  }

  if (!databaseUrlRaw) {
    throw new Error("Missing DATABASE_URL (or DB_URL) in environment");
  }

  if (walletDeployFeeMode !== "user_pays" && walletDeployFeeMode !== "sponsored") {
    throw new Error("WALLET_DEPLOY_FEE_MODE must be user_pays or sponsored");
  }

  const { chainIdLiteral, chainId } = parseChainId(chainIdLiteralRaw);

  return {
    rpcUrl,
    counterContractAddress,
    chainIdLiteral,
    walletDeployFeeMode,
    predictionContractAddress,
    strkTokenContractAddress,
    databaseUrl: normalizeDatabaseUrl(databaseUrlRaw),
    chainId,
    port,
  };
}
