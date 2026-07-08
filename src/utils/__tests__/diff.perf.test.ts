import { describe, it, expect } from 'vitest'
import { diffHtml } from '../diff'
import { parseEditBlocks, applyEditBlocks } from '../text'

/**
 * Performance characterization for the diff / edit-apply pipeline.
 *
 * These tests build dummy documents and run each realistic "match pattern" the
 * LLM output produces, measuring wall-clock time. Thresholds are intentionally
 * loose (~2-3x expected) so they don't flake on slow CI, but they still catch
 * an O(n^2) regression. The console table is the useful artifact — run with:
 *   npx vitest run src/utils/__tests__/diff.perf.test.ts --reporter=basic
 */

// ── Dummy content helpers ─────────────────────────────────────────────────────

const WORDS = (
  'the quick brown fox jumps over a lazy dog while birds sing softly in the ' +
  'morning light across the quiet riverbank under a pale and endless sky'
).split(' ')

/** A deterministic ~24-word paragraph, varied by seed. */
function para(seed: number): string {
  const out: string[] = []
  for (let i = 0; i < 24; i++) {
    out.push(WORDS[(seed * 7 + i * 13) % WORDS.length])
  }
  return out.join(' ')
}

/** Build an N-paragraph HTML document; `mut(i)` can override a paragraph's seed text. */
function makeDoc(n: number, mut: (i: number) => string | null = () => null): string {
  let html = ''
  for (let i = 0; i < n; i++) {
    const override = mut(i)
    html += `<p>${override ?? para(i)}</p>`
  }
  return html
}

// ── Timing harness ────────────────────────────────────────────────────────────

const results: { pattern: string; ms: number; del: number; ins: number; outKB: number }[] = []

function measure(pattern: string, oldHtml: string, newHtml: string): number {
  const start = performance.now()
  const out = diffHtml(oldHtml, newHtml)
  const ms = performance.now() - start
  results.push({
    pattern,
    ms: Math.round(ms * 100) / 100,
    del: (out.match(/<del/g) || []).length,
    ins: (out.match(/<ins/g) || []).length,
    outKB: Math.round(out.length / 102.4) / 10,
  })
  return ms
}

// ── diffHtml: match patterns ──────────────────────────────────────────────────

describe('diffHtml performance — match patterns', () => {
  const N = 400 // baseline document size (paragraphs)

  it('identical documents (no change)', () => {
    const doc = makeDoc(N)
    const ms = measure('identical', doc, doc)
    expect(ms).toBeLessThan(80)
  })

  it('single word changed in one paragraph', () => {
    const oldDoc = makeDoc(N)
    const newDoc = makeDoc(N, i => (i === N / 2 ? para(i) + ' EXTRA' : null))
    const ms = measure('1 word in 1 para', oldDoc, newDoc)
    expect(ms).toBeLessThan(150)
  })

  it('5 contiguous paragraphs fully rewritten (the reported case)', () => {
    const oldDoc = makeDoc(N)
    const newDoc = makeDoc(N, i => (i >= 100 && i < 105 ? para(i + 9000) : null))
    const ms = measure('5 contiguous rewritten', oldDoc, newDoc)
    expect(ms).toBeLessThan(250)
  })

  it('5 scattered paragraphs rewritten', () => {
    const oldDoc = makeDoc(N)
    const changed = new Set([20, 90, 180, 260, 350])
    const newDoc = makeDoc(N, i => (changed.has(i) ? para(i + 9000) : null))
    const ms = measure('5 scattered rewritten', oldDoc, newDoc)
    expect(ms).toBeLessThan(250)
  })

  it('full document rewrite (every paragraph different)', () => {
    const oldDoc = makeDoc(N)
    const newDoc = makeDoc(N, i => para(i + 100000))
    const ms = measure('full rewrite', oldDoc, newDoc)
    expect(ms).toBeLessThan(700)
  })

  it('append 5 paragraphs at the end', () => {
    const oldDoc = makeDoc(N)
    const newDoc = makeDoc(N + 5)
    const ms = measure('append 5 paras', oldDoc, newDoc)
    expect(ms).toBeLessThan(150)
  })

  it('insert 5 paragraphs in the middle', () => {
    const oldDoc = makeDoc(N)
    const head = makeDoc(N / 2)
    const inserted = Array.from({ length: 5 }, (_, k) => `<p>${para(k + 500000)}</p>`).join('')
    const tail = makeDoc(N).slice(head.length)
    const ms = measure('insert 5 paras mid', oldDoc, head + inserted + tail)
    expect(ms).toBeLessThan(200)
  })

  it('delete 5 paragraphs from the middle', () => {
    const oldDoc = makeDoc(N)
    const newDoc = makeDoc(N, i => (i >= 100 && i < 105 ? '' : null)).replace(/<p><\/p>/g, '')
    const ms = measure('delete 5 paras', oldDoc, newDoc)
    expect(ms).toBeLessThan(200)
  })

  it('one giant single paragraph heavily rewritten (no block boundaries)', () => {
    // 3000-word single <p>: exercises the token-level LCS + its cell cap.
    const big = (salt: number) => '<p>' + Array.from({ length: 3000 }, (_, i) => WORDS[(i * 17 + salt) % WORDS.length]).join(' ') + '</p>'
    const ms = measure('giant 1-para rewrite', big(0), big(1))
    expect(ms).toBeLessThan(700)
  })

  it('large document (1000 paras), small edit', () => {
    const oldDoc = makeDoc(1000)
    const newDoc = makeDoc(1000, i => (i === 500 ? para(i) + ' tweak' : null))
    const ms = measure('1000 paras, 1 edit', oldDoc, newDoc)
    expect(ms).toBeLessThan(300)
  })

  it('prints the performance table', () => {
    // eslint-disable-next-line no-console
    console.table(results)
    expect(results.length).toBeGreaterThan(0)
  })
})

// ── Edit-block pipeline (Method A) ────────────────────────────────────────────

describe('edit-block pipeline performance', () => {
  it('parse + apply 5 edits against a 400-paragraph document', () => {
    const doc = makeDoc(400)
    // Build 5 search/replace blocks targeting existing paragraphs.
    const blocksText = [50, 120, 200, 300, 390]
      .map(i => `<edit>\n<<<<<<< SEARCH\n<p>${para(i)}</p>\n=======\n<p>${para(i + 9000)}</p>\n>>>>>>> REPLACE\n</edit>`)
      .join('\n')

    const start = performance.now()
    const parsed = parseEditBlocks(blocksText)
    const applied = applyEditBlocks(doc, parsed.blocks)
    const diffed = diffHtml(doc, applied.html)
    const ms = performance.now() - start

    // eslint-disable-next-line no-console
    console.log(`[perf] edit-pipeline (parse+apply+diff, 5 edits / 400 paras): ${ms.toFixed(1)}ms, failed=${applied.failed.length}`)

    expect(parsed.blocks).toHaveLength(5)
    expect(applied.failed).toHaveLength(0)
    expect(diffed).toContain('<ins')
    expect(ms).toBeLessThan(300)
  })

  it('whitespace-fuzzy match still applies within budget', () => {
    const doc = makeDoc(400)
    // SEARCH with collapsed/altered whitespace forces the fuzzy regex path.
    const target = `<p>${para(200)}</p>`
    const fuzzySearch = target.replace(/ /g, '\n  ')
    const blocks = [{ search: fuzzySearch, replace: `<p>${para(200 + 9000)}</p>` }]

    const start = performance.now()
    const applied = applyEditBlocks(doc, blocks)
    const ms = performance.now() - start

    // eslint-disable-next-line no-console
    console.log(`[perf] edit-pipeline (fuzzy match, 400 paras): ${ms.toFixed(1)}ms, failed=${applied.failed.length}`)

    expect(applied.failed).toHaveLength(0)
    expect(ms).toBeLessThan(200)
  })
})
