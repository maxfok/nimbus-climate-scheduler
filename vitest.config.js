import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Node's own Web Storage can shadow jsdom's browser storage (Node 26).
    // Disable it in workers where supported; jsdom supplies the browser API.
    execArgv: process.allowedNodeEnvironmentFlags.has("--no-experimental-webstorage")
      ? ["--no-experimental-webstorage"] : [],
  },
});
