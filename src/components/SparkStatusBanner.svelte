<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { getSparkNetworkStatus } from "$lib/rails";

  let status = $state("operational");
  let timer: ReturnType<typeof setInterval> | null = null;

  const degraded = $derived(
    status === "degraded" || status === "partial" || status === "major",
  );

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

{#if degraded}
  <div
    class="bg-warning/20 border-b border-warning/40 px-4 py-2 text-sm text-center"
    role="status"
  >
    {message}
  </div>
{/if}
