/**
 * Chat system-prompt assembly (Canvas Markup Protocol).
 *
 * Pure text builder, kept out of the hook so the layering is testable: the
 * static protocol rules stay byte-identical across turns (provider prompt
 * caching depends on it) and only the optional sections change.
 *
 * The system prompt carries the INTERACTION PROTOCOL ONLY — output channels,
 * markup, status line. Writing guidance (persona, voice, standards, language)
 * belongs to the user's preset and their message; do not add task or style
 * instructions here, they would compete with the user's own.
 *
 * Layout, in order:
 *   1. Protocol rules + examples (static)
 *   2. Chapter-lookup protocol (multi-chapter books with the toggle on)
 *   3. The user's custom writing instructions (their preset)
 *   4. FORMAT PROTOCOL REMINDER — always last (see below)
 *
 * Why the reminder in step 4 exists (hardening, NOT a proven fix):
 * Presets are user-authored and routinely carry output-channel language
 * ("output the prose directly", "add no explanations", "avoid non-Chinese
 * text" — which reads as "avoid HTML tags"). Appended last, they sat after
 * the protocol rules and outranked them by recency. The reminder puts the
 * format rules back in final position and scopes presets to style/content.
 *
 * It does NOT cure the "model replies with a bare acknowledgement and no
 * tags" failure. That was measured against grok-4.5 (2026-07-25, n=19+18):
 * the failure occurs across every prompt variant, with the preset disabled,
 * and with no chat history at all; the per-condition success rate also drifts
 * between 22% and 65% for an identical prompt within the same hour. Prompt
 * wording showed no effect that survives the noise — treat any claim that it
 * does as unproven, and handle the failure client-side instead.
 */

/** Options for {@link buildChatSystemPrompt}. */
export interface ChatSystemPromptOptions {
  /** The active preset's content (trimmed by the caller); empty ⇒ omitted. */
  customInstructions?: string
  /** Include the `<lookup>` protocol (multi-chapter books, toggle on). */
  includeChapterLookup: boolean
}

/**
 * What the tools cannot say for themselves.
 *
 * The tool schemas carry their own names, arguments and usage notes — that is
 * the point of migrating to them, and repeating it here would only give the
 * model two sources to reconcile. What remains is what a JSON schema has no
 * place to state: which channel the user reads, and the two document
 * invariants that are easy to violate while filling in an `html` argument.
 */
const PROTOCOL_RULES = `You are connected to a document editor. It says nothing about what to write or how to write it: the task, the subject, the voice, the language and the standards all come from the user.

HOW YOUR OUTPUT IS USED:
1. Your message text is shown to the user as chat. It never reaches the document.
2. The document is changed ONLY by calling a tool. If you say you rewrote something without calling one, nothing happened.
3. Deciding whether the document needs changing is yours. Answering a question in chat, without calling any tool, is a complete and correct reply.

WRITING THE HTML ARGUMENTS:
4. Tag contents are an HTML fragment — the editor stores HTML, so plain text or markdown arrives broken. Use <h1>/<h2>/<h3>, <p>, <blockquote>, <strong>/<em>, <ul>/<ol>/<li>. Never <!DOCTYPE>, <html>, <head> or <body>.
5. The user message carries the "CURRENT ACTIVE DOCUMENT CONTENT" — the live HTML of the document being edited. Whatever you write replaces it, so carry over the markup you were not asked to change; formatting you drop is lost.
6. IMAGE TOKENS: the document may contain tokens like {{IMAGE_PLACEHOLDER_0}}, each standing for an embedded image. Copy every one EXACTLY as-is, keeping its position in the text. Never drop, renumber, reformat, or convert them into <img> tags. Only omit one if the user explicitly asks to remove that image.`

const CHAPTER_LOOKUP_RULES = `CHAPTER LOOKUP:
The user message may include a CHAPTER INDEX listing every chapter of the book with a one-line summary. If answering well requires the FULL TEXT of chapters that are NOT included in your context, respond with ONLY this tag and nothing else:
<lookup chapters="Chapter 3: Ashfall; Chapter 7: Return" reason="need the betrayal details for continuity"></lookup>
- Copy chapter titles EXACTLY as they appear in CHAPTER INDEX, separated by semicolons.
- The requested chapters will be attached and your request retried automatically.
- Never guess or invent the content of a chapter you have not been shown; look it up instead.
- Do NOT use <lookup> for chapters already provided in your context.`

/**
 * Final section of the system prompt. Must stay last: it exists to outrank
 * output-channel language inside the user's custom writing instructions.
 */
export const FORMAT_PROTOCOL_REMINDER = `FORMAT PROTOCOL (highest priority — this section always wins):
Every instruction above, including the user's custom writing instructions, governs STYLE, VOICE, LANGUAGE, and CONTENT only. None of them changes HOW you deliver a document change. In particular, instructions such as "write the prose directly", "output only the text", "add no explanations", or "avoid non-Chinese / non-<language> text" describe the prose itself — they never authorize you to write document text into the chat message instead of into a tool call.
- Text meant for the document goes in a tool argument. Text in your message is chat, and is never written to the document.
- Never announce that you updated the document without calling a tool to do it.
- The tools are always available, whatever language the writing instructions require.`

/**
 * Assemble the chat system prompt. See the module comment for the layering
 * and why the format reminder is last.
 */
export function buildChatSystemPrompt(options: ChatSystemPromptOptions): string {
  const { customInstructions, includeChapterLookup } = options
  const sections = [PROTOCOL_RULES]

  if (includeChapterLookup) {
    sections.push(CHAPTER_LOOKUP_RULES)
  }
  if (customInstructions?.trim()) {
    sections.push(
      `USER'S CUSTOM WRITING INSTRUCTIONS (apply these to all content you write):\n${customInstructions.trim()}`
    )
  }
  sections.push(FORMAT_PROTOCOL_REMINDER)

  return sections.join('\n\n')
}
