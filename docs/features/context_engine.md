# Context Engine — one module, per-provider strategies

Status: **proposed**. Consolidates work already landed in
[cache_first_context.md](cache_first_context.md) and supersedes its §7 as the
place where selection, budgeting and layout live.

## 1. Why consolidate

The logic that decides what the model sees is spread across eight files and
three layers, and each turn's prompt is the product of all of them:

| File | Decides |
|---|---|
| `utils/contextSelection.ts` | which chapters are relevant |
| `utils/contextLedger.ts` | what was already sent, and in what order |
| `utils/contextWindow.ts` | how many tokens are available |
| `hooks/chat/dynamicContext.ts` | how blocks are rendered |
| `hooks/chat/wholeBook.ts` | the whole-book escalation ladder |
| `utils/llmContext.ts` | history trimming, artifact stripping |
| `utils/systemPrompt.ts` | system-prompt layering |
| `hooks/useChatLLM.ts` | ~100 lines of inline assembly tying it together |

Nothing here is wrong in isolation. What is missing is a place where the
*whole* decision is made and can be inspected, and — the reason this document
exists — anywhere at all that knows **which provider the prompt is for**.

Providers do not merely differ in cache syntax. Two hazards found while
measuring this app, neither addressable by prompt layout:

1. **grok has a cost cliff that counts cached tokens.** Long-context pricing
   applies when *total* prompt tokens **including cached ones** exceed the
   model's threshold (200K for the grok-4 family), and it doubles input,
   cached and output rates together. An append-only ledger grows monotonically,
   so it will eventually cross that line — and because the cache hit rate stays
   high, nothing looks wrong while the bill doubles.
2. **The local endpoint has exactly one KV slot.** `llama-server` runs with
   `--parallel 1`, so its prefix cache is a single shared resource. The
   background chapter summarizer (`services/chapterSummaries.ts`, whenever
   `summaryProvider` resolves to the active provider) sends its own request to
   that same slot and evicts the conversation's KV. The next chat turn then
   pays a full re-prefill — measured at 42.87s — with no visible cause.

A per-provider strategy is not polish. It is the difference between a design
that works on paper and one that works on this machine.

## 2. Shape

```
                    ┌─────────────────────────────┐
  chat turn  ──────▶│      ContextEngine.plan()   │──────▶  PromptPlan
                    └──────────────┬──────────────┘
                                   │ consults
              ┌────────────────────┼────────────────────┐
              ▼                    ▼                    ▼
       ProviderProfile        ContextLedger        SelectionScorer
    (caching, limits,        (what was sent,      (which chapters
     cost cliffs, telemetry)  in what order)       are relevant)
```

`plan()` is **pure**: state in, plan out, no I/O, no store reads. That is what
makes the acceptance test possible — plan twice, compare prefixes — and it is
how the current code is already tested.

```ts
interface PromptPlan {
  blocks: PromptBlock[]          // ordered; each knows its volatility
  breakpoints: number[]          // block indices to mark, if the provider marks
  budget: BudgetAccounting       // where every token went
  diagnostics: PlanDiagnostics   // what changed vs the last plan, and why
  consent?: ConsentRequest       // when the user must decide before sending
}

interface PromptBlock {
  kind: 'system' | 'ledger' | 'compaction' | 'history' | 'tail'
  volatility: 'session' | 'append-only' | 'per-turn'
  messages: LLMMessage[]
  tokens: number
}
```

`diagnostics` is the part that does not exist today and should: which block
first differed from the previous turn, and why. Every cache regression in this
app so far has been invisible — including a bug where an unchanged chapter set
was re-emitted in a new order every turn.

## 3. Provider profiles

```ts
interface ProviderCacheProfile {
  /** 'automatic' = exact-prefix matching; 'explicit' = we must mark breakpoints. */
  mode: 'automatic' | 'explicit' | 'none'
  maxBreakpoints: number
  /** Header/field that routes a conversation to the same cache. */
  routingKey?: { kind: 'header'; name: string } | { kind: 'body'; field: string }
  /** Above this many prompt tokens the price tier changes. */
  longContextThreshold?: number
  /** Where the response reports cache hits. */
  telemetry?: { path: string[] }
  /** True when the cache is a single shared slot that other requests evict. */
  exclusiveCache?: boolean
  /** Where the window comes from. */
  window: { discovered: boolean; fallbackTokens: number }
}
```

### grok (xAI) — primary

| | |
|---|---|
| mode | `automatic` — exact-prefix; `cache_control` markers do not exist and `cacheHint` is a no-op |
| routing | `x-grok-conv-id` header (already sent, keyed on `activeBookId`) |
| telemetry | `usage.prompt_tokens_details.cached_tokens` (already parsed) |
| cost cliff | **long-context threshold; cached tokens count toward it** |
| window | table only — xAI reports no window; `/language-models` returns pricing and modalities |

Strategy:

- **Budget against the cliff first, the window second.** The target is the
  largest prompt that stays *under* the threshold; the window is a hard cap
  above it. Crossing is allowed but must be a decision, with the doubled rate
  quoted — the same consent panel the ledger already uses.
- Ledger admission gets a second gate: a chapter that would push the total over
  the threshold is refused (or evicts the coldest ledger member, with consent),
  even when the window has room.
- Nothing to mark: the layout *is* the optimization.

### ollama / llama.cpp (local) — primary

| | |
|---|---|
| mode | `automatic` — llama.cpp reuses the longest matching prefix in the slot's KV |
| routing | none |
| telemetry | none in the response; measured as prefill time (`prompt processing … t = …`) and the backend's own first-token log |
| window | **discovered** — `meta.n_ctx` on `/v1/models`, already wired |
| exclusiveCache | **true** — `--parallel 1` is one slot |

Strategy:

- **Cache arbitration.** With one slot, the prefix belongs to whoever spoke
  last. Background work must not interleave with the conversation:
  1. Queue background jobs (summaries) behind the foreground stream — they
     already are, via the summary queue — **and** hold them while the
     conversation is warm, rather than firing between turns.
  2. Prefer routing them elsewhere: the Ollama daemon on `:11434` is a separate
     process with its own cache, and summarization does not need the big model.
  3. Where neither is possible, accept the eviction *knowingly* and stop
     pretending the next turn is cheap.
- Free money the other providers do not have: **the window is enormous**
  (262144) and costs nothing per token. The budget should fill it rather than
  trim, which is what the model-derived budget now does.
- Because there is no cached-token field, the only honest signal is
  time-to-first-token. It is already logged per job; the engine should record
  the *expected* prefix reuse alongside it so the two can be compared.

### anthropic / openai / gemini — secondary

Sketched now so the interface is not shaped by two providers alone:

- **anthropic**: `explicit`, up to 4 breakpoints, 5-minute TTL. The breakpoints
  fall out of the block list — system │ ledger │ compaction │ history — which
  is exactly 4. Worth a keepalive ping (aider's `--cache-keepalive-pings`)
  if it ever becomes the main provider.
- **openai**: automatic prefix caching, `prompt_cache_key` for routing, a
  minimum cacheable prefix.
- **gemini**: implicit caching plus explicit cached-content handles with a TTL —
  the only provider where the ledger could be *uploaded once* and referenced,
  which the interface should not preclude.

## 4. What moves

| From | To |
|---|---|
| assembly inline in `useChatLLM.ts` | `context/engine.ts` — `plan()` |
| `utils/contextSelection.ts` | `context/selection.ts` (unchanged logic) |
| `utils/contextLedger.ts` | `context/ledger.ts` (unchanged logic) |
| `utils/contextWindow.ts` | `context/window.ts` + `context/profiles.ts` |
| `hooks/chat/dynamicContext.ts` | `context/render.ts` |
| history trimming in `utils/llmContext.ts` | `context/history.ts` |
| `hooks/chat/wholeBook.ts` | stays; becomes a plan *variant* the engine emits |

`useChatLLM` keeps the streaming, the retries and the store writes. It stops
deciding what the prompt contains.

## 5. Telemetry, because none of this is visible today

`cachedPromptTokens` is parsed on both transports and accumulated into session
stats — and rendered nowhere. Every cache regression so far has been silent.

One record per turn, written wherever the turn ran:

```
provider, model, promptTokens, cachedTokens, hitRate,
firstTokenMs, planDiff (which block first differed), overThreshold
```

For grok that is a real hit rate. For the local endpoint `cachedTokens` is
absent and `firstTokenMs` carries the signal. Both belong in `api-server.log`
next to the existing job lines, and the hit rate belongs in the UI — it is the
only way to notice that a change to the prompt layout undid the work.

## 6. Phasing

1. **Profiles + telemetry.** No behavior change: introduce
   `ProviderCacheProfile`, surface hit rate and first-token time. This makes
   every later step measurable instead of arguable.
2. **Extract `plan()`.** Move assembly out of `useChatLLM` with the current
   behavior intact; the existing prefix test guards it.
3. **grok threshold budgeting.** Admission gate + consent when crossing.
4. **Local cache arbitration.** Hold or reroute background summaries while a
   conversation is warm.
5. Compaction and the immutable prompt log (see cache_first_context.md §11
   "Still not done") land inside the engine rather than beside it.

## 7. Open questions

1. **Is the grok long-context threshold really 200K for `grok-4.20`?** The
   table entry is inferred from the grok-4 family. xAI does not report windows,
   so this needs confirming against the account's own pricing page.
2. **Should summaries move to `:11434` permanently?** It is a different model
   family (the Ollama daemon holds 8), which changes summary quality. Cheaper
   than evicting a 262144-token prefix, but not free.
3. **Does the engine own roleplay too?** `useRoleplayLLM` has its own volatile
   game-state block and the same provider constraints. Probably yes, after (2).
