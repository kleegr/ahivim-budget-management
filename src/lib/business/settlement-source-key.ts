export const MAX_SETTLEMENT_SOURCE_KEY_LENGTH = 512;

export function validSettlementSourceKey(value: string): boolean {
  return value.length > 0
    && value.length <= MAX_SETTLEMENT_SOURCE_KEY_LENGTH
    && !/[\u0000-\u001f\u007f]/.test(value);
}
