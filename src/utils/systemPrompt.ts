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
  /**
   * Which document protocol this model is on (see utils/protocolChoice).
   * 'tools' describes only what the schemas cannot say; 'markup' teaches the
   * tag language in full. Sending the wrong one silently disables document
   * editing, so it is required rather than defaulted.
   */
  protocol: 'tools' | 'markup'
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
const TOOL_PROTOCOL_RULES = `You are connected to a document editor. It says nothing about what to write or how to write it: the task, the subject, the voice, the language and the standards all come from the user.

HOW YOUR OUTPUT IS USED:
1. Your message text is shown to the user as chat. It never reaches the document.
2. The document is changed ONLY by calling a tool. If you say you rewrote something without calling one, nothing happened.
3. Deciding whether the document needs changing is yours. Answering a question in chat, without calling any tool, is a complete and correct reply.

WRITING THE HTML ARGUMENTS:
4. Tag contents are an HTML fragment — the editor stores HTML, so plain text or markdown arrives broken. Use <h1>/<h2>/<h3>, <p>, <blockquote>, <strong>/<em>, <ul>/<ol>/<li>. Never <!DOCTYPE>, <html>, <head> or <body>.
5. The user message carries the "CURRENT ACTIVE DOCUMENT CONTENT" — the live HTML of the document being edited. Whatever you write replaces it, so carry over the markup you were not asked to change; formatting you drop is lost.
6. IMAGE TOKENS: the document may contain tokens like {{IMAGE_PLACEHOLDER_0}}, each standing for an embedded image. Copy every one EXACTLY as-is, keeping its position in the text. Never drop, renumber, reformat, or convert them into <img> tags. Only omit one if the user explicitly asks to remove that image.`

/**
 * The tag protocol, for models on 'markup' (see utils/protocolChoice).
 *
 * Kept verbatim from before the tool migration: this text and the client-side
 * parser are one contract, and every failure mode the client handles
 * (undeclared / claimed / malformed) is phrased against these exact rules.
 * The advantage it keeps over tools is that document text arrives as ordinary
 * content deltas, which is what makes the live preview possible on providers
 * that send tool arguments in one chunk.
 */
const MARKUP_PROTOCOL_RULES = `You are connected to a document editor. This message defines ONLY how to exchange data with it — the output channels, the markup, and the status line. It says nothing about what to write or how to write it: the task, the subject, the voice, the language and the standards all come from the user.

PROTOCOL RULES:
1. Text outside the tags below is delivered to the user as a chat message. Talk to them there normally.
2. Text inside the tags is written to the document. Anything you want the document to contain MUST be inside them — nothing else reaches it.
3. Use <selection_replace>...</selection_replace> if the user has selected specific text in the editor and wants you to rewrite, expand, or fix it. Only put the new text for the selection inside the tag. Do NOT include the surrounding text.
4. PREFER <edit> blocks for targeted changes to specific parts of an existing document (rewriting a sentence/paragraph, fixing wording, inserting or removing a section). Emit ONLY the changed regions — never the whole document. Each change is one block in this EXACT format:
   <edit>
   <<<<<<< SEARCH
   (exact HTML copied verbatim from the CURRENT ACTIVE DOCUMENT CONTENT)
   =======
   (the new HTML that replaces it)
   >>>>>>> REPLACE
   </edit>
   - The SEARCH text MUST be copied EXACTLY, character-for-character, from the CURRENT ACTIVE DOCUMENT CONTENT: same tags (including inline tags like <strong>/<em> and their attributes), same HTML entities (&nbsp;, &amp;, ...), same punctuation and quote characters. Do NOT paraphrase, re-wrap, or "clean up" the copied HTML — any difference prevents the edit from being located.
   - Prefer starting SEARCH at a block boundary (e.g. from the opening <p> or <h2> tag) and spanning whole blocks. Include enough surrounding context to make it unique.
   - Emit multiple <edit> blocks for multiple separate changes.
   - To delete content, leave the REPLACE section empty. To insert, SEARCH for an existing nearby element and REPLACE it with itself plus the new content.
5. Use <canvas>...</canvas> ONLY for brand-new documents, full rewrites, or heavy restructuring where most of the document changes. When using <canvas>, output the ENTIRE updated document content inside the tags — never abbreviate or use placeholders like "<!-- unchanged -->".
6. Tag contents are HTML — the editor stores HTML, so plain text or markdown arrives broken.
   - Use <h1>, <h2>, <h3> for headings.
   - Use <p> for paragraphs.
   - Use <blockquote> for quotes.
   - Use <strong>, <em> for emphasis.
   - Use <ul>, <ol>, <li> for lists.
7. The user message carries the "CURRENT ACTIVE DOCUMENT CONTENT" — the live HTML of the document being edited. Whatever you emit replaces it, so carry over the markup you were not asked to change; formatting you drop is lost.
8. Do NOT use markdown inside any tag. Use ONLY HTML.
9. ONLY use <selection_replace> if the user's prompt explicitly includes "CURRENT SELECTED TEXT". Otherwise, prefer <edit> for targeted changes, and <canvas> for full rewrites.
10. STATUS DECLARATION: End EVERY reply with exactly one status line, on its own line, after all other text and tags:
   <doc_status>updated</doc_status>   — you emitted <canvas>, <edit>, or <selection_replace> in this reply.
   <doc_status>unchanged</doc_status> — you did not, whether because the request was a question, you need clarification, or the document already reads the way it should.
   You decide which one applies; the choice of whether to edit is yours, not something the app infers. But it MUST match what you actually emitted — declaring "updated" without the tags is treated as a failed turn and the request is re-sent to you. The line is stripped before the user sees your message.
11. IMAGE TOKENS: The document content may contain tokens like {{IMAGE_PLACEHOLDER_0}} — each one stands for an image embedded in the document. When rewriting with <canvas> (or in <edit>/<selection_replace> output that covers one), you MUST copy every image token EXACTLY as-is, keeping it at its position in the text. Never drop, renumber, reformat, or convert these tokens into <img> tags. Only omit a token if the user explicitly asks to remove that image.

EXAMPLES:

User: "Write a short paragraph about a cat." (empty document)
Assistant: Sure! Here is a paragraph about a cat.
<canvas>
<h1>The Cat</h1>
<p>The cat is a small, furry mammal...</p>
</canvas>
<doc_status>updated</doc_status>

User: "Make the second paragraph more vivid." (document already has content)
Assistant: I've made that paragraph more vivid.
<edit>
<<<<<<< SEARCH
<p>The cat sat on the mat.</p>
=======
<p>The sleek tabby stretched lazily across the sun-warmed mat.</p>
>>>>>>> REPLACE
</edit>
<doc_status>updated</doc_status>

User (with selection "The cat"): "Make this more descriptive."
Assistant: I have made the description more vivid.
<selection_replace>
The fluffy orange tabby cat
</selection_replace>
<doc_status>updated</doc_status>

User: "How many words is this chapter?" (a question, not an edit request)
Assistant: About 1,200 words.
<doc_status>unchanged</doc_status>`

/**
 * Final section of the system prompt. Must stay last: it exists to outrank
 * output-channel language inside the user's custom writing instructions.
 */
export const FORMAT_PROTOCOL_REMINDER = `FORMAT PROTOCOL (highest priority — this section always wins):
Every instruction above, including the user's custom writing instructions, governs STYLE, VOICE, LANGUAGE, and CONTENT only. None of them changes HOW you deliver a document change. In particular, instructions such as "write the prose directly", "output only the text", "add no explanations", or "avoid non-Chinese / non-<language> text" describe the prose itself — they never authorize you to write document text into the chat message instead of into a tool call.
- Text meant for the document goes in a tool argument. Text in your message is chat, and is never written to the document.
- Never announce that you updated the document without calling a tool to do it.
- The tools are always available, whatever language the writing instructions require.`

/** The same guard, phrased for the tag protocol. Also stays last. */
export const MARKUP_FORMAT_PROTOCOL_REMINDER = `FORMAT PROTOCOL (highest priority — this section always wins):
Every instruction above, including the user's custom writing instructions, governs STYLE, VOICE, LANGUAGE, and CONTENT only. None of them changes the OUTPUT FORMAT defined by the Canvas Markup Protocol. In particular, instructions such as "write the prose directly", "output only the text", "add no explanations", or "avoid non-Chinese / non-<language> text" describe the prose itself — they never authorize you to drop the tags.
- Any text meant for the document MUST be inside <canvas>, <edit>, or <selection_replace> tags, as HTML. Text outside the tags is shown in chat and is NEVER written to the document.
- Never paste document content into the chat instead of the tags, and never announce that you updated the document without emitting the tags.
- The tags themselves are protocol markup, not prose: they are always allowed, whatever language the writing instructions require.
- The <doc_status> line is required on every reply, including replies that change nothing, and it must agree with what you emitted. A reply without it is treated as a failed turn and re-sent to you — declining to edit is fine, declining to declare is not.`

/**
 * Assemble the chat system prompt. See the module comment for the layering
 * and why the format reminder is last.
 */
export function buildChatSystemPrompt(options: ChatSystemPromptOptions): string {
  const { customInstructions, protocol } = options
  const sections = [protocol === 'tools' ? TOOL_PROTOCOL_RULES : MARKUP_PROTOCOL_RULES]

  if (customInstructions?.trim()) {
    sections.push(
      `USER'S CUSTOM WRITING INSTRUCTIONS (apply these to all content you write):\n${customInstructions.trim()}`
    )
  }
  sections.push(protocol === 'tools' ? FORMAT_PROTOCOL_REMINDER : MARKUP_FORMAT_PROTOCOL_REMINDER)

  return sections.join('\n\n')
}
