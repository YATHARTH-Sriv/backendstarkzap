export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export function isLikelyFundingOrFeeConfigError(message: string): boolean {
  return /(insufficient|not enough|balance|fee|gas|paymaster|sponsor|max fee)/i.test(message);
}

export function isValidateOutOfGasError(message: string): boolean {
  return /(validate).*(out of gas)|(out of gas).*(validate)/i.test(message);
}

export function isNonceTooOldError(message: string): boolean {
  return /NonceTooOld|Invalid transaction nonce/i.test(message);
}
