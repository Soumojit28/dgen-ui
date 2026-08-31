export const PROPAGATION_MESSAGE =
  "Your previous transaction is still propagating. Please wait a moment and try again.";

const PROPAGATION_HINTS = [
  "bad-txns-inputs-missingorspent",
  "Failed to parse response to txid",
  "sendrawtransaction RPC error -25",
  "ESPLORA_UPSTREAM_4XX",
  "Upstream request rejected",
];

export const mapTxError = (
  message: string | null | undefined,
  fallback = "Payment failed",
): string => {
  const text = message?.trim() ?? "";
  if (!text) return fallback;
  if (PROPAGATION_HINTS.some((hint) => text.includes(hint))) {
    return PROPAGATION_MESSAGE;
  }
  if (text.includes("MaxDepositClaimFeeExceeded")) {
    return "Network fees are too high to add this Bitcoin automatically. You can approve it manually.";
  }
  if (text.includes("DepositClaimInProgress")) {
    return "This deposit is already being added. It should appear shortly.";
  }
  if (text.includes("Spark rail unavailable")) {
    return "Bitcoin and Lightning payments are temporarily unavailable. Your money is safe.";
  }
  return text;
};
