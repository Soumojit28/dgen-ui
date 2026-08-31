import {
  sparkAdapter,
  getSparkSdk,
  toRailPayment as toSparkPayment,
} from "./spark";
import { liquidAdapter, toRailPayment as toLiquidPayment } from "./liquid";
import { railForDestination, railForReceiveMethod } from "./router";
import * as walletService from "$lib/walletService";
import { sdkLogger } from "$lib/logger";
import { waitForOutgoingSlot, trackOutgoingTx } from "$lib/sendGate";
import type { Rail, RailAdapter, RailEvent, RailPayment } from "./types";

export * from "./types";
export { railForDestination, railForReceiveMethod } from "./router";
export { getSparkNetworkStatus } from "./spark";

export const adapters: Record<Rail, RailAdapter> = {
  spark: sparkAdapter,
  liquid: liquidAdapter,
};

export function adapterFor(rail: Rail): RailAdapter {
  return adapters[rail];
}

/**
 * Connect both rails in parallel, degrading independently.
 *
 * The wallet must never be dead because the less-used rail failed, so a
 * rejection on one side is logged and swallowed rather than propagated.
 * Callers read each rail's state via `isConnected()`.
 */
export async function connectRails(
  mnemonic: string,
  userId?: string,
): Promise<void> {
  const results = await Promise.allSettled([
    sparkAdapter.connect(mnemonic, userId),
    liquidAdapter.connect(mnemonic, userId),
  ]);

  results.forEach((result, i) => {
    const rail = i === 0 ? "spark" : "liquid";
    if (result.status === "rejected") {
      sdkLogger.error(`[rails] ${rail} failed to connect:`, result.reason);
    }
  });

  if (results.every((r) => r.status === "rejected")) {
    throw new Error("Both payment rails failed to connect");
  }
}

export async function disconnectRails(): Promise<void> {
  await Promise.allSettled([
    sparkAdapter.disconnect(),
    liquidAdapter.disconnect(),
  ]);
}

export interface PreparedSend {
  rail: Rail;
  amountSat: number;
  feeSat: number;
  destination: string;
  /** Rail-specific prepare response, passed straight back to sendPayment. */
  raw: unknown;
}

/**
 * Prepare a payment. The rail is chosen from the destination; callers
 * never pick.
 */
export async function prepareSend(
  destination: string,
  amountSat?: number,
): Promise<PreparedSend> {
  const rail = railForDestination(destination);

  if (rail === "spark") {
    const sdk = getSparkSdk();
    if (!sdk) throw new Error("Spark rail unavailable");
    const prepared = await sdk.prepareSendPayment({
      paymentRequest: { type: "input", input: destination.trim() },
      amount: amountSat !== undefined ? BigInt(amountSat) : undefined,
    });
    const method = prepared.paymentMethod as any;
    const feeSat = Number(
      method?.lightningFeeSats ??
        method?.fee ??
        method?.sparkTransferFeeSats ??
        0,
    );
    return {
      rail,
      amountSat: Number(prepared.amount ?? 0),
      feeSat,
      destination,
      raw: prepared,
    };
  }

  const prepared = await walletService.prepareSendPayment({
    destination: destination.trim(),
    amount:
      amountSat !== undefined
        ? { type: "bitcoin", receiverAmountSat: amountSat }
        : undefined,
  } as any);

  return {
    rail,
    amountSat: Number(
      (prepared as any)?.amount?.receiverAmountSat ?? amountSat ?? 0,
    ),
    feeSat: Number((prepared as any)?.feesSat ?? 0),
    destination,
    raw: prepared,
  };
}

/**
 * Execute a prepared payment.
 *
 * The send gate is per-rail. Liquid keeps the existing UTXO-conflict gate;
 * Spark is not UTXO-based, so gating it there would slow Lightning for no
 * benefit.
 */
export async function sendPayment(
  prepared: PreparedSend,
): Promise<RailPayment> {
  if (prepared.rail === "spark") {
    const sdk = getSparkSdk();
    if (!sdk) throw new Error("Spark rail unavailable");
    const response = await sdk.sendPayment({
      prepareResponse: prepared.raw as any,
    });
    return toSparkPayment(response.payment);
  }

  await waitForOutgoingSlot();
  const response = await walletService.sendPayment({
    prepareResponse: prepared.raw,
  } as any);
  const txId = (response as any)?.payment?.txId;
  if (typeof txId === "string" && /^[a-fA-F0-9]{64}$/.test(txId)) {
    trackOutgoingTx(txId, "liquid");
  }
  return toLiquidPayment((response as any).payment);
}

export interface ReceiveRequest {
  rail: Rail;
  /** The invoice, address, or URI to display. */
  destination: string;
  feeSat: number;
}

/**
 * Create a receive request. `method` matches the keys in `types` from
 * `$lib/utils`: lightning, bitcoin, liquid, usdt.
 */
export async function createReceiveRequest(
  method: string,
  opts: { amountSat?: number; description?: string; assetId?: string } = {},
): Promise<ReceiveRequest> {
  const rail = railForReceiveMethod(method);

  if (rail === "spark") {
    const sdk = getSparkSdk();
    if (!sdk) throw new Error("Spark rail unavailable");

    const paymentMethod =
      method === "bitcoin"
        ? ({ type: "bitcoinAddress" } as const)
        : ({
            type: "bolt11Invoice",
            description: opts.description ?? "",
            amountSats: opts.amountSat,
          } as const);

    const response = await sdk.receivePayment({ paymentMethod });
    return {
      rail,
      destination: response.paymentRequest,
      feeSat: Number(response.fee ?? 0),
    };
  }

  const prepared = await walletService.prepareReceivePayment({
    paymentMethod: "liquidAddress",
    amount: opts.assetId
      ? { type: "asset", assetId: opts.assetId, payerAmount: opts.amountSat }
      : undefined,
  } as any);
  const response = await walletService.receivePayment({
    prepareResponse: prepared,
    description: opts.description,
  } as any);

  return {
    rail,
    destination: (response as any).destination,
    feeSat: Number((prepared as any)?.feesSat ?? 0),
  };
}

/**
 * Payments from both rails, merged and sorted newest first.
 *
 * A failing rail contributes nothing rather than failing the whole list —
 * a user with a degraded rail should still see the other rail's history.
 */
export async function allPayments(limit = 100): Promise<RailPayment[]> {
  const results = await Promise.allSettled([
    sparkAdapter.isConnected()
      ? sparkAdapter.listPayments(limit)
      : Promise.resolve([]),
    liquidAdapter.isConnected()
      ? liquidAdapter.listPayments(limit)
      : Promise.resolve([]),
  ]);

  for (const result of results) {
    if (result.status === "rejected") {
      sdkLogger.warn(
        "[rails] listPayments failed for one rail:",
        result.reason,
      );
    }
  }

  const [sparkResult, liquidResult] = results;
  const sparkPayments =
    sparkResult.status === "fulfilled" ? sparkResult.value : [];
  const liquidPayments =
    liquidResult.status === "fulfilled" ? liquidResult.value : [];
  return mergePayments(sparkPayments, liquidPayments);
}

/** Subscribe to events from both rails. Returns a cleanup function. */
export async function subscribeRails(
  handler: (event: RailEvent) => void,
): Promise<() => Promise<void>> {
  const ids: Array<{ rail: Rail; id: string }> = [];

  for (const adapter of [sparkAdapter, liquidAdapter]) {
    if (!adapter.isConnected()) continue;
    try {
      const id = await adapter.onEvent(handler);
      ids.push({ rail: adapter.rail, id });
    } catch (error) {
      sdkLogger.error(`[rails] ${adapter.rail} listener failed:`, error);
    }
  }

  return async () => {
    for (const { rail, id } of ids) {
      try {
        await adapters[rail].offEvent(id);
      } catch (error) {
        sdkLogger.warn(`[rails] ${rail} listener cleanup failed:`, error);
      }
    }
  };
}

/**
 * Merge two rails' payments, newest first.
 *
 * Deduplication is keyed on `rail:id`, never `id` alone: the two SDKs
 * mint ids independently and a collision across rails is two different
 * payments, not one.
 */
export function mergePayments(
  a: RailPayment[],
  b: RailPayment[],
): RailPayment[] {
  const seen = new Map<string, RailPayment>();
  for (const payment of [...a, ...b]) {
    seen.set(`${payment.rail}:${payment.id}`, payment);
  }
  return [...seen.values()].sort((x, y) => y.timestamp - x.timestamp);
}
