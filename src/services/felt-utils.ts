export const STARK_FIELD_PRIME = BigInt(
  "0x800000000000011000000000000000000000000000000000000000000000001",
);

export function isStarknetFeltHex(value: string): boolean {
  if (!/^0x[0-9a-fA-F]+$/.test(value)) {
    return false;
  }

  try {
    const parsed = BigInt(value);
    return parsed >= 0n && parsed < STARK_FIELD_PRIME;
  } catch {
    return false;
  }
}

export function parsePositiveIntAsBigInt(value: unknown): bigint | null {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value <= 0) {
      return null;
    }
    return BigInt(value);
  }

  if (typeof value === "string") {
    if (!/^[1-9][0-9]*$/.test(value)) {
      return null;
    }
    return BigInt(value);
  }

  return null;
}

export function parseNonNegativeIntAsBigInt(value: unknown): bigint | null {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      return null;
    }
    return BigInt(value);
  }

  if (typeof value === "string") {
    if (!/^(0|[1-9][0-9]*)$/.test(value)) {
      return null;
    }
    return BigInt(value);
  }

  return null;
}

export function toFeltHex(value: bigint): string {
  return `0x${value.toString(16)}`;
}

export function stringToFelt252(str: string): string {
  const trimmed = str.slice(0, 31);
  let hex = "0x";

  for (let i = 0; i < trimmed.length; i++) {
    hex += trimmed.charCodeAt(i).toString(16);
  }

  return hex;
}
