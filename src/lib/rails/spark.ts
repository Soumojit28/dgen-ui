import * as sparkSdk from "@breeztech/breez-sdk-spark/web";
import init from "@breeztech/breez-sdk-spark/web";
import { sdkLogger } from "$lib/logger";
import type { RailAdapter, RailBalance, RailEvent, RailPayment } from "./types";
import type { RailPaymentStatus, RailPaymentMethod } from "./types";

let sdk: sparkSdk.BreezSdk | null = null;
let wasmReady = false;
let connecting = false;

const STORAGE_DIR = "./spark_data";

async function initWasm(): Promise<void> {
  if (wasmReady) return;
  await init();
  wasmReady = true;
  sdkLogger.info("[rails/spark] wasm initialised");
}

function buildConfig(): sparkSdk.Config {
  const config = sparkSdk.defaultConfig("mainnet");

  const apiKey =
    import.meta.env.VITE_SPARK_API_KEY || import.meta.env.VITE_BREEZ_API_KEY;
  if (!apiKey) {
    throw new Error("Spark API key not found in environment variables");
  }
  config.apiKey = apiKey;

  // Lightning address domain. Breez allowlists this on request; until the
  // domain is registered, address registration will fail but payments work.
  const lnurlDomain = import.meta.env.VITE_LNURL_DOMAIN;
  if (lnurlDomain) {
    config.lnurlDomain = lnurlDomain;
  }

  // Deposits are claimed automatically up to this ceiling. The SDK default
  // is 1 sat/vbyte (~99 sats), below any provider spread, which would leave
  // deposits unclaimed whenever fees rise (spec 7). Use the recommended
  // rate at claim time instead; anything above it goes to manual claim.
  config.maxDepositClaimFee = {
    type: "networkRecommended",
    leewaySatPerVbyte: 2,
  };

  return config;
}

/**
 * Spark network health. Requires no SDK instance, so it can be called
 * before or independently of connecting. Breez's production checklist
 * requires surfacing this.
 */
export async function getSparkNetworkStatus(): Promise<sparkSdk.ServiceStatus> {
  try {
    const status = await sparkSdk.getSparkStatus();
    return status.status ?? "unknown";
  } catch (error) {
    sdkLogger.warn("[rails/spark] status check failed:", error);
    return "unknown";
  }
}

function mapStatus(status: unknown): RailPaymentStatus {
  switch (status) {
    case "completed":
      return "complete";
    case "failed":
      return "failed";
    default:
      // pending and anything unrecognised. Never drop a payment.
      return "pending";
  }
}

function mapMethod(method: unknown): RailPaymentMethod {
  switch (method) {
    case "deposit":
    case "withdraw":
      return "onchain";
    case "spark":
      return "spark";
    case "token":
      return "token";
    default:
      return "lightning";
  }
}

/**
 * Exported for tests. Maps a Spark SDK payment into the shared shape.
 *
 * Spark returns bigint amounts; they convert to number here and nowhere
 * else. Max possible sats (2.1e15) is well inside Number.MAX_SAFE_INTEGER
 * (9.0e15), so this is lossless for any real balance.
 */
export function toRailPayment(payment: unknown): RailPayment {
  const p = payment as Record<string, any>;
  const method = mapMethod(p.method);

  // Spark reuses one `amount` field for every method, but a token payment's
  // amount is in the token's own units, not sats. Reporting it as sats would
  // render 100 USDB as 1 BTC. Tokens are out of scope (spec 9) and should
  // never appear; if one does, keep it visible with a zero amount and the
  // true value in `raw` rather than displaying a fabricated figure.
  const isToken = method === "token";
  if (isToken) {
    sdkLogger.warn(
      `[rails/spark] token payment ${p.id} — amount not in sats, reporting 0`,
    );
  }

  return {
    id: String(p.id ?? ""),
    rail: "spark",
    direction: p.paymentType === "send" ? "send" : "receive",
    status: mapStatus(p.status),
    amountSat: isToken ? 0 : Number(p.amount ?? 0),
    feeSat: isToken ? 0 : Number(p.fees ?? 0),
    timestamp: Number(p.timestamp ?? 0),
    method,
    raw: payment,
  };
}

export const sparkAdapter: RailAdapter = {
  rail: "spark",

  async connect(mnemonic: string, _userId?: string): Promise<void> {
    // _userId is part of the RailAdapter contract for Liquid's benefit;
    // Spark derives its identity from the seed alone.
    if (connecting || sdk) return;
    try {
      connecting = true;
      await initWasm();
      sdk = await sparkSdk.connect({
        config: buildConfig(),
        seed: { type: "mnemonic", mnemonic },
        storageDir: STORAGE_DIR,
      });
      sdkLogger.info("[rails/spark] connected");
    } catch (error) {
      sdk = null;
      sdkLogger.error("[rails/spark] connection failed:", error);
      throw error;
    } finally {
      connecting = false;
    }
  },

  async disconnect(): Promise<void> {
    if (!sdk) return;
    await sdk.disconnect();
    sdk = null;
    sdkLogger.info("[rails/spark] disconnected");
  },

  isConnected(): boolean {
    return sdk !== null;
  },

  async getBalance(): Promise<RailBalance> {
    if (!sdk) return { rail: "spark", balanceSat: 0 };
    const info = await sdk.getInfo({});
    return { rail: "spark", balanceSat: Number(info.balanceSats ?? 0) };
  },

  async listPayments(limit = 100): Promise<RailPayment[]> {
    if (!sdk) return [];
    const response = await sdk.listPayments({ limit });
    return (response.payments ?? []).map(toRailPayment);
  },

  async onEvent(handler: (event: RailEvent) => void): Promise<string> {
    if (!sdk) throw new Error("Spark SDK not connected");
    return await sdk.addEventListener({
      onEvent: (event: sparkSdk.SdkEvent) => {
        switch (event.type) {
          case "synced":
            handler({ type: "synced", rail: "spark" });
            break;
          case "paymentSucceeded":
            handler({
              type: "paymentSucceeded",
              rail: "spark",
              payment: toRailPayment(event.payment),
            });
            break;
          case "paymentPending":
            handler({
              type: "paymentPending",
              rail: "spark",
              payment: toRailPayment(event.payment),
            });
            break;
          case "paymentFailed":
            handler({
              type: "paymentFailed",
              rail: "spark",
              payment: toRailPayment(event.payment),
            });
            break;
          case "unclaimedDeposits":
            handler({
              type: "depositsNeedClaim",
              rail: "spark",
              count: event.unclaimedDeposits?.length ?? 0,
            });
            break;
          case "claimedDeposits":
          case "newDeposits":
            break;
          default:
            sdkLogger.debug(`[rails/spark] unmapped event: ${event.type}`);
        }
        handler({ type: "balanceChanged", rail: "spark" });
      },
    });
  },

  async offEvent(id: string): Promise<void> {
    if (!sdk || !id) return;
    await sdk.removeEventListener(id);
  },
};

/** Internal accessor for sibling modules in this directory. */
export function getSparkSdk(): sparkSdk.BreezSdk | null {
  return sdk;
}
