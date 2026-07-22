/**
 * Image preservation across LLM document rewrites.
 *
 * Base64 `<img>` tags are huge and un-reproducible by the model, so before a
 * document is sent as context every image tag is swapped for a small token
 * (`{{IMAGE_PLACEHOLDER_N}}`) and swapped back when the response is applied.
 * The model is instructed to copy these tokens verbatim, but it routinely
 * drops or mangles them during full `<canvas>` rewrites — so restoration is
 * tolerant of formatting drift, and `reinsertMissingImages` is the safety net
 * that puts any still-missing image back near its original position instead
 * of silently losing it.
 */

/** One registered image: the token sent to the LLM and the original tag. */
export interface ImagePlaceholderEntry {
  placeholder: string
  tag: string
}

/**
 * Replace every `<img …>` tag in `html` with a `{{IMAGE_PLACEHOLDER_N}}`
 * token, registering new tags in `registry` (mutated). The same tag always
 * maps to the same token, so repeated calls within one request (active doc +
 * selection + lookup retries) stay consistent.
 */
export function replaceImagesWithPlaceholders(
  html: string,
  registry: ImagePlaceholderEntry[]
): string {
  let replacedHtml = html
  const matches = html.match(/<img[^>]+>/g)
  if (matches) {
    matches.forEach((match) => {
      let existing = registry.find(item => item.tag === match)
      if (!existing) {
        existing = { placeholder: `{{IMAGE_PLACEHOLDER_${registry.length}}}`, tag: match }
        registry.push(existing)
      }
      replacedHtml = replacedHtml.replace(match, existing.placeholder)
    })
  }
  return replacedHtml
}

// The model was shown `{{IMAGE_PLACEHOLDER_N}}` but frequently reformats it:
// spaces inside braces, fewer/more braces, different separators, lowercase.
// Match all of those; the numeric index is what identifies the image.
const PLACEHOLDER_TOKEN_RE = /\{{0,3}\s*IMAGE[_\s-]?PLACEHOLDER[_\s-]?(\d+)\s*\}{0,3}/gi

// The model sometimes "helpfully" converts the token back into an img tag,
// e.g. <img src="{{IMAGE_PLACEHOLDER_0}}" alt="...">. Replace the whole tag
// so restoration doesn't nest an <img> inside an attribute value.
const PLACEHOLDER_IMG_TAG_RE = /<img\b[^>]*?IMAGE[_\s-]?PLACEHOLDER[_\s-]?(\d+)[^>]*>/gi

/**
 * Restore original `<img>` tags for every placeholder token in `html`.
 * Tolerates the model reformatting the token (spacing, brace count, case,
 * separator) or wrapping it in an `<img>` tag of its own. Tokens with an
 * index that was never registered are stripped rather than leaked into the
 * document.
 */
export function restoreImagePlaceholders(
  html: string,
  registry: ImagePlaceholderEntry[]
): string {
  const lookup = (index: string) => registry[Number(index)]?.tag ?? ''
  return html
    .replace(PLACEHOLDER_IMG_TAG_RE, (_m, index: string) => lookup(index))
    .replace(PLACEHOLDER_TOKEN_RE, (_m, index: string) => lookup(index))
}

const normalizeText = (s: string | null | undefined) => (s || '').replace(/\s+/g, ' ').trim()

/** Result of the post-rewrite image safety net. */
export interface ReinsertResult {
  html: string
  /** How many images from the original were missing and re-inserted. */
  reinserted: number
}

/**
 * Safety net for full-document rewrites: any image (identified by `src`)
 * present in `originalHtml` but absent from `newHtml` is re-inserted.
 *
 * Placement heuristics, in order:
 * 1. After the block whose text matches the block that preceded the image in
 *    the original (survives restructuring that keeps surrounding prose).
 * 2. At the original's proportional position in the new block list (survives
 *    rewrites that change all the prose).
 * 3. Appended at the end.
 */
export function reinsertMissingImages(newHtml: string, originalHtml: string): ReinsertResult {
  const parser = new DOMParser()
  const origBody = parser.parseFromString(originalHtml, 'text/html').body
  const origImgs = Array.from(origBody.querySelectorAll('img'))
  if (origImgs.length === 0) return { html: newHtml, reinserted: 0 }

  const newDoc = parser.parseFromString(newHtml, 'text/html')
  const newBody = newDoc.body
  const presentSrcs = new Set(
    Array.from(newBody.querySelectorAll('img')).map(img => img.getAttribute('src') || '')
  )

  const origBlocks = Array.from(origBody.children)
  let reinserted = 0

  for (const img of origImgs) {
    const src = img.getAttribute('src') || ''
    if (!src || presentSrcs.has(src)) continue

    // Locate the top-level block containing (or being) the image.
    let block: Element | null = img
    while (block && block.parentElement && block.parentElement !== origBody) {
      block = block.parentElement
    }
    const blockIdx = block ? origBlocks.indexOf(block) : -1

    // Anchor on the nearest preceding block that has text.
    let anchorText = ''
    for (let i = blockIdx - 1; i >= 0; i--) {
      const t = normalizeText(origBlocks[i].textContent)
      if (t) {
        anchorText = t
        break
      }
    }

    const clone = newDoc.importNode(img, true)
    let placed = false

    if (anchorText) {
      // Long anchors keep only the tail — endings drift less than openings
      // when a paragraph is lightly edited.
      const anchorKey = anchorText.slice(-80)
      for (const nb of Array.from(newBody.children)) {
        if (normalizeText(nb.textContent).includes(anchorKey)) {
          nb.after(clone)
          placed = true
          break
        }
      }
    }

    if (!placed && blockIdx >= 0) {
      const newBlocks = Array.from(newBody.children)
      if (blockIdx === 0 || newBlocks.length === 0) {
        newBody.prepend(clone)
      } else {
        const at = Math.min(
          newBlocks.length - 1,
          Math.round((blockIdx / origBlocks.length) * newBlocks.length)
        )
        newBlocks[at].after(clone)
      }
      placed = true
    }

    if (!placed) newBody.appendChild(clone)
    presentSrcs.add(src)
    reinserted++
  }

  // Avoid a DOMParser round-trip (which normalizes entities/attributes) when
  // nothing was re-inserted — keep the model's HTML byte-for-byte.
  return reinserted > 0 ? { html: newBody.innerHTML, reinserted } : { html: newHtml, reinserted: 0 }
}
