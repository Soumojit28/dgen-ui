<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { getSparkNetworkStatus } from "$lib/rails";

  // Starts unknown, not operational: getSparkNetworkStatus() also returns
  // "unknown" when the check fails or times out, and showing nothing in that
  // case tells the user everything is fine when we simply do not know.
  let status = $state("unknown");
  let timer: ReturnType<typeof setInterval> | null = null;

  // "unknown" is deliberately excluded from the loud banner but tracked
  // separately — it is a "we cannot tell" state, not a healthy one.
  const degraded = $derived(
    status === "degraded" || status === "partial" || status === "major",
  );
  const unknown = $derived(status === "unknown");

  const message = $derived(
    status === "major"
      ? "Bitcoin and Lightning payments are currently unavailable. Your money is safe."
      : "Bitcoin and Lightning payments may be slower than usual right now.",
  );

  async function check() {
    status = await getSparkNetworkStatus();
  }

  onMount(() => {
    void check();
    timer = setInterval(check, 5 * 60 * 1000);
  });

  onDestroy(() => {
    if (timer) clearInterval(timer);
  });
</script>

{#if degraded || unknown}
  <div
    class="bg-warning/20 border-b border-warning/40 px-4 py-2 text-sm text-center"
    role="status"
  >
    {unknown
      ? "Cannot reach the Bitcoin and Lightning network status service. Payments may or may not work right now."
      : message}
  </div>
{/if}
