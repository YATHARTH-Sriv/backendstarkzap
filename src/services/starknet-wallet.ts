import { PrivyClient } from "@privy-io/node";
import {
  ArgentXV050Preset,
  AvnuSwapProvider,
  ChainId,
  EkuboSwapProvider,
  PrivySigner,
  type Call,
  type StarkZap,
} from "starkzap";
import type { WalletDeployFeeMode } from "../config/env.ts";
import type { WalletRecord } from "../db/wallet-repo.ts";
import {
  getErrorMessage,
  isLikelyFundingOrFeeConfigError,
  isNonceTooOldError,
  isValidateOutOfGasError,
} from "./error-utils.ts";

type ResourceBoundsBN = {
  l1_gas: { max_amount: bigint; max_price_per_unit: bigint };
  l2_gas: { max_amount: bigint; max_price_per_unit: bigint };
  l1_data_gas: { max_amount: bigint; max_price_per_unit: bigint };
};

export interface TransactionExecution {
  txHash: string;
  explorerUrl: string;
  executionMode: "v3_default" | "v3_boosted_bounds";
}

export interface WalletNotReadyPayload {
  error: string;
  details: string;
  chainId: "SN_MAIN" | "SN_SEPOLIA";
  hint: string;
}

function boostResourceBounds(bounds: ResourceBoundsBN): ResourceBoundsBN {
  const boostAmount = 4n;
  const boostPrice = 2n;

  return {
    l1_gas: {
      max_amount: bounds.l1_gas.max_amount * boostAmount,
      max_price_per_unit: bounds.l1_gas.max_price_per_unit * boostPrice,
    },
    l2_gas: {
      max_amount: bounds.l2_gas.max_amount * boostAmount,
      max_price_per_unit: bounds.l2_gas.max_price_per_unit * boostPrice,
    },
    l1_data_gas: {
      max_amount: bounds.l1_data_gas.max_amount * boostAmount,
      max_price_per_unit: bounds.l1_data_gas.max_price_per_unit * boostPrice,
    },
  };
}

export function createStarknetWalletService(params: {
  privy: PrivyClient;
  sdk: StarkZap;
  chainId: ChainId;
  walletDeployFeeMode: WalletDeployFeeMode;
}) {
  const { privy, sdk, chainId, walletDeployFeeMode } = params;

  function explorerTxUrl(txHash: string): string {
    return chainId.isMainnet()
      ? `https://voyager.online/tx/${txHash}`
      : `https://sepolia.voyager.online/tx/${txHash}`;
  }

  function buildDeploymentHint(message: string, walletAddress?: string): string | undefined {
    const walletPart = walletAddress ? `Wallet address: ${walletAddress}. ` : "";

    if (/exceed balance \(0\)|balance \(0\)/i.test(message)) {
      return `${walletPart}Wallet has zero fee-token balance on ${chainId.toLiteral()}. Fund this exact address on the same network, or set WALLET_DEPLOY_FEE_MODE=sponsored with a working paymaster.`;
    }

    if (/class_hash|class hash|invalid class/i.test(message)) {
      return `${walletPart}Account class/network mismatch detected. Confirm STARKNET_CHAIN_ID matches where this wallet/account class is supported.`;
    }

    return undefined;
  }

  function deploymentResponse(ready: boolean, message?: string, walletAddress?: string) {
    return {
      ready,
      mode: walletDeployFeeMode,
      chainId: chainId.toLiteral(),
      message,
      hint: message ? buildDeploymentHint(message, walletAddress) : undefined,
    };
  }

  function buildWalletNotReadyResponse(
    error: unknown,
    walletAddress?: string,
  ): { statusCode: number; payload: WalletNotReadyPayload } {
    const message = getErrorMessage(error);
    const statusCode = isLikelyFundingOrFeeConfigError(message) ? 402 : 500;
    const deploymentHint = buildDeploymentHint(message, walletAddress);

    return {
      statusCode,
      payload: {
        error: "Wallet is not ready for state-changing transactions",
        details: message,
        chainId: chainId.toLiteral(),
        hint:
          deploymentHint ??
          (walletDeployFeeMode === "sponsored"
            ? "Ensure paymaster sponsorship is configured and available"
            : "Fund the wallet with fee token on the configured network or set WALLET_DEPLOY_FEE_MODE=sponsored"),
      },
    };
  }

  async function getUserWalletInterface(wallet: WalletRecord) {
    if (!wallet.publicKey) {
      throw new Error(
        "Wallet has no public key. Recreate the wallet record so it includes publicKey.",
      );
    }

    const signer = new PrivySigner({
      walletId: wallet.id,
      publicKey: wallet.publicKey,
      rawSign: async (walletId, hash) => {
        const result = await privy.wallets().rawSign(walletId, {
          params: { hash },
        });
        return result.signature;
      },
    });

    return sdk.connectWallet({
      account: {
        signer,
        accountClass: ArgentXV050Preset,
      },
      swapProviders: [new AvnuSwapProvider(), new EkuboSwapProvider()],
      defaultSwapProviderId: "avnu",
    });
  }

  async function ensureWalletReadyForWrites(wallet: WalletRecord) {
    const userWallet = await getUserWalletInterface(wallet);
    await userWallet.ensureReady({
      deploy: "if_needed",
    });
    return userWallet;
  }

  async function executeCallsWithOogRetry(
    userWallet: Awaited<ReturnType<typeof getUserWalletInterface>>,
    calls: Call[],
    retryCount = 0,
  ): Promise<TransactionExecution> {
    try {
      const tx = await userWallet.execute(calls);
      return {
        txHash: tx.hash,
        explorerUrl: tx.explorerUrl,
        executionMode: "v3_default",
      };
    } catch (error) {
      const message = getErrorMessage(error);

      if (isNonceTooOldError(message) && retryCount < 1) {
        console.warn(`Nonce too old, retrying once... (Address: ${userWallet.getAccount().address})`);
        // Small delay to let the mempool update if needed, though usually not necessary if it's just a local sync issue
        await new Promise(resolve => setTimeout(resolve, 500));
        return executeCallsWithOogRetry(userWallet, calls, retryCount + 1);
      }

      if (!isValidateOutOfGasError(message)) {
        throw error;
      }

      const account = userWallet.getAccount();
      const estimated = await account.estimateInvokeFee(calls);
      const boosted = boostResourceBounds(estimated.resourceBounds as ResourceBoundsBN);

      const invoke = await account.execute(calls, {
        resourceBounds: boosted,
        tip: 0,
      });

      return {
        txHash: invoke.transaction_hash,
        explorerUrl: explorerTxUrl(invoke.transaction_hash),
        executionMode: "v3_boosted_bounds",
      };
    }
  }

  async function executeWithOogRetry(
    userWallet: Awaited<ReturnType<typeof getUserWalletInterface>>,
    call: Call,
  ): Promise<TransactionExecution> {
    return executeCallsWithOogRetry(userWallet, [call]);
  }

  return {
    buildDeploymentHint,
    deploymentResponse,
    buildWalletNotReadyResponse,
    getUserWalletInterface,
    ensureWalletReadyForWrites,
    executeCallsWithOogRetry,
    executeWithOogRetry,
  };
}

export type StarknetWalletService = ReturnType<typeof createStarknetWalletService>;
