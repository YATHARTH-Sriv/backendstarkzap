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
  let hex = "";

  for (let i = 0; i < trimmed.length; i++) {
    const charCode = trimmed.charCodeAt(i).toString(16);
    hex += charCode.padStart(2, "0");
  }

  return `0x${hex}`;
}

export function felt252ToString(hex: string): string {
  if (!hex || hex === "0x0" || hex === "0") return "";
  
  let cleanHex = hex.startsWith("0x") ? hex.slice(2) : hex;
  // If hex length is odd, add a leading zero
  if (cleanHex.length % 2 !== 0) {
    cleanHex = "0" + cleanHex;
  }
  
  try {
    const buf = Buffer.from(cleanHex, "hex");
    return buf.toString("ascii").replace(/\0/g, "");
  } catch (e) {
    console.error("Failed to parse felt as string", hex, e);
    return hex;
  }
}
