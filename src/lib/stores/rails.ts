import { writable, derived, get } from "svelte/store";
import { adapters } from "$lib/rails";
import type { Rail, RailConnectionState } from "$lib/rails/types";
import { sdkLogger } from "$lib/logger";

interface RailSlice {
  state: RailConnectionState;
  balanceSat: number;
  assets: Array<{ assetId: string; balance: number }>;
}

interface RailsState {
  spark: RailSlice;
  liquid: RailSlice;
  unclaimedDeposits: number;
}

const initial: RailsState = {
  spark: { state: "connecting", balanceSat: 0, assets: [] },
  liquid: { state: "connecting", balanceSat: 0, assets: [] },
  unclaimedDeposits: 0,
};

export const railState = writable<RailsState>(initial);

export function setRailState(rail: Rail, state: RailConnectionState): void {
  railState.update((s) => ({ ...s, [rail]: { ...s[rail], state } }));
}

export function setUnclaimedDeposits(count: number): void {
  railState.update((s) => ({ ...s, unclaimedDeposits: count }));
}

/** Refresh both balances. A failing rail leaves its last known value. */
export async function refreshBalances(): Promise<void> {
  for (const rail of ["spark", "liquid"] as Rail[]) {
    const adapter = adapters[rail];
    if (!adapter.isConnected()) continue;
    try {
      const balance = await adapter.getBalance();
      railState.update((s) => ({
        ...s,
        [rail]: {
          ...s[rail],
          state: "connected",
          balanceSat: balance.balanceSat,
          assets: balance.assets ?? [],
        },
      }));
    } catch (error) {
      sdkLogger.warn(`[rails] balance refresh failed for ${rail}:`, error);
    }
  }
}

export const sparkBalance = derived(railState, ($s) => $s.spark.balanceSat);
export const liquidBalance = derived(railState, ($s) => $s.liquid.balanceSat);
export const liquidAssets = derived(railState, ($s) => $s.liquid.assets);
export const sparkAvailable = derived(
  railState,
  ($s) => $s.spark.state === "connected",
);
export const liquidAvailable = derived(
  railState,
  ($s) => $s.liquid.state === "connected",
);
export const unclaimedDepositCount = derived(
  railState,
  ($s) => $s.unclaimedDeposits,
);
