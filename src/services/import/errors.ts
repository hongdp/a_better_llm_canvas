/**
 * Error helpers shared by the URL/HTML import pipeline.
 * Extracted from ImportUrlModal.tsx.
 */

import type { LLMMessage } from '../../types/llm'

// Error enriched with the prompt context that produced it, so the safety
// prompt-editor UI can surface the failing prompts for a manual retry.
export interface EnrichedImportError extends Error {
  isSafetyPromptContext?: boolean
  phase?: number
  chapterIndex?: number
  systemPrompt?: LLMMessage
  userPrompt?: LLMMessage
}

// Extract a human-readable message from an unknown caught value.
export const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err)
