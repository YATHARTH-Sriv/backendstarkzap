import { ChainId } from "starkzap";

export type ChainIdLiteral = "SN_MAIN" | "SN_SEPOLIA";
export type WalletDeployFeeMode = "user_pays" | "sponsored";

export interface AppConfig {
  rpcUrl: string;
  counterContractAddress: string;
  chainIdLiteral: ChainIdLiteral;
  walletDeployFeeMode: WalletDeployFeeMode;
  onboardingFundingEnabled: boolean;
  onboardingFundingAmountStrk: string;
  onboardingFunderAddress: string | null;
  onboardingFunderPrivateKey: string | null;
  predictionContractAddress: string;
  strkTokenContractAddress: string;
  databaseUrl: string;
  chainId: ChainId;
  port: number;
  stakingEstimatedApy: number;
  stakingFallbackPoolAddress: string;
}

function normalizeDatabaseUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    const sslMode = parsed.searchParams.get("sslmode");

    if (
      sslMode === "prefer" ||
      sslMode === "require" ||
      sslMode === "verify-ca"
    ) {
      parsed.searchParams.set("sslmode", "verify-full");
    }

    return parsed.toString();
  } catch {
    return rawUrl;
  }
}

function parseChainId(chainIdLiteral: string): {
  chainIdLiteral: ChainIdLiteral;
  chainId: ChainId;
} {
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

function parseBooleanEnv(rawValue: string, key: string): boolean {
  const normalized = rawValue.trim().toLowerCase();

  if (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "on"
  ) {
    return true;
  }

  if (
    normalized === "0" ||
    normalized === "false" ||
    normalized === "no" ||
    normalized === "off"
  ) {
    return false;
  }

  throw new Error(`${key} must be a boolean-like value (true/false)`);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const rpcUrl = env.RPC_URL ?? "";
  const counterContractAddress = env.COUNTER_CONTRACT_ADDRESS ?? "";
  const walletDeployFeeMode = env.WALLET_DEPLOY_FEE_MODE ?? "user_pays";
  const onboardingFundingEnabledRaw = env.ONBOARDING_FUNDING_ENABLED ?? "true";
  const onboardingFundingAmountStrkRaw =
    env.ONBOARDING_FUNDING_AMOUNT_STRK ?? "10";
  const onboardingFunderAddressRaw = env.ONBOARDING_FUNDER_ADDRESS ?? "";
  const onboardingFunderPrivateKeyRaw = env.ONBOARDING_FUNDER_PRIVATE_KEY ?? "";
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
    throw new Error(
      "Missing STRK_TOKEN_CONTRACT_ADDRESS (or STRK_TOKEN) in environment",
    );
  }

  if (!databaseUrlRaw) {
    throw new Error("Missing DATABASE_URL (or DB_URL) in environment");
  }

  if (
    walletDeployFeeMode !== "user_pays" &&
    walletDeployFeeMode !== "sponsored"
  ) {
    throw new Error("WALLET_DEPLOY_FEE_MODE must be user_pays or sponsored");
  }

  const onboardingFundingEnabled = parseBooleanEnv(
    onboardingFundingEnabledRaw,
    "ONBOARDING_FUNDING_ENABLED",
  );

  const onboardingFundingAmountStrk = onboardingFundingAmountStrkRaw.trim();
  const parsedFundingAmount = Number(onboardingFundingAmountStrk);

  if (!Number.isFinite(parsedFundingAmount) || parsedFundingAmount <= 0) {
    throw new Error("ONBOARDING_FUNDING_AMOUNT_STRK must be a positive number");
  }

  const onboardingFunderAddress = onboardingFunderAddressRaw.trim() || null;
  const onboardingFunderPrivateKey =
    onboardingFunderPrivateKeyRaw.trim() || null;

  const { chainIdLiteral, chainId } = parseChainId(chainIdLiteralRaw);

  return {
    rpcUrl,
    counterContractAddress,
    chainIdLiteral,
    walletDeployFeeMode,
    onboardingFundingEnabled,
    onboardingFundingAmountStrk,
    onboardingFunderAddress,
    onboardingFunderPrivateKey,
    predictionContractAddress,
    strkTokenContractAddress,
    databaseUrl: normalizeDatabaseUrl(databaseUrlRaw),
    chainId,
    port,
    stakingEstimatedApy: Number(env.STAKING_ESTIMATED_APY ?? "4.8"),
    stakingFallbackPoolAddress: env.STAKING_FALLBACK_POOL ?? "0x03588c95936917c9e6ba35e667ea33df501f595eb444301f7ecf1742a66f4676",
  };
}
