/**
 * The normalized payment vocabulary shared by both SDKs.
 *
 * Only what the UI consumes is normalized. The SDK surface is not
 * abstracted — screens that need rail-specific fields narrow on `rail`
 * and read `raw`.
 */

export type Rail = "spark" | "liquid";

export type RailPaymentStatus = "pending" | "complete" | "failed";

export type RailPaymentMethod =
  | "lightning"
  | "onchain"
  | "spark"
  | "liquid"
  | "usdt";

export interface RailPayment {
  /** Stable id. Spark: `payment.id`. Liquid: `txId`, falling back to a synthetic key. */
  id: string;
  rail: Rail;
  direction: "send" | "receive";
  status: RailPaymentStatus;
  /** Integer sats. Always positive; use `direction` for sign. */
  amountSat: number;
  feeSat: number;
  /** Unix seconds. */
  timestamp: number;
  method: RailPaymentMethod;
  /** Liquid only. Present for L-BTC and L-USDT. */
  assetId?: string;
  /** The source SDK payment, for rail-specific detail screens. */
  raw: unknown;
}

export type RailConnectionState = "connecting" | "connected" | "unavailable";

export interface RailBalance {
  rail: Rail;
  /** Integer sats. For Liquid this is the L-BTC balance. */
  balanceSat: number;
  /** Liquid only: per-asset balances, including USDT. */
  assets?: Array<{ assetId: string; balance: number }>;
}

export type RailEvent =
  | { type: "synced"; rail: Rail }
  | { type: "paymentPending"; rail: Rail; payment: RailPayment }
  | { type: "paymentSucceeded"; rail: Rail; payment: RailPayment }
  | { type: "paymentFailed"; rail: Rail; payment: RailPayment }
  | { type: "balanceChanged"; rail: Rail }
  /** Spark only: on-chain deposits needing manual claim. */
  | { type: "depositsNeedClaim"; rail: "spark"; count: number };

export interface RailAdapter {
  readonly rail: Rail;
  /** `userId` lets the Liquid SDK detect account switches; Spark ignores it. */
  connect(mnemonic: string, userId?: string): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  getBalance(): Promise<RailBalance>;
  listPayments(limit?: number): Promise<RailPayment[]>;
  onEvent(handler: (event: RailEvent) => void): Promise<string>;
  offEvent(listenerId: string): Promise<void>;
}
