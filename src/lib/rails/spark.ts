import * as sparkSdk from "@breeztech/breez-sdk-spark/web";
import init from "@breeztech/breez-sdk-spark/web";
import { sdkLogger } from "$lib/logger";
import type { RailAdapter, RailBalance, RailEvent, RailPayment } from "./types";

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

  async listPayments(): Promise<RailPayment[]> {
    return [];
  },

  async onEvent(): Promise<string> {
    return "";
  },

  async offEvent(): Promise<void> {},
};

/** Internal accessor for sibling modules in this directory. */
export function getSparkSdk(): sparkSdk.BreezSdk | null {
  return sdk;
}
