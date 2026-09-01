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
 *
 * It does, however, require the wasm module: `getSparkStatus` is a free
 * export whose glue dereferences the module-level `wasm` binding, which
 * stays undefined until `init()` runs. The status banner calls this from
 * onMount, long before the layout finishes deriving the wallet and calling
 * connect(), so without initWasm() here the first check on every page load
 * threw on an undefined binding and reported "unknown".
 */
export async function getSparkNetworkStatus(): Promise<sparkSdk.ServiceStatus> {
  try {
    await initWasm();
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
    try {
      await sdk.disconnect();
    } finally {
      // Null it regardless. If disconnect() rejects and we leave sdk set,
      // isConnected() keeps reporting true for a torn-down session and the
      // connect() guard below no-ops forever — the wallet is stuck until a
      // page reload. walletService does the same on the Liquid side.
      sdk = null;
    }
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

/**
 * A registered Lightning address, shaped for this app's existing consumers.
 *
 * Spark returns `lnurl` as `{ url, bech32 }`, but `lnAddressStore.setSuccess`
 * and the profile POST both expect a string, so it is flattened here rather
 * than at every call site. `bip353Address` has no Spark equivalent — the old
 * breez.fun flow supplied it — so it is always undefined; the store already
 * coerces that to null, and PaymentDetails reads its own copy off historical
 * payment details, not from here.
 */
export interface SparkLightningAddress {
  username: string;
  lightningAddress: string;
  description: string;
  /** bech32 form, falling back to the raw URL. */
  lnurl: string;
  bip353Address?: undefined;
}

function toAddressResult(info: unknown): SparkLightningAddress {
  const i = info as {
    username?: string;
    lightningAddress?: string;
    description?: string;
    lnurl?: { url?: string; bech32?: string };
  };
  return {
    username: i.username ?? "",
    lightningAddress: i.lightningAddress ?? "",
    description: i.description ?? "",
    lnurl: i.lnurl?.bech32 || i.lnurl?.url || "",
    bip353Address: undefined,
  };
}

export async function checkLightningAddressAvailable(
  username: string,
): Promise<boolean> {
  const sdk = getSparkSdk();
  if (!sdk) throw new Error("Spark rail unavailable");
  return await sdk.checkLightningAddressAvailable({ username });
}

export async function registerLightningAddress(
  username: string,
  description?: string,
): Promise<SparkLightningAddress> {
  const sdk = getSparkSdk();
  if (!sdk) throw new Error("Spark rail unavailable");
  const info = await sdk.registerLightningAddress({ username, description });
  return toAddressResult(info);
}

export async function getLightningAddress(): Promise<SparkLightningAddress | null> {
  const sdk = getSparkSdk();
  if (!sdk) return null;
  const info = await sdk.getLightningAddress();
  return info ? toAddressResult(info) : null;
}

export async function deleteLightningAddress(): Promise<void> {
  const sdk = getSparkSdk();
  if (!sdk) throw new Error("Spark rail unavailable");
  await sdk.deleteLightningAddress();
}

/**
 * A deposit the automatic ceiling would not cover.
 *
 * `requiredFeeSats` comes from the SDK's own claim error and is the exact
 * fee needed. Never invent a ceiling from the deposit amount — that would
 * permit a fee up to 100% of the deposit.
 */
export interface UnclaimedDeposit {
  txid: string;
  vout: number;
  amountSats: number;
  isMature: boolean;
  requiredFeeSats?: number;
}

export async function listUnclaimedDeposits(): Promise<UnclaimedDeposit[]> {
  const sdk = getSparkSdk();
  if (!sdk) return [];
  const response = await sdk.listUnclaimedDeposits({});
  return (response.deposits ?? []).map((d) => {
    const error = d.claimError as
      | { type: string; requiredFeeSats?: number }
      | undefined;
    return {
      txid: d.txid,
      vout: d.vout,
      amountSats: Number(d.amountSats ?? 0),
      isMature: Boolean(d.isMature),
      requiredFeeSats:
        error?.type === "maxDepositClaimFeeExceeded"
          ? Number(error.requiredFeeSats ?? 0)
          : undefined,
    };
  });
}

/**
 * Claim a deposit the automatic ceiling would not cover.
 *
 * `maxFeeSat` must be at least the SDK's quoted fee, or the call returns
 * MaxDepositClaimFeeExceeded and the deposit waits for maturity instead.
 * Pass the deposit's `requiredFeeSats` — nothing larger.
 *
 * Note: the docs describe `fetchClaimDepositQuote`, which does NOT exist in
 * pinned 0.23.0 (the docs track main). The claim error carries the fee
 * instead. Revisit on the next SDK bump.
 */
export async function claimDeposit(
  txid: string,
  vout: number,
  maxFeeSat: number,
): Promise<void> {
  const sdk = getSparkSdk();
  if (!sdk) throw new Error("Spark rail unavailable");
  await sdk.claimDeposit({
    txid,
    vout,
    maxFee: { type: "fixed", amount: maxFeeSat },
  });
}
