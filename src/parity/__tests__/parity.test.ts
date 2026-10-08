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
import { htmlToPlainText, stripChatDisplayArtifacts, truncateWithNotice, detectReferencedDocIds, buildAttachmentsLabel, trimHistoryForContext } from '../../utils/llmContext'
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
  countWords, parseDocStatus, stripDocStatus, detectFailedDocumentUpdate, trimIncompleteHtmlTail, isBlankContent, type EditBlock
} from '../../utils/text'
import { getChapterDigest, buildChapterIndex, extractHeadingTree, packChaptersIntoBatches, WHOLE_BOOK_CONTEXT_CHARS, type IndexableDoc } from '../../utils/chapterIndex'
import { renderLedgerChapter, ledgerBlock, buildLedgerMessages, buildVolatileTail, type RenderableDoc, type DynamicContextOptions } from '../../hooks/chat/dynamicContext'
import { hashContent, planLedgerTurn, ledgerChapterIds, orderAdmissionsByStability, type ContextLedger, type LedgerDocLike, type LedgerEntry } from '../../utils/contextLedger'
import { extractKeywords, selectReferenceChapters, type SelectableDoc, type SelectionInput, type SelectionOptions } from '../../utils/contextSelection'
import { buildChatSystemPrompt, promptTexts } from '../../utils/systemPrompt'
import { DOCUMENT_TOOLS, toOpenAITools, toAnthropicTools, toGeminiTools, fromOpenAITools, type ToolSpec } from '../../utils/documentTools'

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
      build_attachments_label: run(buildAttachmentsLabel, [[['a', 'zz', 'b'], [{ id: 'a', title: '大纲' }, { id: 'b', title: '人物卡' }], ['b']], [[], [], []]])
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
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(mod)
    })
  }
})
