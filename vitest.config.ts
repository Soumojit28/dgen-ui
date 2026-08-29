import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";

export default defineConfig({
  plugins: [svelte({ hot: false })],
  test: {
    environment: "jsdom",
    passWithNoTests: true,
    globals: false,
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.test.ts"],
    exclude: [
      "tests/browser/**",
      "node_modules/**",
      // TODO(spark-migration): pre-existing test, never ran before Task 1
      "src/lib/secureStorage.test.ts",
    ],
  },
  resolve: {
    alias: {
      $lib: new URL("./src/lib", import.meta.url).pathname,
    },
  },
});
