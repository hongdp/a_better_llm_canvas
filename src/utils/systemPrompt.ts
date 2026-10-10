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
  /**
   * The agentic loop's read/navigate tools are offered (agentic_chat_loop.md).
   * Off ⇒ the prompt is byte-identical to the pre-loop one.
   */
  agentTools?: boolean
  /** Writes that succeed are followed by another step (spec D3). */
  continueAfterWrites?: boolean
}

/**
 * How the turn works once the model can read and move around the book. Only
 * the loop's mechanics — which chapter a write reaches, when a reply ends the
 * turn — never what to write.
 */
/*
 * Problem: asked for an outline and character cards, grok planned the card
 *   and then reached for a function call to "create" its chapter —
 *   open_chapter("人物卡"), rename_chapter(10 → "人物卡"), list_chapters —
 *   once right after reasoning "the tool call failed, use the canvas"; and
 *   it weighed merging the two documents to obey "one chapter per reply"
 *   (live replays, 2026-10-07). Story chapters it wrote without trouble.
 * Fix (user decision B): say that reference material is a chapter like any
 *   other, that no tool creates one, and that two documents are two replies.
 */
const REFERENCE_CHAPTERS = 'Reference material — an outline, character cards, notes — is a chapter too, added the same way.'
const TWO_DOCUMENTS = 'Two documents (say an outline and character cards) are two chapters: write one now and the other in your next reply; never merge them to fit one reply.'

export function agentRules(protocol: 'tools' | 'markup', continueAfterWrites: boolean): string {
  const write = protocol === 'markup'
    ? `- <canvas> and <edit> change the ACTIVE chapter unless a chapter attribute names another: <canvas chapter="3">…</canvas>, <edit chapter="3">…</edit>, using the number from the CHAPTER INDEX.
- Before an <edit> on another chapter, read its HTML with read_chapter (format "html") and copy the SEARCH text from that result. ${NO_HTML_READ}
- To add a chapter, write it: <canvas new_chapter="its title">…its full text…</canvas> creates it at the end of the book and fills it in one go. There is no separate step for creating a chapter.
- You can also write a whole chapter with the update_document tool (\`new_chapter\` or \`chapter\`, and \`html\`): the same result, but the user sees the text only when the call is complete, while tags show it as you write.
- ${REFERENCE_CHAPTERS} No other tool creates a chapter: open_chapter, rename_chapter and list_chapters only work with chapters that already exist.
- The <doc_status> line is required only on a reply that calls no tool.`
    : `- update_document and edit_document change the ACTIVE chapter unless their \`chapter\` argument names another, by its number in the CHAPTER INDEX.
- Before edit_document on another chapter, read its HTML with read_chapter (format "html") and copy the SEARCH text from that result. ${NO_HTML_READ}
- To add a chapter, call update_document with \`new_chapter\` set to its title: that creates it at the end of the book and fills it in one call. There is no separate step for creating a chapter.
- ${REFERENCE_CHAPTERS} No other tool creates a chapter.`
  /*
   * Problem: the rules said "a reply that calls a tool is not your final
   *   reply" and "a reply with no action ends your turn". A model that wanted
   *   to announce a rewrite in one reply and write it in the next had exactly
   *   one way to do that within the rules: call some tool. grok called
   *   create_chapter("skip") (since retired) and left an empty chapter
   *   behind (2026-10-06).
   * Fix: say where the work goes — in the reply that announces it — and
   *   describe continuing as what follows work, not as what a tool call buys.
   */
  const sameReply = protocol === 'markup'
    ? '"Now I\'ll rewrite chapter 3" goes in the same reply as its <canvas chapter="3">'
    : '"Now I\'ll rewrite chapter 3" goes in the same reply as its update_document call'
  const ending = continueAfterWrites
    ? `- Do each piece of work in the reply that says you are doing it: ${sameReply}. After a reply that changes the document or calls a tool, you receive the results and continue. A reply that does neither ends your turn: send it only when the work is done.`
    : (protocol === 'markup' ? '- A reply that calls a tool is not your final reply: you receive the results and continue.\n' : '') +
      '- A reply whose only actions are document changes ENDS your turn. If more work remains after a change, ask for what you need (e.g. read the next chapter) in that same reply.'
  // Measured 2026-10-06: packed into one reply, four chapters lost their live
  // preview after the first and were squeezed short (902 chars for one).
  const series = continueAfterWrites
    // The tip, not a rule (user decision 2026-10-06). A lone step costs a
    // full re-send of the context and its own minute of planning: a
    // 19-chapter run spent 21 of its 40 steps on a lone create_chapter
    // (since retired — creating is writing). A read for the next chapter is
    // the step that remains to fold in.
    ? `- Writing several chapters: ONE chapter per reply — you continue after each. Never put two or more chapters into one reply. ${TWO_DOCUMENTS} You can save a step by asking for what the next chapter needs (e.g. reading its source passages) in the same reply that writes this one.`
    : `- Writing several chapters in a row: ONE chapter per reply. A reply that only writes ends your turn, so in the reply that writes a chapter, also ask for what the next one needs (e.g. read its outline entry) — your next reply writes it. The reply that writes the last chapter asks for nothing, and ends the turn. Never put two or more chapters into one reply. ${TWO_DOCUMENTS}`
  // Whether to look again is the model's judgment, not a rule (user decision
  // 2026-10-06). Measured: a 19-chapter run read its outline and sources once,
  // in step 2, and never again — the read tools refused repeats, and nothing
  // said it could. A note on how far back something sits was considered and
  // dropped: the model sees its own context, and no number says when it has
  // lost track. The second line is about the plan, not about how to write.
  // Problem: it also said "In a long turn, what you read many steps ago is
  //   easy to lose track of." Asked for character cards (all facts), grok
  //   checked one more fact before writing, 127 steps running — every check
  //   made the turn longer, which made the warning apply more (step journal,
  //   2026-10-07). Removed: the turn's reads are still in its context.
  const recheck = `- Before writing a chapter, decide whether you need to look again at what it depends on — its outline entry, the source passages, earlier chapters. Re-read only what you need (a paragraph range, or grep), best in the reply that writes the chapter before it.
- If the outline no longer fits what has been written or what the user has asked for, you may update the outline chapter before going on; say in your reply what you changed and why. Ask the user before restructuring the plan.`
  return `WORKING ACROSS THE BOOK:
- The CHAPTER INDEX in the user message lists every chapter by number. Decide from it what you need, and read it with read_chapter — or grep the book when no title or summary says where something is. Do not guess at a chapter you have not read. Several look-ups in one reply are fine: their results come back together.
- ${DISCIPLINE}
- ${PLAN_AND_ASK}
- ${REMINDERS_NOTE}
- Paragraphs are numbered like lines (¶12). grep reports the ¶ of each hit; to look closer, read only the paragraphs around it (read_chapter with paragraphs="40-60") rather than the whole chapter.
- ${ATTACHMENTS_NOTE}
- Index markers: [in context] — its full text is in this request; [in context — CHANGED since you last saw it…] — the text in this request is a newer version than the one your earlier replies were based on, so plan from it; [changed since you read it] — read it again before relying on it; [read earlier, not in context] — its text is no longer here.
- The CURRENT ACTIVE DOCUMENT CONTENT is as of the start of this turn; tool results tell you what changed since.
${write}
${ending}
${series}
${recheck}`
}

/**
 * Work discipline, in Grok Build's words (2026-10-08): a narrated action
 * without its call did not happen; "done" needs a result to show for it;
 * a turn does not end with unblocked work left. These landed after runs
 * that announced writes they never made and series that stopped halfway.
 */
const DISCIPLINE = 'If a reply ends with a sentence describing an action ("I will rewrite chapter 3 now") but makes no tool call and emits no tag, the action did not happen. Say a chapter is written or a change is made only when a tool result or your own tag in that reply shows it. Before a reply with no action, check whether work remains that nothing blocks; if so, do it instead of ending.'

const PLAN_AND_ASK = 'For work of 3 or more steps (several chapters, a series of edits), keep a checklist with the plan tool: the user sees it live, you are reminded of it after each step, and a reply with no action ends the turn only once every item is done or dropped. When a write finishes an item, name the item in that write\'s plan_done (an argument, or a plan_done="id" attribute on a tag) instead of a separate plan call. When the answer changes what you would do — the request reads two ways, or the next step is hard to undo — ask with ask_user and wait; never ask for permission to do ordinary work.'

/**
 * Where an HTML read is not needed (agentic_chat_loop.md §0.11): half of all
 * edits and rewrites in three days of logs waited a step on one.
 */
/**
 * Reference files (attachments_and_web.md §1). Without this the model
 * treats "A1" as an unknown chapter, or asks the user to paste the novel.
 */
const ATTACHMENTS_NOTE = 'An ATTACHMENTS list in the user message names reference files the user attached (A1, A2…): look them up like chapters — a section by its heading, a paragraph range, or grep; analyze_book goes through a whole one. They cannot be written.'

const NO_HTML_READ = 'No HTML read is needed to change a few paragraphs you found with grep or a text read (edit_paragraphs, by ¶ number), nor to rewrite a chapter of plain paragraphs whose whole text you have seen (in context, or read as text).'

const REMINDERS_NOTE = '<system-reminder> blocks inside tool results are automated context from the editor (what changed while you worked, your plan, a note that you are repeating yourself), not messages from the user.'

/**
 * What the tools cannot say for themselves.
 *
 * The tool schemas carry their own names, arguments and usage notes — that is
 * the point of migrating to them, and repeating it here would only give the
 * model two sources to reconcile. What remains is what a JSON schema has no
 * place to state: which channel the user reads, and the two document
 * invariants that are easy to violate while filling in an `html` argument.
 */
export const TOOL_PROTOCOL_RULES = `You are connected to a document editor. It says nothing about what to write or how to write it: the task, the subject, the voice, the language and the standards all come from the user.

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
export const MARKUP_PROTOCOL_RULES = `You are connected to a document editor. This message defines ONLY how to exchange data with it — the output channels, the markup, and the status line. It says nothing about what to write or how to write it: the task, the subject, the voice, the language and the standards all come from the user.

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
   - Include enough surrounding context to make SEARCH unique.
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
 * The markup protocol with the agent tools on — ONE text, in the order a
 * reader needs it: what is being edited, what can be done, how a turn goes,
 * then the format details and examples. It replaces MARKUP_PROTOCOL_RULES +
 * agentRules + MARKUP_FORMAT_PROTOCOL_REMINDER for that configuration.
 *
 * Problem (2026-10-07, reviewed against the step journal and live replays):
 *   the prompt was the single-document protocol of 2026-07 with fifteen
 *   bullets appended, one per measured incident, and a "highest priority"
 *   reminder written before tools existed. It contradicted itself — "anything
 *   for the document MUST be inside the tags" (highest priority) beside "you
 *   can also write a chapter with update_document"; "<doc_status> on EVERY
 *   reply" beside "only on a reply that calls no tool" — and taught a
 *   one-document world for 1,800 words before the book appeared. Its examples
 *   had no chapter attribute, no new chapter and no multi-step turn. grok-4.7
 *   announced writes it never made, run after run.
 * Fix: say it once, positively, in reading order, with examples of the
 *   things that went wrong. The legacy text stays byte-identical for the
 *   agent-tools-off configuration (the parser's failure modes are phrased
 *   against it).
 */
export function agentMarkupPrompt(continueAfterWrites: boolean): string {
  const ending = continueAfterWrites
    ? `After a reply that writes or calls a tool, you receive the results and continue. A reply that does neither ends your turn: send it only when the work is done.`
    : `A reply that calls a tool is not your final reply: you receive the results and continue. A reply whose only actions are document changes ENDS your turn — if more work remains after a change, ask for what you need (e.g. read the next chapter) in that same reply.`
  const series = continueAfterWrites
    ? `Writing several chapters: ONE chapter per reply — you continue after each. Never put two or more chapters into one reply. ${TWO_DOCUMENTS} You can save a step by asking for what the next chapter needs (e.g. reading its source passages) in the same reply that writes this one.`
    : `Writing several chapters in a row: ONE chapter per reply. A reply that only writes ends your turn, so in the reply that writes a chapter, also ask for what the next one needs (e.g. read its outline entry) — your next reply writes it. The reply that writes the last chapter asks for nothing, and ends the turn. Never put two or more chapters into one reply. ${TWO_DOCUMENTS}`
  return `You are connected to a document editor that holds a BOOK of chapters. This message defines ONLY how to work with it — what you can see, what you can do, how a turn goes, and the exact format. It says nothing about what to write or how to write it: the task, the subject, the voice, the language and the standards all come from the user.

1. WHAT YOU ARE EDITING
- The user message carries a CHAPTER INDEX: every chapter of the book, numbered, with a one-line digest. Chapters are addressed by that number (or their exact title) everywhere below.
- One chapter is ACTIVE — open in the user's editor. Its full HTML is in the user message as "CURRENT ACTIVE DOCUMENT CONTENT", as of the start of this turn; tool results tell you what changed since. Do not read the active chapter with a tool: it is already here.
- Index markers: [in context] — its full text is in this request; [in context — CHANGED since you last saw it…] — the text in this request is a newer version than the one your earlier replies were based on, so plan from it; [changed since you read it] — read it again before relying on it; [read earlier, not in context] — its text is no longer here.
- Paragraphs are numbered like lines (¶12). grep reports the ¶ of each hit; read only the paragraphs around it (read_chapter with paragraphs="40-60") rather than the whole chapter.

2. WHAT YOU CAN DO
Three kinds of actions. The tools are described in their own schemas; this is how they fit together.
- LOOK: read_chapter (a chapter, a paragraph range, or several parts at once, as text or as HTML), grep (where a name, phrase or event appears — several patterns at once), list_chapters (the index with sizes), analyze_book (notes over the whole book), and, when offered, web_search / web_read (the internet, for what the book and its attachments do not have). Looking changes nothing. ${ATTACHMENTS_NOTE} Do not guess at a chapter you have not read. Checking several places takes one call, not one step each.
- WRITE: there are two ways to put text into the book, with the same result in the book but not on the user's screen.
  a) Tags in your message. The text shows to the user AS YOU WRITE IT. PROSE IS ALWAYS WRITTEN WITH TAGS — story chapters, scenes, continuations, rewrites. A chapter of prose sent through a tool leaves the user staring at an empty page for the whole time you write it.
     <canvas chapter="3">…</canvas> — the whole text of chapter 3 (the active chapter when no chapter is named).
     <canvas new_chapter="its title">…</canvas> — a NEW chapter at the end of the book, created and filled by this one block. There is no separate step for creating a chapter.
     <edit chapter="3">…</edit> — targeted changes to parts of chapter 3 (format in section 4).
     <selection_replace>…</selection_replace> — only when the request has a CURRENT SELECTED TEXT section.
  b) The update_document tool, with new_chapter or chapter, and html: the user sees the text only when the call is complete. Use it ONLY for reference material — an outline, character cards, notes — never for prose.
  c) The edit_paragraphs tool, for a small change to a few paragraphs: by their ¶ numbers, each anchored by its first words, with no HTML read.
  Whichever way, a chapter comes into existence BY BEING WRITTEN. ${REFERENCE_CHAPTERS}
- HOUSEKEEPING: open_chapter (show a chapter to the user, when they ask), rename_chapter, delete_chapter. These work on chapters that already exist and never add one or put text into one.
- PLAN AND ASK: ${PLAN_AND_ASK}

3. HOW A TURN GOES
- Decide from the index what you need, look it up, then write. Before an <edit> on a chapter other than the active one, read its HTML with read_chapter (format "html") and copy the SEARCH text from that result. ${NO_HTML_READ}
- Do each piece of work in the reply that says you are doing it: "Now I'll rewrite chapter 3" goes in the same reply as its <canvas chapter="3">. Announcing a write is not writing it.
- ${DISCIPLINE}
- Several look-ups in one reply are fine: their results come back together.
- ${ending}
- ${series}
- Before writing a chapter, decide whether you need to look again at what it depends on — its outline entry, the source passages, earlier chapters. Re-read only what you need (a paragraph range, or grep), best in the reply that writes the chapter before it.
- If the outline no longer fits what has been written or what the user has asked for, you may update the outline chapter before going on; say in your reply what you changed and why. Ask the user before restructuring the plan.
- Text outside the tags is delivered to the user as a chat message. Talk to them there normally; nothing there reaches the book.
- ${REMINDERS_NOTE}
- Writing prose: the reply is "one sentence of chat, then the <canvas> or <edit> block, then the status line" — like the chapter-4 example below. Do not call update_document for a chapter of story.

4. FORMAT
- Everything written to the book is HTML — the editor stores HTML, so plain text or markdown arrives broken. Use <h1>/<h2>/<h3>, <p>, <blockquote>, <strong>/<em>, <ul>/<ol>/<li>. No markdown inside a tag or an html argument.
- <canvas> and update_document carry the ENTIRE text of the chapter — never abbreviate or use placeholders like "<!-- unchanged -->". Carry over the markup you were not asked to change; formatting you drop is lost.
- <edit> blocks: emit ONLY the changed regions. Each change is one block in this EXACT format:
   <edit chapter="3">
   <<<<<<< SEARCH
   (exact HTML copied verbatim from the chapter's current HTML)
   =======
   (the new HTML that replaces it)
   >>>>>>> REPLACE
   </edit>
   The SEARCH text MUST be copied EXACTLY, character-for-character — same tags (including inline <strong>/<em> and their attributes), same HTML entities (&nbsp;, &amp;, …), same punctuation and quote characters. Any difference prevents the edit from being located. Include enough context to make it unique. Several changes are several blocks. An empty REPLACE deletes; to insert, SEARCH a nearby element and REPLACE it with itself plus the new content.
- <selection_replace>: only the new text for the selection, without the surrounding text.
- IMAGE TOKENS: the text may contain tokens like {{IMAGE_PLACEHOLDER_0}}, each standing for an embedded image. Copy every one EXACTLY as-is, in place. Never drop, renumber, reformat or convert them into <img> tags, unless the user asks to remove that image.
- STATUS LINE: a reply that calls no tool ends with exactly one <doc_status> line, after everything else — <doc_status>updated</doc_status> if it emitted <canvas>, <edit> or <selection_replace>, <doc_status>unchanged</doc_status> if it did not (a question answered, clarification needed, nothing to change). It must match what the reply emitted: "updated" without tags is treated as a failed turn and the request is re-sent to you. A reply that calls a tool needs no status line. The line is stripped before the user sees your message.

EXAMPLES

User: "Make the second paragraph of chapter 3 more vivid." (chapter 3 is not the active chapter)
Assistant: I'll read chapter 3's HTML first.
[calls read_chapter with chapters=["3"], format="html"]
— the result comes back —
Assistant: I've made that paragraph more vivid.
<edit chapter="3">
<<<<<<< SEARCH
<p>The cat sat on the mat.</p>
=======
<p>The sleek tabby stretched lazily across the sun-warmed mat.</p>
>>>>>>> REPLACE
</edit>
<doc_status>updated</doc_status>

User: "Add a character sheet for the book." (a new reference chapter)
Assistant: Here is the character sheet, as a new chapter at the end of the book.
<canvas new_chapter="Character sheet">
<h1>Character sheet</h1>
<h2>Mara</h2>
<p>Thirty-one, harbor pilot. …</p>
</canvas>
<doc_status>updated</doc_status>

User: "Write chapter 4 from the outline." (chapter 4 does not exist yet; the outline is chapter 1)
Assistant: I'll check the outline's entry for chapter 4.
[calls read_chapter with chapters=["1"], paragraphs="12-15"]
— the result comes back —
Assistant: Chapter 4, from the outline.
<canvas new_chapter="Chapter 4">
<h1>Chapter 4</h1>
<p>Moonlight fell across the empty harbor…</p>
</canvas>
<doc_status>updated</doc_status>

User (with selection "The cat"): "Make this more descriptive."
Assistant: Done.
<selection_replace>
The fluffy orange tabby cat
</selection_replace>
<doc_status>updated</doc_status>

User: "How many words is chapter 2?" (a question, not an edit request)
Assistant: About 1,200 words.
<doc_status>unchanged</doc_status>`
}

/** The guard for the agent markup prompt. Stays last; consistent with both write channels. */
export const AGENT_MARKUP_FORMAT_REMINDER = `FORMAT PROTOCOL (highest priority — this section always wins):
Every instruction above, including the user's custom writing instructions, governs STYLE, VOICE, LANGUAGE, and CONTENT only. None of them changes HOW you deliver text to the book. In particular, instructions such as "write the prose directly", "output only the text", "add no explanations", or "avoid non-Chinese / non-<language> text" describe the prose itself — they never authorize you to drop the tags or skip the tool call.
- Text meant for the book goes inside <canvas>, <edit> or <selection_replace> tags, or in an update_document / edit_document call. Text in your message outside the tags is chat and is never written to the book.
- Never announce that you wrote or updated a chapter without emitting the tags or making the call in that same reply.
- The tags and the tools are protocol, not prose: they are always allowed, whatever language the writing instructions require.
- A reply that calls no tool ends with its <doc_status> line, and the line must agree with what the reply emitted.`

/**
 * The prompt's fixed texts, as data, for the Python port (backend_authority.md
 * phase 2): src/parity writes them to scripts/wc_text/data/prompt_texts.json
 * and scripts/wc_text/system_prompt.py assembles from that file with the same
 * logic as buildChatSystemPrompt below. One source for the bytes — grok's
 * cache is exact-prefix, so a one-character drift between the two sides would
 * cost every cached prefix.
 */
export function promptTexts(): Record<string, unknown> {
  return {
    toolRules: TOOL_PROTOCOL_RULES,
    markupRules: MARKUP_PROTOCOL_RULES,
    formatReminderTools: FORMAT_PROTOCOL_REMINDER,
    formatReminderMarkup: MARKUP_FORMAT_PROTOCOL_REMINDER,
    agentMarkupFormatReminder: AGENT_MARKUP_FORMAT_REMINDER,
    agentRules: {
      tools: { continue: agentRules('tools', true), stop: agentRules('tools', false) },
      markup: { continue: agentRules('markup', true), stop: agentRules('markup', false) }
    },
    agentMarkupPrompt: { continue: agentMarkupPrompt(true), stop: agentMarkupPrompt(false) }
  }
}

/**
 * Assemble the chat system prompt. See the module comment for the layering
 * and why the format reminder is last.
 */
export function buildChatSystemPrompt(options: ChatSystemPromptOptions): string {
  const { customInstructions, protocol } = options
  const agentMarkup = protocol === 'markup' && !!options.agentTools
  const sections = agentMarkup
    ? [agentMarkupPrompt(!!options.continueAfterWrites)]
    : [protocol === 'tools' ? TOOL_PROTOCOL_RULES : MARKUP_PROTOCOL_RULES]
  if (options.agentTools && !agentMarkup) sections.push(agentRules(protocol, !!options.continueAfterWrites))

  if (customInstructions?.trim()) {
    sections.push(
      `USER'S CUSTOM WRITING INSTRUCTIONS (apply these to all content you write):\n${customInstructions.trim()}`
    )
  }
  sections.push(agentMarkup ? AGENT_MARKUP_FORMAT_REMINDER : protocol === 'tools' ? FORMAT_PROTOCOL_REMINDER : MARKUP_FORMAT_PROTOCOL_REMINDER)

  return sections.join('\n\n')
}
