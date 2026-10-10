/**
 * The book's reference files and the server's browser
 * (docs/features/attachments_and_web.md; scripts/server_attachments.py,
 * scripts/server_web.py).
 *
 * An attachment's text is fetched only when a tool reads it, and kept per
 * tab: a novel of a few MB costs one request, not one per read. It never
 * enters the conversation whole — the tools render bounded parts of it.
 */
import { useAppStore } from '../store/useAppStore'
import { CLIENT_ID, CLIENT_ID_HEADER } from '../store/documentSync'
import { attachmentParagraphs, type AttachmentMeta } from '../utils/attachments'
import type { WebPage, WebSearchResult } from '../utils/webText'

function headers(json = true): Record<string, string> {
  return {
    ...(json ? { 'Content-Type': 'application/json' } : {}),
    'X-CSRF-Token': useAppStore.getState().csrfToken || '',
    [CLIENT_ID_HEADER]: CLIENT_ID
  }
}

async function expectOk(res: Response, what: string): Promise<Record<string, unknown>> {
  const body = await res.json().catch(() => ({})) as Record<string, unknown>
  if (!res.ok) throw new Error(typeof body.detail === 'string' ? body.detail : `${what} failed (${res.status})`)
  return body
}

const base = (bookId: string) => `/api/books/${encodeURIComponent(bookId)}/attachments`

export async function listAttachments(bookId: string, fetchFn: typeof fetch = fetch): Promise<AttachmentMeta[]> {
  const body = await expectOk(await fetchFn(base(bookId)), 'Listing attachments')
  return Array.isArray(body.attachments) ? body.attachments as AttachmentMeta[] : []
}

export async function uploadAttachment(bookId: string, file: File, fetchFn: typeof fetch = fetch): Promise<AttachmentMeta> {
  const res = await fetchFn(`${base(bookId)}?name=${encodeURIComponent(file.name)}`, {
    method: 'POST',
    headers: { ...headers(false), 'Content-Type': 'application/octet-stream' },
    body: file
  })
  const body = await expectOk(res, 'Uploading the attachment')
  return body.attachment as AttachmentMeta
}

export async function deleteAttachment(bookId: string, id: string, fetchFn: typeof fetch = fetch): Promise<void> {
  await expectOk(await fetchFn(`${base(bookId)}/${encodeURIComponent(id)}`, { method: 'DELETE', headers: headers() }), 'Deleting the attachment')
  paragraphCache.delete(`${bookId}/${id}`)
}

/** Paragraphs per attachment, split exactly as the server counted them (parity: wc_text/attachments). */
const paragraphCache = new Map<string, Promise<string[]>>()

export function attachmentParagraphsOf(bookId: string, id: string, fetchFn: typeof fetch = fetch): Promise<string[]> {
  const key = `${bookId}/${id}`
  let hit = paragraphCache.get(key)
  if (!hit) {
    hit = (async () => {
      const body = await expectOk(await fetchFn(`${base(bookId)}/${encodeURIComponent(id)}/text`), 'Reading the attachment')
      return attachmentParagraphs(typeof body.text === 'string' ? body.text : '')
    })()
    // A failed fetch is not remembered: the next read tries again.
    hit.catch(() => paragraphCache.delete(key))
    paragraphCache.set(key, hit)
    // A handful of novels at most; drop the oldest beyond that.
    while (paragraphCache.size > 4) paragraphCache.delete(paragraphCache.keys().next().value as string)
  }
  return hit
}

export async function webSearch(query: string, maxResults: number, fetchFn: typeof fetch = fetch): Promise<WebSearchResult[]> {
  const res = await fetchFn('/api/web/search', { method: 'POST', headers: headers(), body: JSON.stringify({ query, max_results: maxResults }) })
  const body = await expectOk(res, 'The web search')
  return Array.isArray(body.results) ? body.results as WebSearchResult[] : []
}

export async function webRead(url: string, fetchFn: typeof fetch = fetch): Promise<WebPage> {
  const res = await fetchFn('/api/web/read', { method: 'POST', headers: headers(), body: JSON.stringify({ url }) })
  const body = await expectOk(res, 'Reading the page')
  return body.page as WebPage
}

/** Whether the server has a browser at all (Playwright installed). */
export async function webAvailable(fetchFn: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await fetchFn('/api/web/status')
    if (!res.ok) return false
    return Boolean(((await res.json()) as { available?: unknown }).available)
  } catch {
    return false
  }
}
