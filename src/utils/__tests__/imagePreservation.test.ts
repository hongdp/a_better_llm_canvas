import { describe, it, expect } from 'vitest'
import {
  replaceImagesWithPlaceholders,
  restoreImagePlaceholders,
  reinsertMissingImages,
  type ImagePlaceholderEntry
} from '../imagePreservation'

const IMG_A = '<img src="data:image/png;base64,AAAA" alt="a">'
const IMG_B = '<img src="data:image/jpeg;base64,BBBB" alt="b">'

describe('replaceImagesWithPlaceholders', () => {
  it('replaces img tags with sequential placeholders and registers them', () => {
    const registry: ImagePlaceholderEntry[] = []
    const html = `<p>one</p>${IMG_A}<p>two</p>${IMG_B}`
    const out = replaceImagesWithPlaceholders(html, registry)
    expect(out).toBe('<p>one</p>{{IMAGE_PLACEHOLDER_0}}<p>two</p>{{IMAGE_PLACEHOLDER_1}}')
    expect(registry).toEqual([
      { placeholder: '{{IMAGE_PLACEHOLDER_0}}', tag: IMG_A },
      { placeholder: '{{IMAGE_PLACEHOLDER_1}}', tag: IMG_B }
    ])
  })

  it('reuses the same placeholder for an already-registered tag across calls', () => {
    const registry: ImagePlaceholderEntry[] = []
    replaceImagesWithPlaceholders(`<p>doc</p>${IMG_A}`, registry)
    const out = replaceImagesWithPlaceholders(`<p>selection</p>${IMG_A}`, registry)
    expect(out).toBe('<p>selection</p>{{IMAGE_PLACEHOLDER_0}}')
    expect(registry).toHaveLength(1)
  })

  it('replaces duplicate occurrences of the same tag', () => {
    const registry: ImagePlaceholderEntry[] = []
    const out = replaceImagesWithPlaceholders(`${IMG_A}${IMG_A}`, registry)
    expect(out).toBe('{{IMAGE_PLACEHOLDER_0}}{{IMAGE_PLACEHOLDER_0}}')
  })
})

describe('restoreImagePlaceholders', () => {
  const registry: ImagePlaceholderEntry[] = [
    { placeholder: '{{IMAGE_PLACEHOLDER_0}}', tag: IMG_A },
    { placeholder: '{{IMAGE_PLACEHOLDER_1}}', tag: IMG_B }
  ]

  it('restores exact placeholders', () => {
    const out = restoreImagePlaceholders('<p>x</p>{{IMAGE_PLACEHOLDER_0}}<p>y</p>{{IMAGE_PLACEHOLDER_1}}', registry)
    expect(out).toBe(`<p>x</p>${IMG_A}<p>y</p>${IMG_B}`)
  })

  it('tolerates spacing inside the braces', () => {
    expect(restoreImagePlaceholders('{{ IMAGE_PLACEHOLDER_0 }}', registry)).toBe(IMG_A)
  })

  it('tolerates single braces, no braces, and case drift', () => {
    expect(restoreImagePlaceholders('{IMAGE_PLACEHOLDER_1}', registry)).toBe(IMG_B)
    expect(restoreImagePlaceholders('<p>IMAGE_PLACEHOLDER_0</p>', registry)).toBe(`<p>${IMG_A}</p>`)
    expect(restoreImagePlaceholders('{{image_placeholder_0}}', registry)).toBe(IMG_A)
  })

  it('tolerates dash/space separators', () => {
    expect(restoreImagePlaceholders('{{IMAGE-PLACEHOLDER-0}}', registry)).toBe(IMG_A)
    expect(restoreImagePlaceholders('{{IMAGE PLACEHOLDER 1}}', registry)).toBe(IMG_B)
  })

  it('replaces a model-invented img tag wrapping the token', () => {
    const out = restoreImagePlaceholders('<img src="{{IMAGE_PLACEHOLDER_0}}" alt="photo">', registry)
    expect(out).toBe(IMG_A)
  })

  it('distinguishes multi-digit indices', () => {
    const big: ImagePlaceholderEntry[] = Array.from({ length: 11 }, (_, i) => ({
      placeholder: `{{IMAGE_PLACEHOLDER_${i}}}`,
      tag: `<img src="u${i}">`
    }))
    expect(restoreImagePlaceholders('{{IMAGE_PLACEHOLDER_10}}', big)).toBe('<img src="u10">')
  })

  it('strips tokens with an unknown index instead of leaking them', () => {
    expect(restoreImagePlaceholders('<p>a</p>{{IMAGE_PLACEHOLDER_99}}<p>b</p>', registry)).toBe('<p>a</p><p>b</p>')
  })

  it('is safe when the tag contains regex replacement patterns like $&', () => {
    const tricky: ImagePlaceholderEntry[] = [
      { placeholder: '{{IMAGE_PLACEHOLDER_0}}', tag: '<img src="https://x.test/a$&b.png">' }
    ]
    expect(restoreImagePlaceholders('{{IMAGE_PLACEHOLDER_0}}', tricky)).toBe('<img src="https://x.test/a$&b.png">')
  })
})

describe('reinsertMissingImages', () => {
  it('returns the new html untouched when the original has no images', () => {
    const { html, reinserted } = reinsertMissingImages('<p>rewritten</p>', '<p>old</p>')
    expect(html).toBe('<p>rewritten</p>')
    expect(reinserted).toBe(0)
  })

  it('returns the new html byte-for-byte when all images survived', () => {
    const newHtml = `<p>rewritten &amp; polished</p>${IMG_A}`
    const { html, reinserted } = reinsertMissingImages(newHtml, `<p>old</p>${IMG_A}`)
    expect(html).toBe(newHtml)
    expect(reinserted).toBe(0)
  })

  it('re-inserts a dropped image after its surviving anchor paragraph', () => {
    const anchor = 'This exact paragraph survives the rewrite and anchors the image.'
    const original = `<h1>T</h1><p>${anchor}</p>${IMG_A}<p>after</p>`
    const rewritten = `<h1>New Title</h1><p>${anchor}</p><p>totally new after text</p>`
    const { html, reinserted } = reinsertMissingImages(rewritten, original)
    expect(reinserted).toBe(1)
    expect(html).toContain(`<p>${anchor}</p><img src="data:image/png;base64,AAAA" alt="a">`)
  })

  it('falls back to the proportional position when no anchor text survives', () => {
    const original = `<p>a1</p><p>a2</p>${IMG_A}<p>a3</p><p>a4</p>`
    const rewritten = '<p>b1</p><p>b2</p><p>b3</p><p>b4</p>'
    const { html, reinserted } = reinsertMissingImages(rewritten, original)
    expect(reinserted).toBe(1)
    const imgPos = html.indexOf('<img')
    expect(imgPos).toBeGreaterThan(html.indexOf('b2'))
    expect(imgPos).toBeLessThan(html.indexOf('b4'))
  })

  it('prepends an image that led the original document', () => {
    const original = `${IMG_A}<p>intro</p>`
    const { html, reinserted } = reinsertMissingImages('<p>fresh intro</p>', original)
    expect(reinserted).toBe(1)
    expect(html.startsWith('<img')).toBe(true)
  })

  it('re-inserts an image nested inside a paragraph in the original', () => {
    const anchor = 'A stable anchor paragraph with enough text to match on.'
    const original = `<p>${anchor}</p><p>caption ${IMG_B} text</p>`
    const rewritten = `<p>${anchor}</p><p>new prose</p>`
    const { html, reinserted } = reinsertMissingImages(rewritten, original)
    expect(reinserted).toBe(1)
    expect(html).toContain('src="data:image/jpeg;base64,BBBB"')
  })

  it('handles multiple dropped images, keeping document order plausible', () => {
    const original = `<p>alpha one</p>${IMG_A}<p>beta two</p>${IMG_B}`
    const rewritten = '<p>alpha one</p><p>beta two</p>'
    const { html, reinserted } = reinsertMissingImages(rewritten, original)
    expect(reinserted).toBe(2)
    expect(html.indexOf('AAAA')).toBeLessThan(html.indexOf('BBBB'))
    expect(html.indexOf('alpha one')).toBeLessThan(html.indexOf('AAAA'))
    expect(html.indexOf('beta two')).toBeLessThan(html.indexOf('BBBB'))
  })

  it('does not duplicate an image the rewrite kept while restoring one it dropped', () => {
    const original = `<p>keep me around</p>${IMG_A}<p>second part</p>${IMG_B}`
    const rewritten = `<p>keep me around</p>${IMG_A}<p>second part</p>`
    const { html, reinserted } = reinsertMissingImages(rewritten, original)
    expect(reinserted).toBe(1)
    expect(html.match(/AAAA/g)).toHaveLength(1)
    expect(html.match(/BBBB/g)).toHaveLength(1)
  })

  it('appends to an empty rewrite instead of dropping the image', () => {
    const { html, reinserted } = reinsertMissingImages('', `<p>text</p>${IMG_A}`)
    expect(reinserted).toBe(1)
    expect(html).toContain('AAAA')
  })
})
