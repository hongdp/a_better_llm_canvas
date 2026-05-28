import type { ProviderConfig } from '../store/useAppStore'

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
  images?: string[] // base64 Data URLs
}

export interface StreamCallbacks {
  onChunk: (chunk: string) => void
  onDone: (fullText: string, usage?: { promptTokens: number; completionTokens: number; cachedPromptTokens?: number }) => void
  onError: (error: Error) => void
}

/**
 * Mask sensitive credentials inside requests for safe debug logging.
 */
function maskRequestDetails(url: string, headers: Record<string, string>, body: any) {
  const maskedHeaders = { ...headers }
  if (maskedHeaders['Authorization']) {
    maskedHeaders['Authorization'] = 'Bearer ***'
  }
  if (maskedHeaders['x-api-key']) {
    maskedHeaders['x-api-key'] = '***'
  }
  const maskedUrl = url.replace(/key=[^&]+/, 'key=***')
  return {
    url: maskedUrl,
    headers: maskedHeaders,
    body: typeof body === 'string' ? JSON.parse(body) : body
  }
}

/**
 * Normalizes messages and streams responses from the configured LLM provider.
 */
export async function streamLLM(
  messages: LLMMessage[],
  config: ProviderConfig & { provider: string; debug?: boolean; signal?: AbortSignal },
  callbacks: StreamCallbacks
): Promise<void> {
  const { provider, apiKey, debug } = config

  const debugCallbacks: StreamCallbacks = {
    onChunk: (chunk: string) => {
      if (debug) {
        console.log('[DEBUG] Incoming LLM Chunk:', chunk)
      }
      callbacks.onChunk(chunk)
    },
    onDone: (fullText: string, usage?: { promptTokens: number; completionTokens: number; cachedPromptTokens?: number }) => {
      if (debug) {
        console.log('[DEBUG] LLM Stream Completed. Full Response Text:', fullText, 'Usage:', usage)
      }
      callbacks.onDone(fullText, usage)
    },
    onError: (err: Error) => {
      if (debug) {
        console.error('[DEBUG] LLM Stream Error:', err)
      }
      callbacks.onError(err)
    }
  }

  try {
    if (!apiKey && provider !== 'ollama') {
      throw new Error(`API key is missing for ${provider}. Please configure it in Settings.`)
    }

    if (provider === 'openai' || provider === 'ollama' || provider === 'grok') {
      await streamOpenAI(messages, config, debugCallbacks)
    } else if (provider === 'gemini') {
      await streamGemini(messages, config, debugCallbacks)
    } else if (provider === 'anthropic') {
      await streamAnthropic(messages, config, debugCallbacks)
    } else {
      throw new Error(`Unsupported LLM provider: ${provider}`)
    }
  } catch (error: any) {
    callbacks.onError(error instanceof Error ? error : new Error(error.message || 'Unknown network error'))
  }
}

/**
 * OpenAI / Ollama compatible stream handler
 */
async function streamOpenAI(
  messages: LLMMessage[],
  config: ProviderConfig & { provider?: string; debug?: boolean; signal?: AbortSignal },
  callbacks: StreamCallbacks
): Promise<void> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }

  if (config.apiKey && config.apiKey !== 'ollama-no-key') {
    headers['Authorization'] = `Bearer ${config.apiKey}`
  }

  const url = `${config.baseUrl}/chat/completions`
  const openAIMessages = messages.map(m => {
    if (m.images && m.images.length > 0) {
      const contentParts: any[] = [
        {
          type: 'text',
          text: m.content
        }
      ]
      m.images.forEach((img, idx) => {
        contentParts.push({
          type: 'text',
          text: `\n[Image ${idx + 1}]:`
        })
        contentParts.push({
          type: 'image_url',
          image_url: {
            url: img
          }
        })
      })
      return {
        role: m.role,
        content: contentParts
      }
    }
    return {
      role: m.role,
      content: m.content
    }
  })

  const body: Record<string, any> = {
    model: config.model,
    messages: openAIMessages,
    stream: true,
  }

  if (config.maxOutputTokens) {
    body['max_tokens'] = config.maxOutputTokens
  }

  // Check if Ollama by checking baseUrl or apiKey
  const isOllama = config.apiKey === 'ollama-no-key' || config.baseUrl.includes('localhost') || config.baseUrl.includes('127.0.0.1');
  const isGrok = config.provider === 'grok' || config.baseUrl.includes('x.ai');
  if (!isOllama && !isGrok) {
    body['stream_options'] = { include_usage: true }
  }

  if (config.debug) {
    console.log('[DEBUG] Outgoing OpenAI Request:', maskRequestDetails(url, headers, body))
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: config.signal,
  })

  if (!response.ok) {
    const errText = await response.text()
    throw new Error(`OpenAI API error (${response.status}): ${errText || response.statusText}`)
  }

  await readSSEStream(response, (dataString) => {
    if (dataString === '[DONE]') return
    try {
      const json = JSON.parse(dataString)
      const content = json.choices?.[0]?.delta?.content
      if (content) {
        callbacks.onChunk(content)
      }
    } catch (e) {
      console.warn('Failed to parse OpenAI SSE chunk', e, dataString)
    }
  }, callbacks, config.signal)
}

/**
 * Google Gemini stream handler
 */
async function streamGemini(
  messages: LLMMessage[],
  config: ProviderConfig & { debug?: boolean; signal?: AbortSignal },
  callbacks: StreamCallbacks
): Promise<void> {
  const systemMessage = messages.find((m) => m.role === 'system')
  const contents = messages
    .filter((m) => m.role !== 'system')
    .map((m) => {
      const parts: any[] = [{ text: m.content }]
      if (m.images && m.images.length > 0) {
        m.images.forEach((img, idx) => {
          const match = img.match(/^data:(image\/[a-zA-Z+.-]+);base64,(.+)$/)
          if (match) {
            parts.push({ text: `\n[Image ${idx + 1}]:` })
            parts.push({
              inlineData: {
                mimeType: match[1],
                data: match[2]
              }
            })
          }
        })
      }
      return {
        role: m.role === 'assistant' ? 'model' : 'user',
        parts,
      }
    })

  const body: Record<string, any> = {
    contents,
  }

  if (systemMessage) {
    body['systemInstruction'] = {
      parts: [{ text: systemMessage.content }],
    }
  }

  if (config.geminiSafetySettings && config.geminiSafetySettings.length > 0) {
    body['safetySettings'] = config.geminiSafetySettings
  }

  if (config.maxOutputTokens) {
    body['generationConfig'] = {
      maxOutputTokens: config.maxOutputTokens
    }
  }

  // Gemini uses streamGenerateContent for streaming. Support model names with or without 'models/' prefix.
  const modelName = config.model.startsWith('models/') ? config.model.slice(7) : config.model
  const url = `${config.baseUrl}/models/${modelName}:streamGenerateContent?key=${config.apiKey}`
  
  if (config.debug) {
    console.log('[DEBUG] Outgoing Gemini Request:', maskRequestDetails(url, { 'Content-Type': 'application/json' }, body))
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: config.signal,
  })

  if (!response.ok) {
    const errText = await response.text()
    throw new Error(`Gemini API error (${response.status}): ${errText || response.statusText}`)
  }

  const reader = response.body?.getReader()
  if (!reader) throw new Error('Response body is not readable')

  const decoder = new TextDecoder()
  let buffer = ''
  let fullText = ''

  let usage: { promptTokens: number; completionTokens: number; cachedPromptTokens?: number } | undefined

  try {
    while (true) {
      if (config.signal?.aborted) {
        throw new Error('Stream aborted by user')
      }
      const { value, done } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      
      // Gemini streams JSON chunks. In streamGenerateContent, the server returns 
      // an array of JSON objects or individual JSON objects separated by newlines/commas.
      // A simple regex approach to find text snippets is extremely robust for streaming.
      // Alternatively, we parse JSON fragments.
      // Let's attempt to parse the buffer as it grows or parse valid json blocks.
      
      // Let's clean the buffer to find candidates.
      // For Gemini, each stream packet is a JSON array item.
      // Let's try parsing the block if it's a valid JSON fragment.
      // Since it's a stream, we can check for closed JSON objects { ... }
      let braceCount = 0
      let inString = false
      let startIdx = -1

      for (let i = 0; i < buffer.length; i++) {
        const char = buffer[i]
        if (char === '"' && buffer[i - 1] !== '\\') {
          inString = !inString
        }
        if (!inString) {
          if (char === '{') {
            if (braceCount === 0) startIdx = i
            braceCount++
          } else if (char === '}') {
            braceCount--
            if (braceCount === 0 && startIdx !== -1) {
              const jsonStr = buffer.substring(startIdx, i + 1)
              try {
                const chunkJson = JSON.parse(jsonStr)

                // Detect prompt-level safety blocks (e.g. prohibited content)
                if (chunkJson.promptFeedback?.blockReason) {
                  throw new Error(`Content generation blocked by safety policy: ${chunkJson.promptFeedback.blockReason}`)
                }

                if (chunkJson.usageMetadata) {
                  const meta = chunkJson.usageMetadata
                  usage = {
                    promptTokens: meta.promptTokenCount || 0,
                    completionTokens: meta.candidatesTokenCount || 0,
                    cachedPromptTokens: meta.cachedContentTokenCount || 0
                  }
                }

                const candidate = chunkJson.candidates?.[0]
                if (candidate) {
                  // Detect response-level safety blocks or abnormal termination (e.g. SAFETY, RECITATION)
                  if (candidate.finishReason && !['STOP', 'MAX_TOKENS'].includes(candidate.finishReason)) {
                    throw new Error(`Content generation blocked or terminated abnormally: ${candidate.finishReason}`)
                  }

                  const text = candidate.content?.parts?.[0]?.text
                  if (text) {
                    callbacks.onChunk(text)
                    fullText += text
                  }
                }
              } catch (e) {
                // Propagate safety blocks and custom API errors to trigger onError
                if (e instanceof Error && (e.message.includes('blocked') || e.message.includes('terminated'))) {
                  throw e
                }
                // Ignore incomplete parse errors
              }
              // Advance buffer
              buffer = buffer.substring(i + 1)
              i = -1 // Reset index loop
              startIdx = -1
            }
          }
        }
      }
    }

    callbacks.onDone(fullText, usage)
  } catch (error) {
    callbacks.onError(error instanceof Error ? error : new Error(String(error)))
  }
}

/**
 * Anthropic Claude stream handler
 */
async function streamAnthropic(
  messages: LLMMessage[],
  config: ProviderConfig & { debug?: boolean; signal?: AbortSignal },
  callbacks: StreamCallbacks
): Promise<void> {
  const systemMessage = messages.find((m) => m.role === 'system')
  const anthropicMessages = messages
    .filter((m) => m.role !== 'system')
    .map(m => {
      if (m.images && m.images.length > 0) {
        const content: any[] = [
          {
            type: 'text',
            text: m.content
          }
        ]
        m.images.forEach((img, idx) => {
          const match = img.match(/^data:(image\/[a-zA-Z+.-]+);base64,(.+)$/)
          if (match) {
            content.push({
              type: 'text',
              text: `\n[Image ${idx + 1}]:`
            })
            content.push({
              type: 'image',
              source: {
                type: 'base64',
                media_type: match[1],
                data: match[2]
              }
            })
          }
        })
        return {
          role: m.role,
          content
        }
      }
      return {
        role: m.role,
        content: m.content
      }
    })

  const body: Record<string, any> = {
    model: config.model,
    messages: anthropicMessages,
    max_tokens: Math.min(config.maxOutputTokens || 8192, 8192),
    stream: true,
  }

  // Use structured system prompt with cache_control for Anthropic prompt caching
  if (systemMessage) {
    body['system'] = [
      {
        type: 'text',
        text: systemMessage.content,
        cache_control: { type: 'ephemeral' }
      }
    ]
  }

  // Mark the first user message (dynamic document context) for caching too,
  // as it often stays the same across a few consecutive requests
  if (anthropicMessages.length > 0 && typeof anthropicMessages[0].content === 'string') {
    anthropicMessages[0] = {
      ...anthropicMessages[0],
      content: [
        {
          type: 'text',
          text: anthropicMessages[0].content,
          cache_control: { type: 'ephemeral' }
        }
      ]
    }
  }

  const url = `${config.baseUrl}/messages`
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-api-key': config.apiKey,
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'prompt-caching-2024-07-31',
  }

  if (config.debug) {
    console.log('[DEBUG] Outgoing Anthropic Request:', maskRequestDetails(url, headers, body))
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: config.signal,
  })

  if (!response.ok) {
    const errText = await response.text()
    throw new Error(`Anthropic API error (${response.status}): ${errText || response.statusText}`)
  }

  await readSSEStream(response, (dataString) => {
    try {
      const json = JSON.parse(dataString)
      if (json.type === 'content_block_delta' && json.delta?.text) {
        callbacks.onChunk(json.delta.text)
      } else if (json.type === 'message_delta' && json.delta?.text) {
        callbacks.onChunk(json.delta.text)
      }
    } catch (e) {
      // Ignore parse errors on structural messages
    }
  }, callbacks, config.signal)
}

/**
 * Helper to read Server-Sent Events streams
 */
async function readSSEStream(
  response: Response,
  onData: (data: string, event?: string) => void,
  callbacks: StreamCallbacks,
  signal?: AbortSignal
): Promise<void> {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Response body is not readable')

  const decoder = new TextDecoder()
  let buffer = ''
  let fullText = ''
  let currentEvent = ''

  let usage: { promptTokens: number; completionTokens: number; cachedPromptTokens?: number } | undefined = undefined
  let anthropicInputTokens = 0
  let anthropicOutputTokens = 0
  let anthropicCachedPromptTokens = 0

  const processDataLine = (dataContent: string) => {
    try {
      const parsed = JSON.parse(dataContent)
      const text = parsed.choices?.[0]?.delta?.content || parsed.delta?.text || ''
      fullText += text

      // Parse OpenAI usage
      if (parsed.usage) {
        usage = {
          promptTokens: parsed.usage.prompt_tokens || 0,
          completionTokens: parsed.usage.completion_tokens || 0,
          cachedPromptTokens: parsed.usage.prompt_tokens_details?.cached_tokens || 0
        }
      }
      
      // Parse Anthropic usage
      if (parsed.type === 'message_start' && parsed.message?.usage) {
        const u = parsed.message.usage
        anthropicInputTokens = u.input_tokens || 0
        anthropicOutputTokens += u.output_tokens || 0
        anthropicCachedPromptTokens = u.cache_read_input_tokens || 0
      } else if (parsed.type === 'message_delta' && parsed.usage) {
        const u = parsed.usage
        anthropicOutputTokens += u.output_tokens || 0
      }
    } catch (e) {
      // Not all data payloads are standard delta jsons
    }
  }

  try {
    while (true) {
      if (signal?.aborted) {
        throw new Error('Stream aborted by user')
      }
      const { value, done } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      
      // Keep the last incomplete line in the buffer
      buffer = lines.pop() || ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue

        if (trimmed.startsWith('event:')) {
          currentEvent = trimmed.slice(6).trim()
        } else if (trimmed.startsWith('data:')) {
          const dataContent = trimmed.slice(5).trim()
          onData(dataContent, currentEvent)
          processDataLine(dataContent)
        }
      }
    }

    // Process any remaining buffer content
    if (buffer && buffer.startsWith('data:')) {
      const dataContent = buffer.slice(5).trim()
      onData(dataContent, currentEvent)
      processDataLine(dataContent)
    }

    if (anthropicInputTokens > 0 || anthropicOutputTokens > 0) {
      usage = {
        promptTokens: anthropicInputTokens,
        completionTokens: anthropicOutputTokens,
        cachedPromptTokens: anthropicCachedPromptTokens
      }
    }

    callbacks.onDone(fullText, usage)
  } catch (error) {
    callbacks.onError(error instanceof Error ? error : new Error(String(error)))
  }
}
