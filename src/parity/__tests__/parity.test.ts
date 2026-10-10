/**
 * TypeScript ↔ Python parity fixtures (backend_authority.md phase 2).
 *
 * Every case here is run through the TypeScript implementation and its
 * output recorded in scripts/parity/fixtures/<module>.json; scripts/
 * test_parity.py runs the same inputs through the Python port and must match
 * byte for byte. The TypeScript is the specification.
 *
 * Normally this test CHECKS that the committed fixtures still equal what the
 * TypeScript produces, so a change to a ported function cannot land without
 * regenerating them (and re-running the Python side). To regenerate:
 *   WRITE_FIXTURES=1 npx vitest run src/parity    (npm run parity:fixtures)
 */
import { describe, it, expect } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { htmlToPlainText, stripChatDisplayArtifacts, truncateWithNotice, detectReferencedDocIds, buildAttachmentsLabel, trimHistoryForContext, wasTurnInterrupted } from '../../utils/llmContext'
import { bare, splitForPolish, buildPolishPrompt, parsePolished, validatePolished, assemblePolished, type PolishSegment } from '../../utils/polish'
import type { LLMMessage } from '../../types/llm'
import { blockText, topLevelBlocks, chapterParagraphs, chapterChars, numberedLine } from '../../utils/paragraphs'
import { diffHtml, stripDiffMarkup } from '../../utils/diff'
import { resolveDiffMarkupInHtml } from '../../utils/diffResolution'
import { pendingChanges, renderPendingChanges } from '../../utils/pendingChanges'
import { replaceImagesWithPlaceholders, restoreImagePlaceholders, reinsertMissingImages, type ImagePlaceholderEntry } from '../../utils/imagePreservation'
import {
  stripIncompleteEndTag, chapterAttribute, newChapterAttribute, extractTaggedBlock, hasElisionMarkers, validateCanvasReplacement,
  parseEditBlocks, stripStrayDocumentMarkup, parseAssistantResponse, applyEditBlocks, applyEditBlocksLocally, stripBlankParagraphs,
  countWords, parseDocStatus, stripDocStatus, detectFailedDocumentUpdate, trimIncompleteHtmlTail, isBlankContent, type EditBlock, claimsOwnWrite } from '../../utils/text'
import { getChapterDigest, buildChapterIndex, extractHeadingTree, packChaptersIntoBatches, WHOLE_BOOK_CONTEXT_CHARS, type IndexableDoc } from '../../utils/chapterIndex'
import { renderLedgerChapter, ledgerBlock, buildLedgerMessages, buildVolatileTail, type RenderableDoc, type DynamicContextOptions } from '../../hooks/chat/dynamicContext'
import { hashContent, planLedgerTurn, ledgerChapterIds, orderAdmissionsByStability, type ContextLedger, type LedgerDocLike, type LedgerEntry } from '../../utils/contextLedger'
import { extractKeywords, selectReferenceChapters, type SelectableDoc, type SelectionInput, type SelectionOptions } from '../../utils/contextSelection'
import { buildChatSystemPrompt, promptTexts } from '../../utils/systemPrompt'
import { DOCUMENT_TOOLS, toOpenAITools, toAnthropicTools, toGeminiTools, fromOpenAITools, type ToolSpec } from '../../utils/documentTools'
import { acceptedHash, freshnessMarkers, type SeenRecord, type MarkableDoc } from '../../agent/freshness'
import { resolveContextWindowTokens, estimateTokens, tokensToChars, historyBudgetChars, cjkRatioOf } from '../../utils/contextWindow'
import { getCacheProfile, targetPromptTokens, checkThreshold, readCachedTokens } from '../../utils/providerProfile'
import { resolveDocumentProtocol, type DocumentProtocol } from '../../utils/protocolChoice'
import { leadingH1Text, titleFollowingHeading, contentWithRenamedHeading } from '../../utils/titleSync'
import { partialStringArgument, applyToolCallDelta, finishToolCalls, type ToolCallAccumulator, type FinishedToolCall } from '../../utils/toolCallStream'
import { splitStreamingResponse, buildCompletionWarnings, NO_ACTION_RETRY_INSTRUCTION, MAX_NO_ACTION_RETRIES, ASSISTANT_PLACEHOLDER, INTERRUPTED_NOTICE, RECONNECT_FAILED_NOTICE } from '../../hooks/chat/streamHandlers'
import { STEP_LIMIT_NOTE } from '../../agent/run'
import { resolveRunSettings, detectStepFailure, decideAfterStep, defaultMaxSteps, type ExecutedCall, type RunBudgets, type StepPolicy } from '../../agent/policy'
import { citeChapter, resolveChapter } from '../../agent/chapters'
import { collectStep, planWrites } from '../../agent/invocations'
import { ToolRegistry, defineTool } from '../../agent/registry'
import { nearestParagraph, nearestHint, describeDifferences, textSimilarity } from '../../utils/editHints'
import { applyPlanUpdate, renderPlan, nextPlanItem, unfinishedPlanItems, type PlanItem } from '../../utils/plan'
import { wrapReminder, escapeReminderTags, appendReminders, repeatNudge, longReasoningReminder, planUnfinishedNudge, planNotWrittenNote, htmlReadNudge, userEditedReminder, structureChangedReminder, queuedRequestReminder, interruptedTurnReminder, steerMessage, unbackedClaimNudge, REMINDERS_ARE_CONTEXT, REPEAT_NUDGE_STEPS, REPEAT_PAUSE_STEPS, PLAN_NUDGE_BUDGET } from '../../agent/reminders'
import { callSignature } from '../../utils/toolCallStream'
import { planConversationSummary, buildSummaryRequest, parseSummaryReply, summaryMessages, SUMMARY_SYSTEM_PROMPT, KEEP_FRACTION, SUMMARY_RESERVE_CHARS, SUMMARY_INPUT_CHARS, SUMMARY_MESSAGE_CHARS, SUMMARY_MIN_KEEP, type SummarizableMessage } from '../../utils/conversationSummary'
import { planElisions, promptTokens, calibratedPromptTokens, elidedResultNote, elisionTrace, ELIDE_ABOVE, ELIDE_TO } from '../../agent/runCompaction'
import { isRetryableStatus, isContextLengthError, parseRetryAfter, retryDelayMs, withJitter, MAX_TRANSPORT_RETRIES, MAX_RETRY_DELAY_MS, RETRYABLE_STATUSES } from '../../utils/retryPolicy'
import type { ToolInvocation, ToolKind } from '../../agent/types'

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../../../scripts/parity/fixtures')
const PROMPT_TEXTS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../scripts/wc_text/data/prompt_texts.json')
const WRITE = process.env.WRITE_FIXTURES === '1'

/** Diff group ids are random; both sides compare them renumbered in order of appearance. */
export function normalizeDiffIds(html: string): string {
  const seen = new Map<string, string>()
  return html.replace(/data-diff-id="([^"]*)"/g, (_m, id: string) => {
    if (!seen.has(id)) seen.set(id, `diff-${seen.size + 1}`)
    return `data-diff-id="${seen.get(id)}"`
  })
}

// ── Shared inputs ─────────────────────────────────────────────────────────

const CHAPTER = '<h1>第三章 风起</h1><p>阿青推开门，<strong>风</strong>从巷口灌进来。</p><p>她想：&ldquo;该走了。&rdquo;</p><blockquote><p>门外无人。</p></blockquote><ul><li>一</li><li>二 &amp; 三</li></ul><p><img src="data:image/png;base64,AAAA" alt="x"></p><p>{{IMAGE_PLACEHOLDER_0}}</p><p></p>   loose text here <hr><p>a&nbsp;b<br>c</p>'
const ENGLISH = '<h2>Title</h2><p>The cat sat on the mat.</p><p>It was <em>warm</em>, and &lt;quiet&gt; &quot;outside&quot; &#39;then&#39;.</p>'
const DIFFED = '<p>before <ins class="diff-addition" data-diff-id="diff-a">added</ins> after</p><p><del class="diff-deletion" data-diff-id="diff-b">gone</del>kept text</p><p><ins class="diff-addition" data-diff-id="diff-c">whole new paragraph</ins></p><ul><li><ins class="diff-addition" data-diff-id="diff-d">new item</ins></li></ul><p>old <del class="diff-deletion" data-diff-id="diff-e">word</del><ins data-diff-id="diff-e" class="diff-addition">term</ins> here</p><p><ins class="diff-addition" data-diff-id="diff-f">X </ins>A<ins class="diff-addition" data-diff-id="diff-f"> Y</ins></p>'
const paras = (changed: boolean) => Array.from({ length: 40 }, (_, i) => `<p>Paragraph ${i} ${i === 20 && changed ? 'CHANGED' : 'same'} text that goes on for a while to make tokens.</p>`).join('')

interface Case { input: unknown[]; output: unknown }
interface Module { module: string; cases: Record<string, Case[]> }

/** A run's messages after three reads (sys, user, then assistant/tool pairs) for the run-compaction cases. */
const RUN_MESSAGES: LLMMessage[] = [
  { role: 'system', content: 'sys' }, { role: 'user', content: 'request' },
  { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read_chapter', argumentsText: '{"chapter":"1"}' }] },
  { role: 'tool', toolCallId: 'c1', name: 'read_chapter', content: 'TEXT OF 1 ' + 'word '.repeat(400) },
  { role: 'assistant', content: '', toolCalls: [{ id: 'c2', name: 'read_chapter', argumentsText: '{"chapter":"2"}' }] },
  { role: 'tool', toolCallId: 'c2', name: 'read_chapter', content: '第二章 ' + '字'.repeat(900) },
  { role: 'assistant', content: '', toolCalls: [{ id: 'c3', name: 'read_chapter', argumentsText: '{"chapter":"3"}' }] },
  { role: 'tool', toolCallId: 'c3', name: 'read_chapter', content: 'TEXT OF 3 ' + 'word '.repeat(400) }
]
const RUN_ELIDABLE = [{ index: 3, trace: 'read 1' }, { index: 5, trace: 'read 2' }, { index: 7, trace: 'read 3' }]

/** n turns of `chars` chars each (u0 a0 u1 a1 …) for the conversation-summary cases. */
const SUMMARY_TURNS = (n: number, chars = 1000): SummarizableMessage[] =>
  Array.from({ length: n * 2 }, (_, i) => {
    const id = `${i % 2 === 0 ? 'u' : 'a'}${Math.floor(i / 2)}`
    return { id, role: i % 2 === 0 ? 'user' : 'assistant', content: `${id}:` + 'x'.repeat(Math.max(0, chars - id.length - 1)) }
  })

const run = <A extends unknown[]>(fn: (...a: A) => unknown, inputs: A[], post: (out: unknown) => unknown = o => o): Case[] =>
  // `undefined` would vanish from the JSON; Python's None is JSON null.
  inputs.map(input => ({ input, output: post(fn(...input)) ?? null }))

const EDIT = (search: string, replace: string, chapter?: string) =>
  `<edit${chapter ? ` chapter="${chapter}"` : ''}>\n<<<<<<< SEARCH\n${search}\n=======\n${replace}\n>>>>>>> REPLACE\n</edit>`
const RESPONSES: string[] = [
  'Just chat, no tags.\n<doc_status>unchanged</doc_status>',
  `Sure.\n<canvas>\n<h1>T</h1><p>a</p>\n</canvas>\n<doc_status>updated</doc_status>`,
  `Rewriting 3.\n<canvas chapter="3"><p>three</p></canvas>\nDone.\n<doc_status>updated</doc_status>`,
  `New chapter.\n<canvas new_chapter="第二章 进城"><p>进城</p></canvas>`,
  `<canvas><p>cut off`,
  `Edit.\n${EDIT('<p>a</p>', '<p>b</p>')}\nAnd more.\n<doc_status>updated</doc_status>`,
  `${EDIT('<p>a</p>', '<p>b</p>', '2')}${EDIT('<p>c</p>', '', '2')}`,
  `<selection_replace>new words</selection_replace>\n${EDIT('<p>x</p>', '<p>y</p>')}`,
  `${EDIT('<p>x</p>', '<p>y</p>')}\n<selection_replace>sel</selection_replace>`,
  `<canvas><p>active</p></canvas>\n${EDIT('<p>o</p>', '<p>p</p>', '1')}`,
  `<canvas><p>active</p></canvas>\n${EDIT('<p>o</p>', '<p>p</p>')}`,
  `<selection_replace>sel</selection_replace><canvas><p>stray</p></canvas>`,
  `<canvas><p>one</p></canvas><canvas chapter="4"><p>four</p></canvas><canvas new_chapter="五"><p>五</p></canvas>`,
  'chat <<<<<<< SEARCH\nunterminated',
  '<<<<<<< SEARCH\n<p>bare</p>\n=======\n<p>markers</p>\n>>>>>>> REPLACE',
  '<edit>\n<<<<<<< SEARCH\n<p>a</p>\n=======\n<p>b</p>\n</edit>\n<edit>\n<<<<<<< SEARCH\n<p>c</p>\n=======\n<p>d</p>\n</edit>',
  '<<<<<<< SEARCH\n<p>a</p>\n=======\n<p>b</p>\n<<<<<<< SEARCH\n<p>c</p>\n=======\n<p>d</p>\n>>>>>>> REPLACE',
  '<<<<<<< SEARCH\n<p>a</p>\n=======\n<p>half',
  '<<<<<<< SEARCH\n   \n=======\n<p>blank search</p>\n>>>>>>> REPLACE',
  'Canvas fenced.\n<canvas>\n```html\n<p>fenced</p>\n```\n</canvas>',
  '<CANVAS data-x="1"><p>caps</p></CANVAS >',
  '我已经把第二章改好了。\n<doc_status>unchanged</doc_status>',
  '你已经把第二章改好了。\n<doc_status>unchanged</doc_status>',
  "I've updated the paragraph.\n<doc_status>unchanged</doc_status>",
  'Here is the text.\n<doc_status>updated</doc_status>',
  'No declaration here.',
  '<edit>broken',
  '',
  'Streaming…\n<doc_sta',
  'Streaming…\n<doc_status>upd',
  'Streaming…\n<doc_status>updated</doc_st',
  'Prose with < less-than and <b>tag</b> end'
]
const DOC_PENDING = '<p>intro</p><p>keep <ins class="diff-addition" data-diff-id="d1">added words</ins> tail</p><p>second para here</p><ul><li>one</li><li>two</li></ul><p>中文段落在这里。</p>'
const LOCAL_EDITS: Array<[string, EditBlock[]]> = [
  [DOC_PENDING, [{ search: '<p>second para here</p>', replace: '<p>second paragraph here</p>' }]],
  [DOC_PENDING, [{ search: '<p>keep <ins class="diff-addition" data-diff-id="d1">added words</ins> tail</p>', replace: '<p>keep <ins class="diff-addition" data-diff-id="d1">added words</ins> tails</p>' }]],
  [DOC_PENDING, [{ search: 'added words', replace: 'added word' }]],
  [DOC_PENDING, [{ search: '中文段落在这里。', replace: '中文段落不在这里。' }, { search: '<p>intro</p>', replace: '<p>introduction</p>' }]],
  [DOC_PENDING, [{ search: '<li>two</li>', replace: '<li>two</li><li>three</li>' }]],
  [DOC_PENDING, [{ search: '<p>missing</p>', replace: '<p>x</p>' }]],
  ['<p>a &amp; b</p>', [{ search: '<p>a &amp; b</p>', replace: '<p>a &amp; c</p>' }]],
  ['<p>one <em>two</em> three</p>', [{ search: '<p>one <em>two</em> three</p>', replace: '<p>one <strong>two</strong> three</p>' }]],
  ['<p>gone <del class="diff-deletion" data-diff-id="d2">deleted words</del> here</p>', [{ search: 'deleted words', replace: 'other words' }]],
  ['<p>Alpha beta gamma delta.</p>', [{ search: '<p>Alpha beta gamma delta.</p>', replace: '<p>Alpha beta GAMMA delta.</p>' }]]
]
const APPLY_EDITS: Array<[string, EditBlock[]]> = [
  ['<p>Hello world</p>', [{ search: '<p>Hello world</p>', replace: '<p>Hi</p>' }]],
  ['<p>real content</p>', [{ search: '<p>hallucinated content</p>', replace: '<p>X</p>' }]],
  ['<p>a</p>\n  <p>b</p>', [{ search: '<p>a</p>\n<p>b</p>', replace: '<p>c</p>' }]],
  ['<p>a</p>', [{ search: '  <p>a</p>\n', replace: '<p>b</p>' }]],
  ['<p>a</p><p>b</p><p>c</p>', [{ search: '<p>a</p>', replace: '<p>A</p>' }, { search: '<p>c</p>', replace: '<p>C</p>' }, { search: '<p>zz</p>', replace: '' }]],
  ['<p>cost $5</p>', [{ search: '<p>cost $5</p>', replace: "<p>cost $1 and $& and $' and $$</p>" }]],
  ['<p>a&nbsp;b</p>', [{ search: '<p>a b</p>', replace: '<p>c</p>' }]],
  ['<p>“quoted” and ‘single’</p>', [{ search: '<p>"quoted" and \'single\'</p>', replace: '<p>q</p>' }]],
  ['<p>fish &amp; chips</p>', [{ search: '<p>fish & chips</p>', replace: '<p>f</p>' }]],
  ['<p>it&#39;s</p>', [{ search: '<p>it’s</p>', replace: '<p>its</p>' }]],
  ['<p>one <strong>two</strong> three</p>', [{ search: '<p>one two three</p>', replace: '<p>1 2 3</p>' }]],
  ['<p class="x">one</p><p>two</p><p>three</p>', [{ search: '<p>one</p><p>two</p>', replace: '<p>12</p>' }]],
  ['<p>“Hello,” she said.</p><p>“Bye,” he said.</p>', [{ search: '<p>“Hello, she said.</p><p>“Bye, he said.</p>', replace: '<p>x</p>' }]],
  ['<p>“Same” text</p><p>“Same” text</p>', [{ search: '<p>Same text</p>', replace: '<p>x</p>' }]],
  ['<p>one</p><p>Lead-in clause, then the tail sentence to change.</p><p>three</p>', [{ search: '<p>then the tail sentence to change.</p>', replace: '<p>then a better tail.</p>' }]],
  ['<p>Opening words here, and the rest of it stays.</p>', [{ search: '<p>Opening words here,</p>', replace: '<p>New opening,</p>' }]],
  ['<p>Keep this sentence. Rewrite this part please.</p>', [{ search: '<p>Rewrite this part please.</p>', replace: '<p>First new.</p><p>Second new.</p>' }]],
  ['<p>Keep this sentence. Remove this one please.</p>', [{ search: '<p>Remove this one please.</p>', replace: '' }]],
  ['<p>Alpha one. Alpha two.</p><p>Beta one. Beta two.</p>', [{ search: '<p>Alpha two.</p><p>Beta one.</p>', replace: '<p>Joined text.</p>' }]],
  ['<p>Lead <strong>bold excerpt text</strong> end.</p>', [{ search: '<p>bold excerpt text</p>', replace: '<p>new excerpt words</p>' }]],
  ['<p>First: same phrase here.</p><p>Second: same phrase here.</p>', [{ search: '<p>same phrase here.</p>', replace: '<p>X</p>' }]],
  ['<p>The opening clause stays here. The closing clause.</p>', [{ search: '<p>The closing clause.</p>', replace: '<p>The opening clause stays here, joined with the closing clause.</p>' }]],
  ['<p>Lead <strong>bold excerpt text</strong> end.</p>', [{ search: '<p>bold excerpt text</p>', replace: '<p>A.</p><p>B.</p>' }]],
  ['<p>Some lead text, then the excerpt to retitle.</p>', [{ search: '<p>then the excerpt to retitle.</p>', replace: '<h2>A heading</h2>' }]],
  ['<p>a big dog ran far</p>', [{ search: '<p>dog</p>', replace: '<p>cat</p>' }]],
  ['<p><a title="hidden tooltip words">link</a> rest</p>', [{ search: '<p>hidden tooltip words</p>', replace: '<p>X</p>' }]],
  [CHAPTER, [{ search: '<p>她想：&ldquo;该走了。&rdquo;</p>', replace: '<p>她想：“留下。”</p>' }, { search: '<li>二 &amp; 三</li>', replace: '<li>二和三</li>' }]],
  ['<p>x (a.b) [c] {d} *e* +f? ^g$ |h| \\i</p>', [{ search: '<p>x (a.b) [c] {d} *e* +f? ^g$ |h| \\i</p>', replace: '<p>ok</p>' }]]
]

// Books. Fields the index, the ledger and the selector read; the same rows feed all three.
const BOOK: Array<IndexableDoc & RenderableDoc & SelectableDoc> = [
  { id: 'd1', title: '大纲', content: '<h1>大纲</h1><p>全书 outline 简述。</p>', summary: 'The outline:\n  main arc,\n villains.  ' },
  { id: 'd2', title: '第一章 启程', content: CHAPTER, summary: '' },
  { id: 'd3', title: 'Chapter 3: The Cat', content: ENGLISH },
  { id: 'd4', title: '空章节', content: '', contentLoaded: false },
  { id: 'd5', title: 'Long', content: `<p>${'x'.repeat(600)}</p>`, summary: 'y'.repeat(500) }
]
const BIG_BOOK: IndexableDoc[] = Array.from({ length: 41 }, (_, i) => ({ id: `b${i}`, title: `Ch ${i}`, content: `<p>${'c'.repeat(200)} ${i}</p>`, summary: i % 2 ? `${'s'.repeat(160)} ${i}` : undefined }))
const RENDER = (id: string, kind: string) => `[${kind}:${id}]`
const LDOCS: LedgerDocLike[] = [{ id: 'd1', chars: 100, hash: 'h1' }, { id: 'd2', chars: 2000, hash: 'h2' }, { id: 'd3', chars: 300, hash: 'h3' }, { id: 'd4', chars: 400, hash: 'h4' }]
const L = (id: string, hash: string, chars: number, extra: Partial<LedgerEntry> = {}): LedgerEntry => ({ id, hash, chars, ...extra })
const LEDGER_123: ContextLedger = { entries: [L('d1', 'h1', 100), L('d2', 'h2', 2000), L('d3', 'h3', 300)] }
/** planLedgerTurn with a deterministic renderer in place of a function the JSON cannot carry. */
const planLedger = (current: ContextLedger, desired: string[], docs: LedgerDocLike[], active: string | null, o?: { render?: boolean; maxStaleChars?: number }) =>
  planLedgerTurn(current, desired, docs, active, { ...(o?.render ? { render: RENDER } : {}), ...(o?.maxStaleChars !== undefined ? { maxStaleChars: o.maxStaleChars } : {}) })
/** buildVolatileTail with one image registry per call, as a turn has. */
const volatileTail = (docs: RenderableDoc[], active: string | null, selected: string, opts?: DynamicContextOptions) => {
  const registry: ImagePlaceholderEntry[] = []
  return buildVolatileTail(docs, active, selected, html => replaceImagesWithPlaceholders(html, registry), opts)
}
const SDOCS: SelectableDoc[] = [
  { id: 'o', title: '大纲', content: '<p>outline</p>', summary: 'dragon king villain arc' },
  { id: 'c1', title: '第一章', content: `<p>${'a'.repeat(30000)}</p>` },
  { id: 'c2', title: '第二章', content: '<p>two</p>', summary: '龙王 出场' },
  { id: 'c3', title: 'Chapter 3: Dragon', content: '', contentLoaded: false },
  { id: 'c4', title: '第四章', content: '<p>four</p>', contentLoaded: true },
  { id: 'c5', title: 'Notes', content: '<p>n</p>', summary: 'dragon dragon king' }
]
const SEL = (over: Partial<SelectionInput>): SelectionInput => ({ promptText: '', recentHistory: [], documents: SDOCS, activeDocumentId: 'c2', ...over })
const PROMPT_OPTIONS = (['tools', 'markup'] as const).flatMap(protocol => [false, true].flatMap(agentTools => [false, true].flatMap(continueAfterWrites =>
  ['', '  ', ' 写武侠。 \n', '\ufeffbom'].map(customInstructions => [{ protocol, agentTools, continueAfterWrites, customInstructions }] as [Parameters<typeof buildChatSystemPrompt>[0]]))))
const OTHER_TOOL: ToolSpec = { name: 'x', description: '', parameters: { type: 'object' } }

const HISTORY: LLMMessage[] = [
  { role: 'assistant', content: 'leading assistant' },
  { role: 'user', content: '  ' },
  { role: 'user', content: 'first', images: ['data:image/png;base64,AAAA'] },
  { role: 'user', content: '', images: ['data:image/png;base64,BBBB'] },
  { role: 'assistant', content: 'reply one', responseItems: [{ type: 'reasoning', encrypted_content: 'r1' }] },
  { role: 'assistant', content: '\n', responseItems: [] },
  { role: 'assistant', content: 'reply two', responseItems: [{ type: 'reasoning', encrypted_content: 'r2' }] },
  { role: 'user', content: '第二个问题，长一点的中文内容在这里。' },
  { role: 'assistant', content: 'final reply with ${marker} and $& text' }
]
const POLISH_PARA = (n: number, i = 0) => `<p>${`第${i}段，她说：“我们走吧。”他没有回头。`.repeat(Math.ceil(n / 20)).slice(0, n)}</p>`
const POLISH_HTML = `<h2>第一章</h2>${POLISH_PARA(600, 1)}${POLISH_PARA(600, 2)}<p><img src="x.png"></p>${POLISH_PARA(100, 3)}<p>{{IMAGE_PLACEHOLDER_0}}</p><p>  </p>${POLISH_PARA(300, 4)}<p>她<strong>没有</strong>回头 &amp; 走了。</p>`
const POLISH_SEGS: PolishSegment[] = splitForPolish(POLISH_HTML)

const SEEN_DOCS: MarkableDoc[] = [
  { id: 'a', content: '<p>alpha</p>' }, { id: 'b', content: '<p>beta <ins class="diff-addition" data-diff-id="x">new</ins></p>' },
  { id: 'c', content: '', contentLoaded: false }, { id: 'd', content: '<p>delta</p>' }, { id: 'e', content: '<p>eps</p>' }
]
/** freshnessMarkers mutates the record: both sides return it with the markers. */
const freshness = (docs: MarkableDoc[], active: string | null, inContext: string[], seen: Record<string, { hash: string; turn: number }>, turn: number) => {
  const record: SeenRecord = new Map(Object.entries(seen))
  const markers = freshnessMarkers(docs, active, inContext, record, turn)
  return { markers, seen: Object.fromEntries(record) }
}
const applyDeltas = (deltas: Array<Parameters<typeof applyToolCallDelta>[1]>) => {
  const acc = new Map<number, ToolCallAccumulator>()
  for (const d of deltas) applyToolCallDelta(acc, d)
  return { accumulators: Object.fromEntries(acc), finished: finishToolCalls(acc) }
}
const CALL = (name: string, args: Record<string, unknown> | null, id?: string) => ({ id, name, args, argumentsText: args ? JSON.stringify(args) : '{bad' })
const RESULT = (ok: boolean, retryable?: boolean) => ({ ok, content: ok ? 'done' : 'failed', trace: 't', ...(retryable === undefined ? {} : { retryable }) })
const EXEC = (kind: ToolKind, ok: boolean, retryable?: boolean): ExecutedCall => ({ kind, result: RESULT(ok, retryable) })
const B = (maxSteps: number, maxCorrective = 3): RunBudgets => ({ maxSteps, maxCorrective })
const P = (continueAfterWrites: boolean, feedBackFailedWrites: boolean): StepPolicy => ({ continueAfterWrites, feedBackFailedWrites })
const DECIDE = (executed: ExecutedCall[], stepsTaken: number, correctiveUsed: number, budgets: RunBudgets, policy: StepPolicy) =>
  decideAfterStep({ executed, stepsTaken, correctiveUsed, budgets, policy })
const TOOL_DESCRIPTORS = [
  { name: 'update_document', kind: 'write', markupForm: true }, { name: 'edit_document', kind: 'write', markupForm: true },
  { name: 'replace_selection', kind: 'write', markupForm: true }, { name: 'polish_chapter', kind: 'write' },
  { name: 'read_chapter', kind: 'read' }, { name: 'open_chapter', kind: 'navigate' }
] as const
/** collectStep over a registry built from plain descriptors, which the JSON can carry. */
const collect = (text: string, nativeCalls: FinishedToolCall[], step: number, opts?: { markupProtocol?: boolean }) => {
  const registry = new ToolRegistry(TOOL_DESCRIPTORS.map(d => defineTool<Record<string, unknown>>({
    name: d.name, description: '', parameters: { type: 'object' }, kind: d.kind, markupForm: 'markupForm' in d ? d.markupForm : undefined,
    isAvailable: () => true, parse: raw => raw ?? 'none', execute: () => RESULT(true)
  })))
  return collectStep(text, nativeCalls, registry, step, opts)
}
const INV = (name: string, args: Record<string, unknown> | null): ToolInvocation => ({ id: name, name, args, source: 'native' })
const CHAPTERS = [{ id: 'c1', title: '第一章 启程' }, { id: 'c2', title: 'Chapter 2: The Road' }, { id: 'c3', title: '大纲' }, { id: 'c4', title: '第二章 进城' }, { id: 'c5', title: '第二章 入城' }]
const MANY = Array.from({ length: 15 }, (_, i) => ({ id: `m${i}`, title: `Part ${i + 1}` }))

const HINT_HTML = '<h1>第三章</h1><p class="x">她说：“我们走吧。”他没有回头，<em>风</em>从巷口灌进来&nbsp;——&nbsp;冷得很。</p><p>第二段很普通。</p><p><img src="a"></p>'
const PLAN: PlanItem[] = [{ id: 'a', title: '第一章', status: 'done' }, { id: 'b', title: '第二章', status: 'in_progress' }, { id: 'c', title: '第三章', status: 'pending' }]

const MODULES: Module[] = [
  {
    module: 'text',
    cases: {
      strip_incomplete_end_tag: run(stripIncompleteEndTag, [['abc</selection_replace>'], ['abc</selection_re'], ['abc e>'], ['</sel in middle'], [''], ['</selection_replace>']]),
      chapter_attribute: run(chapterAttribute, [['<canvas chapter="3">'], ["<edit chapter='第二章'>"], ['<canvas new_chapter="x">'], ['<canvas>'], ['<canvas chapter="  ">'], ['<canvas CHAPTER = "4" >']]),
      new_chapter_attribute: run(newChapterAttribute, [['<canvas new_chapter="第二章 进城">'], ["<canvas new_chapter=' 尾声 '>"], ['<canvas new_chapter="">'], ['<canvas chapter="3">']]),
      extract_tagged_block: run(extractTaggedBlock, [['no tags', 'canvas'], ['before <canvas><p>x</p></canvas> after', 'canvas'], ['<canvas><p>cut', 'canvas'], ['<Canvas foo="bar"><p>x</p></canvas >', 'canvas'], ['<canvas>\n```html\n<p>f</p>\n```\n</canvas>', 'canvas'], ['a <selection_replace>s</selection_replace> b', 'selection_replace'], [RESPONSES[2], 'canvas'], [RESPONSES[3], 'canvas']]),
      has_elision_markers: run(hasElisionMarkers, [['<p>a</p><!-- rest unchanged --><p>z</p>'], ['<p>[content continues]</p>'], ['<p>(rest of the document remains the same)</p>'], ['<p>...</p>'], ['<p>She paused... and went on.</p>'], ['<p>The story continues in the next room.</p>'], ['<p>ordinary</p>'], ['<p>[TRUNCATED]</p>']]),
      validate_canvas_replacement: run(validateCanvasReplacement, [['<p>x</p>', false], ['<p>[unchanged]</p>', true], ['<p>x</p>', true], ['<p>[unchanged]</p>', false]]),
      parse_edit_blocks: run(parseEditBlocks, RESPONSES.map(r => [r] as [string])),
      strip_stray_document_markup: run(stripStrayDocumentMarkup, RESPONSES.map(r => [r] as [string])),
      parse_assistant_response: run(parseAssistantResponse, RESPONSES.map(r => [r] as [string])),
      apply_edit_blocks: run(applyEditBlocks, APPLY_EDITS),
      apply_edit_blocks_locally: run(applyEditBlocksLocally, LOCAL_EDITS, o => ({ ...(o as object), html: normalizeDiffIds((o as { html: string }).html) })),
      strip_blank_paragraphs: run(stripBlankParagraphs, [['<p></p><p> </p><p>&nbsp;</p><p><br></p><p>x</p>\n\n<p>y</p>'], ['<ul><li>a</li>\n<li>b</li></ul>\n<h2>t</h2>'], ['<p>keep  inside</p>']]),
      count_words: run(countWords, [['<p>Hello world</p>'], ['<p>你好世界</p>'], ['<p>你好 world and 世界</p>'], ['<p>kept <del>gone words</del></p>'], ['<p>a &amp; b &lt; c</p>'], ['<p>a&nbsp;b</p>'], ["<p>don't stop re-enter self‑aware</p>"], [''], ['<p>Ünïcödé wörds 123 and カタカナ 한글</p>']]),
      parse_doc_status: run(parseDocStatus, RESPONSES.map(r => [r] as [string])),
      strip_doc_status: run(stripDocStatus, RESPONSES.map(r => [r] as [string])),
      detect_failed_document_update: run(detectFailedDocumentUpdate, RESPONSES.map(r => [r] as [string])),
      claims_own_write: run(claimsOwnWrite, [['I have rewritten chapter 1.'], ['我已经把第三章改好了'], ['你已经把第二章改好了'], ['Here is the updated text'], ['Does this read well?'], ['']]),
      trim_incomplete_html_tail: run(trimIncompleteHtmlTail, [['<p>The sleek ta'], ['<p>a</p><h'], ['<p>a &nbs'], ['<p>a</p><p>unclosed'], ['<p>fish & chips are good today</p>'], [''], ['<p>a &amp</p>']]),
      is_blank_content: run(isBlankContent, [[''], ['<p></p>'], ['<p>&nbsp; </p>'], ['<p>x</p>'], ['<p><img src="a"></p>'], ['<h1></h1><p>\n</p>']])
    }
  },
  {
    module: 'llm_context',
    cases: {
      html_to_plain_text: run(htmlToPlainText, [[CHAPTER], [ENGLISH], [''], ['<p>a</p>\n\n\n<p>b</p>'], ['&amp;lt; stays &amp;lt;'], ['<div>x<br/>y</div><pre>z</pre>'], ['<p>tail   \n</p>'], ['<ol><li class="a">one</li><li>two</li></ol>']]),
      strip_chat_display_artifacts: run(stripChatDisplayArtifacts, [
        ['[Attached Context: 大纲 (auto)]\n[Attached Context: 第一章]\n\n写好了。'],
        ['写好了。\n\n⚠️ The response was cut off before it finished.'],
        ['📚 analyzing…\n写好了。\n🔁 retrying…\n完。'],
        ['只有正文。'], ['⚠️ Error: boom'], ['写好了。\n\n⚠️ 2 suggested changes could not be located\nmore'], ['']
      ]),
      truncate_with_notice: run(truncateWithNotice, [['短', 10], ['一二三四五六七八九十', 4], ['abcdef', 6]]),
      detect_referenced_doc_ids: run(detectReferencedDocIds, [
        ['对照大纲和第一章改写', [{ id: 'a', title: '大纲' }, { id: 'b', title: 'Chapter 1: 第一章' }, { id: 'c', title: 'x' }, { id: 'd', title: '第一章' }], 'd'],
        ['nothing here', [{ id: 'a', title: 'Outline' }], null]
      ]),
      trim_history_for_context: run(trimHistoryForContext, [
        [HISTORY, { maxChars: 100000 }], [HISTORY, { maxChars: 30 }], [HISTORY, { maxChars: 30, minKeepMessages: 4 }], [HISTORY, { maxChars: 100000, keepImages: true }],
        [HISTORY, { maxChars: 0, minKeepMessages: 0 }], [[{ role: 'assistant', content: 'only' }], { maxChars: 10 }], [[], { maxChars: 10 }]
      ]),
      build_attachments_label: run(buildAttachmentsLabel, [[['a', 'zz', 'b'], [{ id: 'a', title: '大纲' }, { id: 'b', title: '人物卡' }], ['b']], [[], [], []]]),
      was_turn_interrupted: run(wasTurnInterrupted, [[[{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b', agent: { status: 'stopped' } }]], [[{ role: 'user', content: 'a' }, { role: 'assistant', content: 'x\n\n⏹️ Stopped.' }, { role: 'user', content: 'again' }]], [[{ role: 'user', content: 'a' }, { role: 'assistant', content: 'done', agent: { status: 'done' } }]], [[]]])
    }
  },
  {
    module: 'paragraphs',
    cases: {
      block_text: run(blockText, [['<p>a&nbsp;b<br>c</p>'], ['<ul><li>x</li><li>y &amp; z</li></ul>'], ['<p>  tail \t\n</p>'], ['plain']]),
      top_level_blocks: run(topLevelBlocks, [[CHAPTER], [ENGLISH], [''], ['loose only'], ['<p>a</p> between <p>b</p>'], ['<p>un &amp; closed'], ['<img src="x"><p>after</p>'], ['<p><img src="y"/></p>text &amp; more']]),
      chapter_paragraphs: run(chapterParagraphs, [[CHAPTER], [ENGLISH], ['<p>{{IMAGE_PLACEHOLDER_3}}</p>'], ['<h1>标题</h1><p>一。</p><p></p><p><img src="x"></p><ul><li>a</li><li>b</li></ul>loose'], [DIFFED]]),
      chapter_chars: run(chapterChars, [[CHAPTER], [ENGLISH], ['']]),
      numbered_line: run(numberedLine, chapterParagraphs('<h2>T</h2><p>a &amp; b</p><p><img src="x"></p><ul><li>x</li><li>y</li></ul>').map(p => [p] as [typeof p]))
    }
  },
  {
    module: 'diff',
    cases: {
      diff_html: run(diffHtml, [
        ['<p>Hello</p>', '<p>Hello</p>'], ['<p>Hello</p>', '<p>Hello world</p>'], ['<p>Hello world</p>', '<p>Hello</p>'],
        ['<p>foo bar</p>', '<p>foo baz</p>'], ['', '<p>Hello</p>'], ['<p>Hello</p>', ''], ['', ''], ['<p>old</p>', '<p>new</p>'],
        ['<p>a b</p>', '<p>a  b</p>'], ['<p>你好世界</p>', '<p>你好中国</p>'], ['<p>AAA BBB CCC</p>', '<p>AAA ZZZ CCC</p>'],
        ['<p>one</p><p>two</p><p>three</p>', '<p>one</p><p>TWO</p><p>three</p>'], ['<p>one</p><p>two</p>', '<p>one</p><p>new</p><p>two</p>'],
        ['<p>one</p><p>two</p><p>three</p>', '<p>one</p><p>three</p>'], [paras(false), paras(true)],
        [CHAPTER, CHAPTER.replace('风从巷口灌进来', '雨从檐角落下来').replace('<li>一</li>', '<li>壹</li>')],
        ['<h1>T</h1><p>x</p>', '<h2>T</h2><p>x</p>'], ['<p>a</p>', '<p>a</p><ul><li>b</li></ul>']
      ], o => normalizeDiffIds(o as string)),
      strip_diff_markup: run(stripDiffMarkup, [[DIFFED], ['<p>plain</p>'], [''], ['<p><ins>not a diff</ins> <del>either</del></p>']])
    }
  },
  {
    module: 'diff_resolution',
    cases: {
      resolve_diff_markup_in_html: run(resolveDiffMarkupInHtml, [[DIFFED, 'accept'], [DIFFED, 'reject'], ['<p>plain</p>', 'accept'],
        ['<blockquote><p><ins class="diff-addition" data-diff-id="d">q</ins></p></blockquote><p>after</p>', 'reject'],
        ['<ul><li><p><del class="diff-deletion" data-diff-id="d">gone</del></p></li></ul>', 'accept']])
    }
  },
  {
    module: 'pending_changes',
    cases: {
      pending_changes: run(pendingChanges, [[DIFFED], ['<p>plain</p>'], ['']]),
      render_pending_changes: run(renderPendingChanges, [[pendingChanges(DIFFED)], [[]], [[{ was: 'x'.repeat(1600), now: 'y\ny' }, { was: '', now: 'added' }, { was: 'removed', now: '' }]],
        [Array.from({ length: 30 }, (_, i) => ({ was: `was ${i} ${'w'.repeat(300)}`, now: `now ${i} ${'n'.repeat(300)}` }))]])
    }
  },
  {
    module: 'image_preservation',
    cases: {
      replace_images_with_placeholders: run((html: string, registry: ImagePlaceholderEntry[]) => ({ html: replaceImagesWithPlaceholders(html, registry), registry }), [
        [CHAPTER, []], ['<p><img src="a"><img src="b"><img src="a"></p>', [{ placeholder: '{{IMAGE_PLACEHOLDER_0}}', tag: '<img src="b">' }]], ['<p>none</p>', []]
      ]),
      restore_image_placeholders: run(restoreImagePlaceholders, [
        ['<p>{{IMAGE_PLACEHOLDER_0}} and {{ IMAGE_PLACEHOLDER_1 }} and {IMAGE-PLACEHOLDER-0} and image_placeholder 1</p>', [{ placeholder: '{{IMAGE_PLACEHOLDER_0}}', tag: '<img src="a">' }, { placeholder: '{{IMAGE_PLACEHOLDER_1}}', tag: '<img src="b">' }]],
        ['<p><img src="{{IMAGE_PLACEHOLDER_0}}" alt="x"> {{IMAGE_PLACEHOLDER_9}}</p>', [{ placeholder: '{{IMAGE_PLACEHOLDER_0}}', tag: '<img src="a">' }]]
      ]),
      reinsert_missing_images: run(reinsertMissingImages, [
        ['<p>Intro paragraph text, edited.</p><p>Second paragraph.</p><p>Third.</p>', '<p>Intro paragraph text.</p><p><img src="a.png" alt="A"></p><p>Second paragraph.</p><img src="b.png"><p>Third.</p>'],
        ['<p>Intro paragraph text.</p><p><img src="a.png" alt="A"></p><p>Nothing matches here.</p><p>Nor here.</p>', '<p>Intro paragraph text.</p><p><img src="a.png" alt="A"></p><p>Second paragraph.</p><img src="b.png"><p>Third.</p>'],
        ['<p>All new text.</p>', '<img src="first.png"><p>one</p><p>two</p><p>three</p><p><img src="late.png"></p>'],
        ['<p>No images &ldquo;here&rdquo; <br/></p>', '<p>plain original</p>'],
        ['', '<p>t</p><p><img src="only.png"></p>'],
        ["<p class='x'>a &amp; b &ldquo;q&rdquo;</p><p>second &nbsp; para</p>", '<p>a &amp; b “q”</p><p><img src="k.png"></p><p>second   para</p>'],
        ['<p>kept</p><img src="same.png"><p>after</p>', '<p>kept</p><img src="same.png"><p>after</p><img src="">']
      ])
    }
  },
  {
    module: 'polish',
    cases: {
      bare: run(bare, [['她说：“我们走吧。”他，没有 回头… — ·,.!?'], [''], ['plain words']]),
      split_for_polish: run(splitForPolish, [[POLISH_HTML], [POLISH_HTML, 100], ['<p>她<strong>没有</strong>回头。</p>'], [''], ['<p>a</p> loose <p></p><h1>t</h1>'], [CHAPTER]]),
      build_polish_prompt: run(buildPolishPrompt, [
        ['n={n}|prev={prev}|part={part}', ['他来了。她走了。'], ['前面一句。最后一句！']], ['n={n}|prev={prev}|part={part}', ['开头。'], null],
        ['{part} {part} {n}', ['含 $& 和 $$ 和 $1 的段落'], ['无标点的前文']], ['{prev}', ['x'], ['一句话。“带引号的结尾。”']], ['{prev}', ['x'], []]
      ]),
      parse_polished: run(parsePolished, [['说明\n<p>一</p>\n<p class="x">二</p>'], ['一\n\n二'], ['<p> </p><p>&nbsp;</p>'], [''], ['<P>caps</P>\n<p>multi\nline</p>']]),
      validate_polished: run(validatePolished, [
        [['她说：“我们走吧。”他没有回头。'], ['她说：“我们走吧。”他并没有回头。']], [['她说：“我们走吧。”他没有回头。'], []],
        [['她说：“我们走吧。”他没有回头。'], ['她说：“我们不走了。”他没有回头，' + '一'.repeat(40) + '。']], [['a', 'b', 'c', 'd'], ['a']],
        [['短。'], ['短短短短短短短短短短。']], [[''], ['x']], [['他没有回头。'], ['他没有回头']]
      ]),
      assemble_polished: run(assemblePolished, [[POLISH_SEGS, [['A'], null, ['B', 'C']]], [POLISH_SEGS, []], [[], []]])
    }
  },
  {
    module: 'chapter_index',
    cases: {
      get_chapter_digest: run(getChapterDigest, [[BOOK[0]], [BOOK[1]], [BOOK[3]], [BOOK[4]], [BOOK[4], 150], [{ id: 'z', title: 'z', content: '<p>\n body \n</p>', summary: '   ' }]]),
      build_chapter_index: run(buildChapterIndex, [[BOOK, 'd2'], [BOOK, 'd2', { agentTools: true, markers: { d1: 'in context', d3: 'read this turn' } }], [BOOK, null], [[BOOK[0]], 'd1'], [BIG_BOOK, 'b0', { agentTools: true }], [BIG_BOOK, 'b40']]),
      extract_heading_tree: run(extractHeadingTree, [[CHAPTER], [ENGLISH], ['<h1>A</h1><h2>B &amp; C</h2><h3>D\n  E</h3><h4>no</h4><H2 class="x">F</H2><h1></h1><h2>open'], ['']]),
      pack_chapters_into_batches: run(packChaptersIntoBatches, [[BOOK, 100], [BOOK, 10], [[], 50], [BOOK, 100000]]),
      whole_book_context_chars: run(() => WHOLE_BOOK_CONTEXT_CHARS, [[]])
    }
  },
  {
    module: 'dynamic_context',
    cases: {
      render_ledger_chapter: run(renderLedgerChapter, [['T', CHAPTER, 20000], ['T', CHAPTER, 10], ['', '', 5]]),
      ledger_block: run(ledgerBlock, [[BOOK[1]], [BOOK[1], 'update'], [{ ...BOOK[1], content: DIFFED }, 'fresh', 30]]),
      build_ledger_messages: run(buildLedgerMessages, [[BOOK, ['d1', 'd3']], [BOOK, []], [BOOK, ['zz']], [BOOK, [{ id: 'd1', text: 'FROZEN\n' }, 'd3', { id: 'd4' }], 50, { agentTools: true }], [BOOK, ['d5'], 20]]),
      build_volatile_tail: run(volatileTail, [
        [BOOK, 'd2', ''], [BOOK, 'd2', '<p>选中 <img src="s"> 文本</p>', { agentTools: true, markers: { d1: 'in context' } }], [[BOOK[1]], 'd2', ''], [BOOK, 'zz', ''],
        [[{ ...BOOK[1], content: DIFFED }, BOOK[0]], 'd2', '', { agentTools: true }], [BOOK, 'd3', 'sel only']
      ])
    }
  },
  {
    module: 'context_ledger',
    cases: {
      hash_content: run(hashContent, [[''], ['abc'], [CHAPTER], ['😀 emoji'], ['x'.repeat(5000)]]),
      plan_ledger_turn: run(planLedger, [
        [{ entries: [] }, ['d1', 'd2'], LDOCS, 'd3'],
        [LEDGER_123, ['d1', 'd2', 'd3'], LDOCS, null],
        [LEDGER_123, ['d1', 'd3'], LDOCS, null],
        [{ entries: [L('d1', 'old', 100), L('d2', 'h2', 2000), L('d3', 'h3', 300)] }, ['d1', 'd2', 'd3'], LDOCS, null],
        [{ entries: [L('d1', 'old', 100), L('d2', 'h2', 2000), L('d3', 'h3', 300)] }, ['d1', 'd2', 'd3'], LDOCS, null, { render: true }],
        [{ entries: [L('d1', 'h1', 100), L('d2', 'old', 2000), L('d3', 'h3', 300)] }, ['d1', 'd2', 'd3'], LDOCS, null, { render: true }],
        [LEDGER_123, ['d1', 'd2', 'd3'], LDOCS, 'd2', { render: true }],
        [{ entries: [L('d1', 'old', 100, { stale: true }), L('d2', 'h2', 2000), L('d1', 'h1', 100, { text: '[update:d1]' }), L('d3', 'h3', 300)] }, ['d1', 'd2', 'd3', 'd4'], LDOCS, null, { render: true, maxStaleChars: 50 }],
        [{ entries: [L('d1', 'old', 100, { stale: true }), L('d2', 'h2', 2000), L('d1', 'h1', 100, { text: '[update:d1]' }), L('d3', 'h3', 300)] }, ['d1', 'd2', 'd3', 'd4'], LDOCS, null, { render: true }],
        [{ entries: [L('gone', 'g', 10), L('d2', 'h2', 2000)] }, ['d2', 'd2', 'd4', 'nope'], LDOCS, 'd4'],
        [{ entries: [L('d2', 'old', 2000), L('d1', 'h1', 100)] }, ['d1', 'd2'], LDOCS, null, { render: true }]
      ]),
      ledger_chapter_ids: run(ledgerChapterIds, [[{ entries: [L('a', '', 1), L('b', '', 1), L('a', '', 1)] }], [{ entries: [] }]]),
      order_admissions_by_stability: run(orderAdmissionsByStability, [
        [['a', 'b', 'c', 'd'], [{ id: 'a', updatedAt: '2026-01-05T00:00:00.000Z' }, { id: 'b', updatedAt: '2025-12-01T00:00:00Z' }, { id: 'c' }, { id: 'd', updatedAt: '2025-12-01T00:00:00Z' }], ['c', 'd', 'b', 'a'], 'c'],
        [['a', 'b', 'c', 'd'], [{ id: 'a', updatedAt: '2026-01-05T00:00:00.000Z' }, { id: 'b', updatedAt: 'not-a-date' }, { id: 'c', updatedAt: '2025-06-01' }, { id: 'd', updatedAt: '2025-12-01T00:00:00Z' }], ['c', 'd', 'b', 'a'], null],
        [['x', 'y'], [], ['y', 'x'], 'x'], [[], [], [], null]
      ])
    }
  },
  {
    module: 'context_selection',
    cases: {
      extract_keywords: run(extractKeywords, [['Please write about the Dragon King and chapter 3 这是一个测试句子'], ['短'], ['aaa'], [Array.from({ length: 100 }, (_, i) => `word${i}`).join(' ')], ['日本語のテキスト and MIXED Case'], ['中文很长的一段话'.repeat(20), 10], ['']]),
      select_reference_chapters: run(selectReferenceChapters, [
        [SEL({ promptText: '对照大纲，写龙王出场', recentHistory: ['x', '第四章 ok'] })],
        [SEL({ promptText: 'Dragon king please', activeDocumentId: 'c1', previousAttachedIds: ['c4'], modelReadIds: ['c5'], ledgerIds: ['o', 'c1'] })],
        [SEL({ activeDocumentId: null })],
        [SEL({ promptText: 'dragon' }), { maxTotalChars: 100 } as SelectionOptions],
        [SEL({ promptText: 'dragon', recentHistory: ['大纲', 'a', 'b', 'c', 'd'] }), { scoreThreshold: 0, perDocChars: 5 }],
        [SEL({ promptText: '大纲 第一章 Notes', activeDocumentId: 'c5', previousAttachedIds: ['c1', 'c2'], ledgerIds: ['c5', 'c2'] })]
      ])
    }
  },
  {
    module: 'freshness',
    cases: {
      accepted_hash: run(acceptedHash, [[SEEN_DOCS[1].content], [''], ['<p>x</p>']]),
      freshness_markers: run(freshness, [
        [SEEN_DOCS, 'a', ['b'], {}, 1],
        [SEEN_DOCS, 'a', ['b', 'c'], { b: { hash: 'old', turn: 0 }, c: { hash: 'old', turn: 0 }, d: { hash: acceptedHash('<p>delta</p>'), turn: 0 }, e: { hash: 'old', turn: 0 } }, 2],
        [SEEN_DOCS, null, [], { c: { hash: 'x', turn: 0 }, a: { hash: acceptedHash('<p>alpha</p>'), turn: 0 } }, 3],
        [SEEN_DOCS, 'a', ['b'], { b: { hash: acceptedHash('<p>beta new</p>'), turn: 0 } }, 4]
      ])
    }
  },
  {
    module: 'context_window',
    cases: {
      resolve_context_window_tokens: run(resolveContextWindowTokens, [['grok', 'grok-4.6'], ['grok', 'grok-3-mini'], ['openai', 'gpt-4o-mini'], ['openai', 'GPT-4.1-nano'], ['anthropic', 'claude-opus-4-8'], ['gemini', 'gemini-2.5-pro'], ['ollama', 'qwen3'], ['ollama', 'qwen3', 262144], ['runpod', ''], ['grok', 'grok-4.6', 0]]),
      estimate_tokens: run(estimateTokens, [[''], ['hello world'], ['你好世界'], ['mixed 中文 text'], ['a']]),
      tokens_to_chars: run(tokensToChars, [[1000, 0], [1000, 1], [1000, 0.5], [1000, 2], [1000, -1], [7, 0.3]]),
      history_budget_chars: run(historyBudgetChars, [[{ contextTokens: 131072, maxOutputTokens: 16384, fixedTokens: 30000, cjkRatio: 0.8 }], [{ contextTokens: 32768, maxOutputTokens: 16384, fixedTokens: 20000, cjkRatio: 0 }], [{ contextTokens: 200000, maxOutputTokens: 4096, fixedTokens: 0, cjkRatio: 0.123 }]]),
      cjk_ratio_of: run(cjkRatioOf, [[''], ['abc'], ['你好'], ['你好ab'], ['㐀豈 x']])
    }
  },
  {
    module: 'provider_profile',
    cases: {
      get_cache_profile: run(getCacheProfile, [['grok'], ['ollama'], ['anthropic'], ['openai'], ['gemini'], ['runpod'], ['nope']]),
      target_prompt_tokens: run(targetPromptTokens, [[getCacheProfile('grok'), 256000], [getCacheProfile('grok'), 131072], [getCacheProfile('ollama'), 262144]]),
      check_threshold: run(checkThreshold, [[getCacheProfile('grok'), 250000], [getCacheProfile('grok'), 1000], [getCacheProfile('ollama'), 1000]]),
      read_cached_tokens: run(readCachedTokens, [[getCacheProfile('grok'), { prompt_tokens_details: { cached_tokens: 12 } }], [getCacheProfile('grok'), { prompt_tokens_details: {} }], [getCacheProfile('anthropic'), { cache_read_input_tokens: 7 }], [getCacheProfile('ollama'), { x: 1 }], [getCacheProfile('gemini'), 'junk'], [getCacheProfile('openai'), { prompt_tokens_details: { cached_tokens: 'no' } }]])
    }
  },
  {
    module: 'protocol_choice',
    cases: {
      resolve_document_protocol: run(resolveDocumentProtocol, [['grok', undefined], ['grok', 'tools'], ['ollama', 'auto' as DocumentProtocol], ['runpod', 'markup'], ['openai', undefined], ['gemini', 'auto' as DocumentProtocol], ['weird', undefined]])
    }
  },
  {
    module: 'title_sync',
    cases: {
      leading_h1_text: run(leadingH1Text, [['<h1>第一章 启程</h1><p>x</p>'], ['  <h1 class="t">A &amp; <em>B</em><del>gone</del></h1>'], ['<p>no heading</p><h1>late</h1>'], ['<h1>   </h1>'], ['<h1>unclosed'], ['']]),
      title_following_heading: run(titleFollowingHeading, [['<h1>Old</h1>', '<h1>New</h1>', 'Old'], ['<h1>Old</h1>', '<h1>Old</h1>', 'Renamed'], ['<p>x</p>', '<p>y</p>', 'T'], ['<h1>A</h1>', '<h1>A</h1>', 'A'], ['', '<h1>Fresh</h1>', undefined]]),
      content_with_renamed_heading: run(contentWithRenamedHeading, [['<h1>Old</h1><p>x</p>', 'New & <Better>'], ['<h1>Same</h1>', 'Same'], ['<p>none</p>', 'T'], ['<h1>Old</h1>', '   '], ['<h1><ins class="diff-addition" data-diff-id="d">Old</ins></h1>', 'New'], ['<h1>Old $& $1</h1>', 'N$&'], ['\n  <h1 id="h">Old</h1><h1>Old</h1>', 'New']])
    }
  },
  {
    module: 'tool_call_stream',
    cases: {
      partial_string_argument: run(partialStringArgument, [['{"html": "<p>Hal', 'html'], ['{"html":"a\\"b\\n\\u00e9', 'html'], ['{"chapter": "3", "html": "<p>x</p>"}', 'html'], ['{"html": 5}', 'html'], ['{"other": "x"}', 'html'], ['{"html"', 'html'], ['{"html" :\n "tail\\', 'html'], ['', 'html']]),
      apply_tool_call_delta: run(applyDeltas, [
        [[{ index: 0, id: 'c1', function: { name: 'read_chapter', arguments: '{"cha' } }, { index: 0, function: { arguments: 'pter": "2"}' } }]],
        [[{ index: 1, function: { name: 'x', arguments: 'junk' } }, { index: 0, id: 'a', function: { name: 'y' } }]],
        [[{ index: 0, function: { name: 'x', arguments: '{"a":1}' } }, { index: 0, function: { arguments: '{"a":2}' }, replace: true }]],
        [[{ function: { name: 'n', arguments: '{}' }, signature: 'sig' }, { index: 0, function: { arguments: '' } }]],
        [[{ index: 0, function: { arguments: '{"no":"name"}' } }]],
        [[]]
      ])
    }
  },
  {
    module: 'stream_handlers',
    cases: {
      constants: run(() => ({ NO_ACTION_RETRY_INSTRUCTION, MAX_NO_ACTION_RETRIES, ASSISTANT_PLACEHOLDER, INTERRUPTED_NOTICE, RECONNECT_FAILED_NOTICE, STEP_LIMIT_NOTE }), [[]]),
      split_streaming_response: run(splitStreamingResponse, [...RESPONSES, 'Hi <canv', 'Lead\n<canvas chapter="2">partial', '<selection_replace>half', 'a\n<edit>\n<<<<<<< SEARCH\nx'].map(r => [r] as [string])),
      build_completion_warnings: run(buildCompletionWarnings, [
        [{ canvasIssue: null, editFailedCount: 0, exhaustedNoActionRetries: false, reinsertedImages: 0 }],
        [{ canvasIssue: 'truncated', editFailedCount: 1, exhaustedNoActionRetries: false, reinsertedImages: 1, strayMarkup: 1 }],
        [{ canvasIssue: 'elided', editFailedCount: 2, exhaustedNoActionRetries: true, reinsertedImages: 2, strayMarkup: 2, selectionGone: true, unretriableFailedUpdate: true, toolCallProducedNothing: true }],
        [{ canvasIssue: null, editFailedCount: 0, exhaustedNoActionRetries: false, reinsertedImages: 0, strayMarkup: 3, unretriableFailedUpdate: true }]
      ])
    }
  },
  {
    module: 'policy',
    cases: {
      default_max_steps: run(defaultMaxSteps, [['grok'], ['ollama'], ['runpod'], ['openai']]),
      resolve_run_settings: run(resolveRunSettings, [['grok', undefined], ['grok', { agentTools: false }], ['ollama', { agentMaxSteps: 0 }], ['grok', { agentMaxSteps: 2.7, continueAfterWrites: false }], ['grok', { agentMaxSteps: -1 }], ['grok', { agentMaxSteps: 4 }, false], ['openai', { agentTools: true, continueAfterWrites: true }]]),
      detect_step_failure: run(detectStepFailure, [
        [{ text: 'chat only', writeProtocol: 'markup', hadNativeCalls: false, markupKind: 'chat' }],
        [{ text: 'chat only', writeProtocol: 'tools', hadNativeCalls: false, markupKind: 'chat' }],
        [{ text: 'x', writeProtocol: 'markup', hadNativeCalls: true, markupKind: 'chat' }],
        [{ text: 'x', writeProtocol: 'markup', hadNativeCalls: false, markupKind: 'canvas' }],
        [{ text: 'Done.\n<doc_status>updated</doc_status>', writeProtocol: 'markup', hadNativeCalls: false, markupKind: 'chat' }],
        [{ text: 'Done.\n<doc_status>updated</doc_status>', writeProtocol: 'markup', hadNativeCalls: false, markupKind: 'chat', wroteThisRun: true }],
        [{ text: '<edit>broken', writeProtocol: 'markup', hadNativeCalls: false, markupKind: 'chat', wroteThisRun: true }],
        [{ text: '我已经写好了。\n<doc_status>unchanged</doc_status>', writeProtocol: 'markup', hadNativeCalls: false, markupKind: 'chat' }]
      ]),
      decide_after_step: run(DECIDE, [
        [[], 1, 0, B(6), P(true, true)],
        [[EXEC('read', true)], 1, 0, B(6), P(true, true)],
        [[EXEC('read', true)], 6, 0, B(6), P(true, true)],
        [[EXEC('read', true)], 5, 0, B(6), P(true, true)],
        [[EXEC('write', true)], 1, 0, B(6), P(true, true)],
        [[EXEC('write', true)], 1, 0, B(6), P(false, true)],
        [[EXEC('write', false)], 1, 0, B(6), P(true, true)],
        [[EXEC('write', false)], 1, 3, B(6), P(true, true)],
        [[EXEC('write', false, false)], 1, 0, B(6), P(true, true)],
        [[EXEC('write', false)], 1, 0, B(6), P(true, false)],
        [[EXEC('write', false)], 6, 0, B(6), P(true, true)],
        [[EXEC('write', true)], 6, 0, B(6), P(true, true)],
        [[EXEC('navigate', true), EXEC('write', false)], 2, 0, B(0), P(true, true)],
        [[EXEC('read', true)], 99, 0, B(0), P(false, false)]
      ])
    }
  },
  {
    module: 'chapters',
    cases: {
      cite_chapter: run(citeChapter, [[{ id: 'x', title: 'T "q"', number: 3 }]]),
      resolve_chapter: run(resolveChapter, [[3, CHAPTERS], ['3', CHAPTERS], [' #2 ', CHAPTERS], [0, CHAPTERS], ['9', CHAPTERS], [2.5, CHAPTERS], ['大纲', CHAPTERS], ['  chapter 2: the road ', CHAPTERS], ['启程', CHAPTERS], ['第二章', CHAPTERS], ['nothing', CHAPTERS], ['', CHAPTERS], [null, CHAPTERS], [{ x: 1 }, CHAPTERS], ['   ', CHAPTERS], ['missing', MANY], ['Part', MANY], [true, CHAPTERS]])
    }
  },
  {
    module: 'invocations',
    cases: {
      collect_step: run(collect, [
        ['Just chat', [], 0], [RESPONSES[1], [], 1], [RESPONSES[6], [], 2], [RESPONSES[8], [], 3], [RESPONSES[12], [], 4],
        ['Reading.', [CALL('read_chapter', { chapters: ['2'] }, 'c1'), CALL('nope', null)], 5],
        [`With tags beside a native write.\n<canvas><p>tag</p></canvas>`, [CALL('update_document', { html: '<p>native</p>' }, 'w1')], 6],
        [`With tags beside a native write.\n<canvas><p>tag</p></canvas>`, [CALL('update_document', { html: '<p>native</p>' }, 'w1')], 7, { markupProtocol: true }],
        [`Polish and tags.\n<canvas chapter="2"><p>tag</p></canvas>`, [CALL('polish_chapter', { chapter: '1' }, 'p1')], 8],
        ['', [{ id: undefined, name: 'read_chapter', args: { chapters: ['1'] }, argumentsText: '{"chapters":["1"]}', signature: 'sig' }], 9]
      ]),
      plan_writes: run(planWrites, [
        [[INV('update_document', { html: 'a' }), INV('edit_document', { edits: [] })]],
        [[INV('update_document', { html: 'a' }), INV('replace_selection', { html: 's' }), INV('edit_document', { edits: [] }), INV('update_document', { html: 'b', chapter: '3' }), INV('update_document', { html: 'c', new_chapter: 'T' }), INV('polish_chapter', { chapter: '1' })]],
        [[]]
      ])
    }
  },
  {
    module: 'edit_hints',
    cases: {
      text_similarity: run(textSimilarity, [['abcd', 'abcd'], ['abcd', 'abce'], ['', 'x'], ['a', 'a'], ['你好世界', '你好中国'], ['abcdef', 'xyz']]),
      describe_differences: run(describeDifferences, [
        [HINT_HTML, '<p>她说："我们走吧。"他没有回头，风从巷口灌进来 -- 冷得很。</p>'],
        ['<p>it&#39;s a &amp; b … done</p>', "<p>it's a & b ... done</p>"], ['<p>plain</p>', '<p>plain</p>'], ['<p>a\u00a0b</p>', '<p>a b</p>']
      ]),
      nearest_paragraph: run(nearestParagraph, [
        [HINT_HTML, '<p>她说："我们走吧。"他没有回头，风从巷口灌进来 -- 冷得很。</p>'], [HINT_HTML, '<p>第二段很普通。</p><p>more</p>'],
        [HINT_HTML, '<p>completely unrelated english text here</p>'], [HINT_HTML, ''], [HINT_HTML, '<p>第二段普通</p>']
      ]),
      nearest_hint: run(nearestHint, [[HINT_HTML, '<p>她说："我们走吧。"他没有回头，风从巷口灌进来 -- 冷得很。</p>'], [HINT_HTML, '<p>nothing like it at all</p>'], [`<p>${'长'.repeat(700)}</p>`, `<p>${'长'.repeat(690)}</p>`]])
    }
  },
  {
    module: 'plan',
    cases: {
      apply_plan_update: run(applyPlanUpdate, [
        [[], [{ title: '第一章' }, { title: '第二章', status: 'in_progress' }], undefined],
        [PLAN, [{ id: 'b', status: 'done' }, { id: 'c', status: 'in_progress' }], undefined],
        [PLAN, [{ id: 'zz', status: 'done' }], true], [PLAN, [{ id: 'a', title: '第一章（改）', status: 'completed' }], true],
        [PLAN, [{ title: 'x' }, { title: 'x' }], undefined], [PLAN, [{ id: 1, title: 'num', status: 'cancelled' }, { id: 1, title: 'dup' }], undefined],
        [[], [], undefined], [[], [{ status: 'done' }], undefined], [PLAN, 'junk', undefined]
      ]),
      render_plan: run(renderPlan, [[PLAN], [[{ id: 'a', title: 'only', status: 'done' }]], [[]]]),
      next_plan_item: run(nextPlanItem, [[PLAN], [[{ id: 'a', title: 'x', status: 'done' }]]]),
      unfinished_plan_items: run(unfinishedPlanItems, [[PLAN]])
    }
  },
  {
    module: 'reminders',
    cases: {
      constants: run(() => ({ REMINDERS_ARE_CONTEXT, REPEAT_NUDGE_STEPS, REPEAT_PAUSE_STEPS, PLAN_NUDGE_BUDGET }), [[]]),
      wrap_reminder: run(wrapReminder, [['note'], ['two\nlines'], ['a </system-reminder> b <SYSTEM-REMINDER>c']]),
      escape_reminder_tags: run(escapeReminderTags, [['plain <p>x</p>'], ['</system-reminder><system-reminder>']]),
      interrupted_turn_reminder: run(interruptedTurnReminder, [[]]),
      steer_message: run(steerMessage, [['把第二段删掉'], ['two\nlines']]),
      unbacked_claim_nudge: run(unbackedClaimNudge, [[{ writes: 0, reads: 1, planLeft: 0 }], [{ writes: 0, reads: 2, planLeft: 1 }]]),
      append_reminders: run(appendReminders, [
        [[{ role: 'assistant', content: 'x' }, { role: 'tool', toolCallId: 'c', name: 'read_chapter', content: 'TEXT' }], ['r1', 'r2']],
        [[{ role: 'user', content: '' }], ['r']], [[{ role: 'user', content: 'u' }], []], [[], ['r']]
      ]),
      repeat_nudge: run(repeatNudge, [[['list_chapters'], 3], [['read_chapter', 'grep'], 5], [['x'], 6]]),
      long_reasoning_reminder: run(longReasoningReminder, [[12345], [900]]),
      plan_unfinished_nudge: run(planUnfinishedNudge, [[PLAN], [[{ id: 'a', title: 'one', status: 'pending' }]]]),
      user_edited_reminder: run(userEditedReminder, [[[{ number: 2, title: '第二章' }]], [[{ number: 1, title: 'A' }, { number: 3, title: 'C' }]]]),
      structure_changed_reminder: run(structureChangedReminder, [['1. "A"\n2. "B"']]),
      queued_request_reminder: run(queuedRequestReminder, [[1], [3]]),
      plan_not_written_note: run(planNotWrittenNote, [['改写第十四章']]),
      html_read_nudge: run(htmlReadNudge, [['📖 read #1 "大纲" ¶88–88 (0.1k, html)']]),
      call_signature: run(callSignature, [['read_chapter', { chapters: ['2'], format: 'html' }], ['read_chapter', { format: 'html', chapters: ['2'] }], ['x', { a: { z: 1, b: [3, { y: 2, x: 1 }] } }], ['x', null, '{broken'], ['x', null], ['grep', { pattern: '阿青|阿红', n: 1.5, ok: true }]])
    }
  },
  {
    module: 'conversation_summary',
    cases: {
      constants: run(() => ({ SUMMARY_SYSTEM_PROMPT, KEEP_FRACTION, SUMMARY_RESERVE_CHARS, SUMMARY_INPUT_CHARS, SUMMARY_MESSAGE_CHARS, SUMMARY_MIN_KEEP }), [[]]),
      plan_conversation_summary: run(planConversationSummary, [
        [SUMMARY_TURNS(5), 20_000, null], [SUMMARY_TURNS(10), 16_000, null], [SUMMARY_TURNS(10), 16_000, { upToId: 'u6', text: 'NOTE' }],
        [SUMMARY_TURNS(12), 10_000, { upToId: 'u2', text: 'OLD' }], [SUMMARY_TURNS(10), 10_000, { upToId: 'gone', text: 'OLD' }],
        [SUMMARY_TURNS(3, 5_000), 100, null], [[{ id: 'i', role: 'user', content: '', images: ['data:x'] }, ...SUMMARY_TURNS(4, 3_000)], 7_000, null], [[], 10, null]
      ]),
      build_summary_request: run(buildSummaryRequest, [
        [null, SUMMARY_TURNS(2, 30)], ['PRIOR', SUMMARY_TURNS(2, 30)], [null, [{ id: 'i', role: 'user', content: '  ', images: ['data:x'] }]],
        ['P', Array.from({ length: 40 }, (_, i) => ({ id: `m${i}`, role: i % 2 ? 'assistant' : 'user', content: `m${i}:` + 'y'.repeat(4_600) }) as SummarizableMessage)]
      ]),
      parse_summary_reply: run(parseSummaryReply, [['Here.\n<summary>\n1. x\n</summary>\ndone'], ['plain'], ['<summary>  </summary>'], [''], ['<SUMMARY>a</SUMMARY>']]),
      summary_messages: run(summaryMessages, [['NOTE'], ['two\nlines']])
    }
  },
  {
    module: 'run_compaction',
    cases: {
      constants: run(() => ({ ELIDE_ABOVE, ELIDE_TO }), [[]]),
      elided_result_note: run(elidedResultNote, [['read #1 "A" ¶1–40 (12.3k, html)']]),
      elision_trace: run(elisionTrace, [[['a']], [['a', 'b']]]),
      prompt_tokens: run(promptTokens, [[RUN_MESSAGES], [[]], [[{ role: 'assistant', content: '', toolCalls: [{ id: 'c', name: 'read_chapter', argumentsText: '{"chapter":"1"}' }] }]]]),
      plan_elisions: run(planElisions, [
        [RUN_MESSAGES, RUN_ELIDABLE, 1_000, 5], [RUN_MESSAGES, RUN_ELIDABLE, 100_000, 5], [RUN_MESSAGES, RUN_ELIDABLE, 1_000, 2],
        [RUN_MESSAGES, [], 1_000, 5], [RUN_MESSAGES, RUN_ELIDABLE, 0, 5], [RUN_MESSAGES, [{ index: 40, trace: 'gone' }], 10, 5],
        [RUN_MESSAGES, RUN_ELIDABLE, 3_000, 7, { tokens: 3_100, length: 6 }], [RUN_MESSAGES, RUN_ELIDABLE, 3_000, 7, { tokens: 100, length: 6 }],
        [RUN_MESSAGES, RUN_ELIDABLE, 3_000, 7, { tokens: 900_000, length: 6 }], [RUN_MESSAGES, RUN_ELIDABLE, 1_000, 7, { tokens: 5, length: 40 }]
      ]),
      calibrated_prompt_tokens: run(calibratedPromptTokens, [
        [RUN_MESSAGES, null], [RUN_MESSAGES, { tokens: 1_234, length: 4 }], [RUN_MESSAGES, { tokens: 0, length: 4 }], [RUN_MESSAGES, { tokens: 10, length: 99 }],
        [[{ role: 'user', content: '' }, { role: 'user', content: 'abc' }], { tokens: 7, length: 1 }]
      ])
    }
  },
  {
    module: 'retry_policy',
    cases: {
      constants: run(() => ({ MAX_TRANSPORT_RETRIES, MAX_RETRY_DELAY_MS, RETRYABLE_STATUSES }), [[]]),
      is_retryable_status: run(isRetryableStatus, [[429, ''], [503, 'busy'], [400, ''], [401, 'x'], [529, ''], [413, 'prompt is too long'], [408, 'timeout']]),
      is_context_length_error: run(isContextLengthError, [[400, "This model's maximum context length is 131072 tokens"], [413, 'Prompt is too long'], [422, 'too many tokens in input'], [400, 'bad tool'], [503, 'context length']]),
      parse_retry_after: run(parseRetryAfter, [['7'], [' 1.5 '], ['0'], ['-3'], ['Wed, 21 Oct 2026 07:28:00 GMT'], [''], [null]]),
      retry_delay_ms: run(retryDelayMs, [[1, null], [2, null], [4, null], [6, null], [1, 12], [1, 0.4], [3, 600], [0, null]]),
      with_jitter: run(withJitter, [[1000, 0], [1000, 0.5], [1000, 0.999], [2500, 0.25], [1000, -1], [1000, 2], [1, 0.5]])
    }
  },
  {
    module: 'system_prompt',
    cases: {
      build_chat_system_prompt: run(buildChatSystemPrompt, PROMPT_OPTIONS)
    }
  },
  {
    module: 'document_tools',
    cases: {
      document_tools: run(() => DOCUMENT_TOOLS, [[]]),
      to_openai_tools: run(toOpenAITools, [[DOCUMENT_TOOLS], [[OTHER_TOOL]]]),
      to_anthropic_tools: run(toAnthropicTools, [[DOCUMENT_TOOLS]]),
      to_gemini_tools: run(toGeminiTools, [[DOCUMENT_TOOLS], [[OTHER_TOOL]]]),
      from_openai_tools: run(fromOpenAITools, [[toOpenAITools(DOCUMENT_TOOLS)], [[{ type: 'function', function: { name: 'n', parameters: { type: 'object' } } }, { function: { name: 3, parameters: {} } }, null, 'junk', { function: { name: 'p', parameters: 'bad' } }, { function: { name: 'q', parameters: [] } }]], [[]]])
    }
  }
]

describe('prompt texts', () => {
  it('the committed prompt texts equal the TypeScript constants', () => {
    const texts = promptTexts()
    if (WRITE) {
      mkdirSync(dirname(PROMPT_TEXTS), { recursive: true })
      writeFileSync(PROMPT_TEXTS, JSON.stringify(texts, null, 1) + '\n')
      return
    }
    expect(existsSync(PROMPT_TEXTS), `${PROMPT_TEXTS} missing — run: npm run parity:fixtures`).toBe(true)
    expect(JSON.parse(readFileSync(PROMPT_TEXTS, 'utf8'))).toEqual(texts)
  })
})

describe('parity fixtures', () => {
  for (const mod of MODULES) {
    it(`${mod.module}: the committed fixtures equal the TypeScript output`, () => {
      const path = resolve(FIXTURES, `${mod.module}.json`)
      const json = JSON.stringify(mod, null, 1) + '\n'
      if (WRITE) {
        mkdirSync(FIXTURES, { recursive: true })
        writeFileSync(path, json)
        return
      }
      expect(existsSync(path), `${path} missing — run: npm run parity:fixtures`).toBe(true)
      // Both sides through JSON: an `undefined` input is null in the file.
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(JSON.parse(json))
    })
  }
})
