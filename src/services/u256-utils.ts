import type { StarkZap } from "starkzap";

export type U256Parsed = {
  lowHex: string;
  highHex: string;
  value: bigint;
};

export function parseU256FromCallResult(result: string[]): U256Parsed {
  const lowHex = result[0] ?? "0x0";
  const highHex = result[1] ?? "0x0";
  const low = BigInt(lowHex);
  const high = BigInt(highHex);

  return {
    lowHex,
    highHex,
    value: low + (high << 128n),
  };
}

export function toU256Calldata(value: bigint): [string, string] {
  if (value < 0n) {
    throw new Error("u256 value cannot be negative");
  }

  const maxU256 = (1n << 256n) - 1n;
  if (value > maxU256) {
    throw new Error("u256 value out of range");
  }

  const lowMask = (1n << 128n) - 1n;
  const low = value & lowMask;
  const high = value >> 128n;
  return [`0x${low.toString(16)}`, `0x${high.toString(16)}`];
}

export function createErc20BalanceReader(sdk: StarkZap, tokenContractAddress: string) {
  return async function readErc20Balance(ownerAddress: string): Promise<U256Parsed> {
    const entrypoints = ["balanceOf", "balance_of"] as const;
    let lastError: unknown;

    for (const entrypoint of entrypoints) {
      try {
        const result = await sdk.callContract({
          contractAddress: tokenContractAddress,
          entrypoint,
          calldata: [ownerAddress],
        });

        return parseU256FromCallResult(result);
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError ?? new Error("Failed to read ERC20 balance");
  };
}
