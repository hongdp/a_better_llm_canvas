import type { ProviderConfig } from '../store/useAppStore'

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface StreamCallbacks {
  onChunk: (chunk: string) => void
  onDone: (fullText: string) => void
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
  config: ProviderConfig & { provider: string; debug?: boolean },
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
    onDone: (fullText: string) => {
      if (debug) {
        console.log('[DEBUG] LLM Stream Completed. Full Response Text:', fullText)
      }
      callbacks.onDone(fullText)
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

    if (provider === 'openai' || provider === 'ollama') {
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
  config: ProviderConfig & { debug?: boolean },
  callbacks: StreamCallbacks
): Promise<void> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }

  if (config.apiKey && config.apiKey !== 'ollama-no-key') {
    headers['Authorization'] = `Bearer ${config.apiKey}`
  }

  const url = `${config.baseUrl}/chat/completions`
  const body = {
    model: config.model,
    messages: messages,
    stream: true,
  }

  if (config.debug) {
    console.log('[DEBUG] Outgoing OpenAI Request:', maskRequestDetails(url, headers, body))
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
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
  }, callbacks)
}

/**
 * Google Gemini stream handler
 */
async function streamGemini(
  messages: LLMMessage[],
  config: ProviderConfig & { debug?: boolean },
  callbacks: StreamCallbacks
): Promise<void> {
  const systemMessage = messages.find((m) => m.role === 'system')
  const contents = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }))

  const body: Record<string, any> = {
    contents,
  }

  if (systemMessage) {
    body['systemInstruction'] = {
      parts: [{ text: systemMessage.content }],
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

  try {
    while (true) {
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
                const text = chunkJson.candidates?.[0]?.content?.parts?.[0]?.text
                if (text) {
                  callbacks.onChunk(text)
                  fullText += text
                }
              } catch (e) {
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

    callbacks.onDone(fullText)
  } catch (error) {
    callbacks.onError(error instanceof Error ? error : new Error(String(error)))
  }
}

/**
 * Anthropic Claude stream handler
 */
async function streamAnthropic(
  messages: LLMMessage[],
  config: ProviderConfig & { debug?: boolean },
  callbacks: StreamCallbacks
): Promise<void> {
  const systemMessage = messages.find((m) => m.role === 'system')
  const body: Record<string, any> = {
    model: config.model,
    messages: messages.filter((m) => m.role !== 'system'),
    max_tokens: 4096,
    stream: true,
  }

  if (systemMessage) {
    body['system'] = systemMessage.content
  }

  const url = `${config.baseUrl}/messages`
  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': config.apiKey,
    'anthropic-version': '2023-06-01',
  }

  if (config.debug) {
    console.log('[DEBUG] Outgoing Anthropic Request:', maskRequestDetails(url, headers, body))
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
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
  }, callbacks)
}

/**
 * Helper to read Server-Sent Events streams
 */
async function readSSEStream(
  response: Response,
  onData: (data: string, event?: string) => void,
  callbacks: StreamCallbacks
): Promise<void> {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Response body is not readable')

  const decoder = new TextDecoder()
  let buffer = ''
  let fullText = ''
  let currentEvent = ''

  try {
    while (true) {
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
          
          // Try to append delta content to fullText for callbacks.onDone
          try {
            const parsed = JSON.parse(dataContent)
            const text = parsed.choices?.[0]?.delta?.content || parsed.delta?.text || ''
            fullText += text
          } catch (e) {
            // Not all data payloads are standard delta jsons
          }
        }
      }
    }

    // Process any remaining buffer content
    if (buffer && buffer.startsWith('data:')) {
      const dataContent = buffer.slice(5).trim()
      onData(dataContent, currentEvent)
    }

    callbacks.onDone(fullText)
  } catch (error) {
    callbacks.onError(error instanceof Error ? error : new Error(String(error)))
  }
}
