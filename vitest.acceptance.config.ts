import { defineConfig } from 'vitest/config'

/**
 * Acceptance suite: the unit tests prove the prompt is ASSEMBLED as designed;
 * these prove a real engine REWARDS it. They send actual prompts to a local
 * llama.cpp server and read `timings.cache_n` — the number of prompt tokens it
 * served from its KV cache — so the claim "an unchanged prefix is reused" is
 * measured rather than argued.
 *
 * Deliberately NOT part of `npm test`: it needs a running model, takes minutes,
 * and its numbers depend on the machine.
 *
 *   npm run test:acceptance
 *
 * Point it elsewhere with ACCEPTANCE_ENDPOINT=http://host:port/v1.
 */
export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['scripts/acceptance/**/*.accept.ts'],
    // A cold prefill of a few thousand tokens takes tens of seconds, and every
    // test deliberately pays one.
    testTimeout: 600_000,
    hookTimeout: 600_000,
    // One slot in llama.cpp means one conversation: parallel files would evict
    // each other's cache and every measurement would be noise.
    fileParallelism: false,
    sequence: { concurrent: false }
  }
})
