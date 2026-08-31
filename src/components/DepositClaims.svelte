<script lang="ts">
  import { onMount } from "svelte";
  import {
    listUnclaimedDeposits,
    claimDeposit,
    type UnclaimedDeposit,
  } from "$lib/rails/spark";
  import { unclaimedDepositCount } from "$lib/stores/rails";

  let deposits = $state<UnclaimedDeposit[]>([]);
  let claiming = $state<string | null>(null);
  let error = $state<string | null>(null);

  async function load() {
    try {
      deposits = await listUnclaimedDeposits();
    } catch (e) {
      error = e instanceof Error ? e.message : "Could not load deposits";
    }
  }

  async function claim(deposit: UnclaimedDeposit) {
    const key = `${deposit.txid}:${deposit.vout}`;
    claiming = key;
    error = null;
    try {
      // Exactly the fee the SDK asked for. Never the deposit amount.
      await claimDeposit(
        deposit.txid,
        deposit.vout,
        deposit.requiredFeeSats ?? 0,
      );
      await load();
    } catch (e) {
      error = e instanceof Error ? e.message : "Claim failed";
    } finally {
      claiming = null;
    }
  }

  onMount(load);
  $effect(() => {
    if ($unclaimedDepositCount > 0) void load();
  });
</script>

{#if deposits.length > 0}
  <div class="rounded-2xl border border-warning/40 bg-warning/10 p-4">
    <h3 class="font-bold mb-2">Bitcoin waiting to be added</h3>
    <p class="text-sm opacity-70 mb-3">
      Network fees are higher than the automatic limit, so these need your
      approval before the money lands in your balance.
    </p>

    {#if error}
      <p class="text-sm text-error mb-2">{error}</p>
    {/if}

    <ul class="flex flex-col gap-2">
      {#each deposits as deposit (deposit.txid + deposit.vout)}
        <li class="flex items-center justify-between gap-3">
          <span class="flex flex-col">
            <span class="font-mono text-sm">{deposit.amountSats} sats</span>
            {#if deposit.requiredFeeSats}
              <span class="text-xs opacity-60"
                >Fee to add now: {deposit.requiredFeeSats} sats</span
              >
            {/if}
          </span>
          <button
            class="btn btn-sm btn-primary"
            disabled={claiming === `${deposit.txid}:${deposit.vout}` ||
              !deposit.isMature ||
              !deposit.requiredFeeSats}
            onclick={() => claim(deposit)}
          >
            {#if claiming === `${deposit.txid}:${deposit.vout}`}
              Adding…
            {:else if !deposit.isMature}
              Confirming
            {:else if !deposit.requiredFeeSats}
              Waiting
            {:else}
              Add for {deposit.requiredFeeSats} sats
            {/if}
          </button>
        </li>
      {/each}
    </ul>
  </div>
{/if}
