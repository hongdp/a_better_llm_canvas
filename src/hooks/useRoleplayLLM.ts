import { useState, useRef, useCallback } from 'react'
import { useAppStore } from '../store/useAppStore'
import { streamLLM, type LLMMessage } from '../services/llm'
import { getTimestampId } from '../utils/text'
import type { ChatMessage, RoleplayConfig } from '../types/chat'

interface UseRoleplayLLMProps {
  uploadedImages: string[]
  setUploadedImages: (images: string[]) => void
  layoutMode: string
  setIsChatExpanded: (expanded: boolean) => void
}

/**
 * Build the Game Master system prompt for roleplay mode.
 */
function buildRoleplaySystemPrompt(config: RoleplayConfig): LLMMessage {
  // For custom genre, use the user's game setting description as the primary context
  const settingBlock = config.genre === 'Custom' && config.customWorldDesc
    ? `SETTING: Custom game world defined by the player\n\nCUSTOM GAME SETTING (follow this faithfully):\n${config.customWorldDesc}`
    : `SETTING: ${config.genre} world${config.customWorldDesc ? `\n\nADDITIONAL WORLD CONTEXT:\n${config.customWorldDesc}` : ''}`

  // Build genre-appropriate stat suggestions
  const statSuggestions = config.genre === 'Custom'
    ? `Since this is a custom game, YOU must decide what stats to track based on the player's setting description above. Pick 4-7 fields that make sense for their game (e.g. for a romance game: Affection levels, Mood, Time; for a detective game: Clues, Reputation, Suspects; for a survival game: Health, Hunger, Supplies). Once you choose the fields in your first response, keep tracking those same fields consistently.`
    : config.genre === 'Horror'
    ? `Track: Sanity, Health, Items, Location, Fear Level, Clues Found`
    : config.genre === 'Mystery'
    ? `Track: Clues, Suspects, Reputation, Location, Case Progress, Key Evidence`
    : `Choose 4-7 fields appropriate to the genre. Examples:\n   - Fantasy/Action RPG → HP, Inventory, Gold, Location, Active Quest, Status Effects\n   - Romance/Gal Game → Affection Levels (per character), Mood, Location, Time/Day, Relationship Status, Events Unlocked\n   - Sci-Fi → Energy, Credits, Equipment, Location, Mission, Ship Status\n   - Horror → Sanity, Health, Items, Location, Fear Level, Clues Found\n   - Mystery/Detective → Clues, Suspects, Reputation, Location, Case Progress, Key Evidence`

  return {
    role: 'system',
    content: `You are an expert Game Master (GM) for an interactive text-based roleplay game.

${settingBlock}
DIFFICULTY: ${config.difficulty}
PLAYER CHARACTER: ${config.characterName}

GAME RULES:
1. You narrate the story, describe environments, control NPCs, and manage encounters.
2. The player tells you their actions, and you describe the outcomes.
3. Difficulty levels:
   - Easy: Be forgiving, provide hints, allow creative solutions, and be generous with positive outcomes.
   - Normal: Balanced challenge, fair consequences, reasonable difficulty.
   - Hard: Punishing consequences, high stakes, limited resources, permanent consequences possible.
4. ${statSuggestions}

OUTPUT FORMAT:

CRITICAL — Your EVERY response MUST follow this structure:
1. First, write your narration as plain text (vivid, immersive prose).
2. Then, ALWAYS include a <game_state>...</game_state> block at the END of your response. This is MANDATORY in EVERY reply, even if no values changed. The game state block updates a separate tracking document.
3. Optionally, include a <choices>...</choices> block when there are clear branching paths.

Game state format — use exactly this HTML structure inside the tags:
<game_state>
<h2>Game State</h2>
<p><strong>Character:</strong> ${config.characterName}</p>
<p><strong>Location:</strong> value here</p>
<p><strong>StatName:</strong> value here</p>
</game_state>

(Use <p><strong>Label:</strong> value</p> for each tracked field. Always include ALL fields, even unchanged ones.)

Choices format (optional, only when offering branching paths):
<choices>Option A|Option B|Option C</choices>

Other rules:
- NEVER use <canvas> or <selection_replace> tags. All story content goes to chat.
- Do NOT prefix your narration with any name or role label.
- End each narration with a sense of anticipation or a question to prompt action.
- Do NOT wrap your XML tags in markdown code blocks or backticks. Output them as raw XML.`
  }
}

/**
 * Strip all HTML tags from a string, returning plain text.
 */
function stripHtmlTags(html: string): string {
  return html.replace(/<[^>]*>?/gm, '')
}

/**
 * Parse roleplay-specific XML tags from raw streamed text.
 * Returns the narration text (everything outside special tags) and any
 * extracted game_state, story_lore, and choices content.
 */
function parseRoleplayTags(raw: string): {
  narration: string
  gameState: string | null
  storyLore: string | null
  choices: string[] | null
} {
  let narration = raw
  let gameState: string | null = null
  let storyLore: string | null = null
  let choices: string[] | null = null

  // Extract <story_lore>...</story_lore>
  const storyLoreMatch = narration.match(/<story_lore>([\s\S]*?)<\/story_lore>/)
  if (storyLoreMatch) {
    storyLore = storyLoreMatch[1].trim()
    narration = narration.replace(storyLoreMatch[0], '')
  }

  // Extract <game_state>...</game_state>
  const gameStateMatch = narration.match(/<game_state>([\s\S]*?)<\/game_state>/)
  if (gameStateMatch) {
    gameState = gameStateMatch[1].trim()
    narration = narration.replace(gameStateMatch[0], '')
  }

  // Extract <choices>...</choices>
  const choicesMatch = narration.match(/<choices>([\s\S]*?)<\/choices>/)
  if (choicesMatch) {
    choices = choicesMatch[1]
      .split('|')
      .map(c => c.trim())
      .filter(Boolean)
    narration = narration.replace(choicesMatch[0], '')
  }

  return {
    narration: narration.trim(),
    gameState,
    storyLore,
    choices
  }
}

/**
 * Check if a tag is still being streamed (opened but not yet closed).
 * Returns the tag name if we're mid-stream inside a tag, or null.
 */
function getIncompleteTag(raw: string): string | null {
  const tags = ['story_lore', 'game_state', 'choices']
  for (const tag of tags) {
    const openIdx = raw.lastIndexOf(`<${tag}>`)
    if (openIdx !== -1) {
      const closeIdx = raw.indexOf(`</${tag}>`, openIdx)
      if (closeIdx === -1) {
        return tag
      }
    }
  }
  return null
}

/**
 * Strip any incomplete XML tag content from the end of streamed text
 * so it doesn't leak into the chat narration during streaming.
 */
function stripIncompleteRpTag(raw: string): string {
  const tags = ['story_lore', 'game_state', 'choices']
  for (const tag of tags) {
    const openIdx = raw.lastIndexOf(`<${tag}>`)
    if (openIdx !== -1) {
      const closeIdx = raw.indexOf(`</${tag}>`, openIdx)
      if (closeIdx === -1) {
        // Tag is still being streamed — strip from the open tag onward
        return raw.substring(0, openIdx).trim()
      }
    }
  }

  // Also strip partial opening tags at the very end (e.g. "<game_st")
  // by checking if the text ends with a partial `<` sequence
  const lastLt = raw.lastIndexOf('<')
  if (lastLt !== -1 && lastLt > raw.lastIndexOf('>')) {
    return raw.substring(0, lastLt).trim()
  }

  return raw
}

export function useRoleplayLLM({
  uploadedImages,
  setUploadedImages,
  layoutMode,
  setIsChatExpanded
}: UseRoleplayLLMProps) {
  // Local state
  const [rpChatInput, setRpChatInput] = useState('')
  const [rpErrorMsg, setRpErrorMsg] = useState<string | null>(null)

  // Refs
  const rpChatInputRef = useRef<HTMLDivElement>(null)
  const rpChatEndRef = useRef<HTMLDivElement>(null)
  const abortControllerRef = useRef<AbortController | null>(null)
  const accumulatedTextRef = useRef('')

  /**
   * Stop an in-progress generation.
   */
  const handleRpStopGeneration = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
      abortControllerRef.current = null
    }
    useAppStore.getState().setStreaming(false)
  }, [])

  /**
   * Core streaming engine for roleplay mode.
   * Streams the LLM response, parsing RP-specific tags and routing content
   * to the appropriate destinations (chat messages vs. documents).
   */
  const startRpStreaming = useCallback(async (
    apiMessages: LLMMessage[],
    assistantMsgId: string,
    storyLoreDocId: string | null,
    gameStateDocId: string | null,
    onComplete?: (parsedChoices: string[] | null) => void
  ) => {
    const s = useAppStore.getState()

    // Abort any existing stream
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
    }
    abortControllerRef.current = new AbortController()
    const signal = abortControllerRef.current.signal

    try {
      await streamLLM(
        apiMessages,
        { ...s.providerConfigs[s.activeProvider], provider: s.activeProvider, debug: s.debugMode, signal },
        {
          onChunk: (chunk: string) => {
            accumulatedTextRef.current += chunk
            const raw = accumulatedTextRef.current

            // Parse completed tags
            const parsed = parseRoleplayTags(raw)

            // Update documents silently when tags are fully received
            if (parsed.storyLore && storyLoreDocId) {
              useAppStore.getState().updateDocument(storyLoreDocId, { content: parsed.storyLore })
            }
            if (parsed.gameState && gameStateDocId) {
              useAppStore.getState().updateDocument(gameStateDocId, { content: parsed.gameState })
            }

            // For the chat message, show only the narration text.
            // If there's an incomplete tag being streamed, strip it so raw XML
            // doesn't appear in chat.
            let displayText = parsed.narration
            const incompleteTag = getIncompleteTag(raw)
            if (incompleteTag) {
              displayText = stripIncompleteRpTag(parsed.narration)
            }

            // Update the assistant chat message
            const latestMessages = useAppStore.getState().messages
            s.setMessages(
              latestMessages.map(m => {
                if (m.id === assistantMsgId) {
                  return { ...m, content: displayText || 'The story unfolds...' }
                }
                return m
              })
            )
          },

          onDone: (fullText: string, usage?: { promptTokens: number; completionTokens: number; cachedPromptTokens?: number }) => {
            s.setStreaming(false)

            // Track token usage
            const estimatedInputTokens = Math.ceil(JSON.stringify(apiMessages).length / 4)
            let finalInputTokens = estimatedInputTokens
            let finalOutputTokens = Math.ceil(fullText.length / 4)
            let cacheHits = 0

            if (usage) {
              finalInputTokens = usage.promptTokens
              finalOutputTokens = usage.completionTokens
              cacheHits = usage.cachedPromptTokens || 0
            }

            s.addSessionTokens(finalInputTokens, finalOutputTokens, cacheHits)

            // Final parse of the complete text
            const parsed = parseRoleplayTags(fullText)

            // Final document updates
            if (parsed.storyLore && storyLoreDocId) {
              useAppStore.getState().updateDocument(storyLoreDocId, { content: parsed.storyLore })
            }
            if (parsed.gameState && gameStateDocId) {
              useAppStore.getState().updateDocument(gameStateDocId, { content: parsed.gameState })
            }

            // Update assistant message with final narration and optional choices
            const latestMessages = useAppStore.getState().messages
            s.setMessages(
              latestMessages.map(m => {
                if (m.id === assistantMsgId) {
                  return {
                    ...m,
                    content: parsed.narration.trim() || 'The story unfolds...',
                    rpType: 'narration' as const,
                    rpChoices: parsed.choices || undefined
                  }
                }
                return m
              })
            )

            onComplete?.(parsed.choices)
          },

          onError: (err: Error) => {
            s.setStreaming(false)

            const isAbort = err.name === 'AbortError' || err.message.includes('abort') || err.message.includes('cancel')
            if (isAbort) {
              return
            }

            setRpErrorMsg(err.message)

            const latestMessages = useAppStore.getState().messages
            s.setMessages(
              latestMessages.map(m => {
                if (m.id === assistantMsgId) {
                  return { ...m, content: `⚠️ Error: ${err.message}` }
                }
                return m
              })
            )
          }
        }
      )
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e))
      s.setStreaming(false)
      setRpErrorMsg(err.message || 'Failed to initialize roleplay LLM stream.')
    }
  }, [])

  /**
   * Initialize a new roleplay game.
   * Creates lore + game state documents, configures RP mode, and sends
   * an initialization prompt to the LLM.
   */
  const handleInitializeGame = useCallback(async (config: {
    characterName: string
    genre: string
    difficulty: 'easy' | 'normal' | 'hard'
    customWorldDesc?: string
  }) => {
    const s = useAppStore.getState()
    if (s.isStreaming) return

    setRpErrorMsg(null)

    if (layoutMode === 'portrait') {
      setIsChatExpanded(true)
    }

    // 1. Create the two game documents with guaranteed-unique IDs
    //    (addDocument uses Date.now() which can produce duplicates when called
    //    twice in the same tick — so we call it with a small delay between)
    const storyLoreDocId = s.addDocument('📖 Story Lore', '<p>Generating world lore...</p>')
    // Ensure the second document gets a different ID by using a distinct timestamp
    const gameStateDocId = (() => {
      // Use getTimestampId to guarantee uniqueness, then create the doc manually
      const id = getTimestampId('doc')
      const newDoc = {
        id,
        title: '🎮 Game State',
        content: '<p>Initializing game state...</p>',
        selectedReferenceIds: [] as string[],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      useAppStore.setState((state) => ({
        documents: [...state.documents, newDoc],
      }))
      return id
    })()

    // 2. Set roleplay config
    const rpConfig: RoleplayConfig = {
      characterName: config.characterName,
      genre: config.genre,
      difficulty: config.difficulty,
      storyLoreDocId,
      gameStateDocId,
      customWorldDesc: config.customWorldDesc,
      isInitialized: false
    }
    s.setRoleplayConfig(rpConfig)

    // 3. Enable roleplay mode
    s.setRoleplayMode(true)

    // 4. Clear chat and add system event message
    const systemEventMsg: ChatMessage = {
      id: getTimestampId('system'),
      role: 'assistant',
      content: `⚔️ Starting a new ${config.genre} adventure as ${config.characterName}...`,
      timestamp: new Date().toISOString(),
      rpType: 'system_event',
      provider: s.activeProvider,
      model: s.providerConfigs[s.activeProvider].model
    }
    s.setMessages([systemEventMsg])

    // 5. Build the initialization prompt
    const isCustom = config.genre === 'Custom'
    const customWorldPart = config.customWorldDesc
      ? ` ${config.customWorldDesc}.`
      : ''

    const initPrompt = isCustom
      ? `Start a new custom roleplay game. My character's name is ${config.characterName}. Here is my game setting:\n\n${config.customWorldDesc || ''}\n\nFollow my setting description faithfully. Begin with:
1. Generate the world lore based on my setting, wrapped in <story_lore>...</story_lore> tags (rich HTML with h2, h3, p, ul tags describing the world, factions, key characters, relevant systems, etc.)
2. Generate the initial game state wrapped in <game_state>...</game_state> tags. Decide what stats/fields make sense for my custom game (e.g. if it's a romance game, track Affection, Mood, Relationship Status — NOT HP/Gold). Use this exact HTML format:
<game_state>
<h2>Game State</h2>
<p><strong>Character:</strong> ${config.characterName}</p>
<p><strong>Location:</strong> starting location</p>
<p><strong>RelevantStat:</strong> initial value</p>
</game_state>
3. Write an atmospheric opening narration introducing my character and the starting scenario
4. End with suggested actions or a choice for the player wrapped in <choices>Option A|Option B|Option C</choices> tags`
      : `Start a new ${config.genre} roleplay game. My character's name is ${config.characterName}.${customWorldPart} Begin with:
1. Generate the world lore wrapped in <story_lore>...</story_lore> tags (rich HTML with h2, h3, p, ul tags describing the world, factions, key characters, magic system or technology, etc.)
2. Generate the initial game state wrapped in <game_state>...</game_state> tags using this exact HTML format:
<game_state>
<h2>Game State</h2>
<p><strong>Character:</strong> ${config.characterName}</p>
<p><strong>Location:</strong> starting location</p>
<p><strong>StatName:</strong> initial value</p>
</game_state>
3. Write an atmospheric opening narration introducing my character and the starting scenario
4. End with suggested actions or a choice for the player wrapped in <choices>Option A|Option B|Option C</choices> tags`

    // Create assistant placeholder
    const assistantMsgId = getTimestampId('assistant')
    const assistantPlaceholder: ChatMessage = {
      id: assistantMsgId,
      role: 'assistant',
      content: 'Crafting your world...',
      timestamp: new Date().toISOString(),
      provider: s.activeProvider,
      model: s.providerConfigs[s.activeProvider].model
    }
    s.addMessage(assistantPlaceholder)
    s.setStreaming(true)

    accumulatedTextRef.current = ''

    // Build API messages
    const systemPrompt = buildRoleplaySystemPrompt(rpConfig)
    const apiMessages: LLMMessage[] = [
      systemPrompt,
      { role: 'user', content: initPrompt }
    ]

    // 6–7. Stream the response and mark initialization complete when done
    await startRpStreaming(
      apiMessages,
      assistantMsgId,
      storyLoreDocId,
      gameStateDocId,
      () => {
        // After streaming completes, mark as initialized
        const latestConfig = useAppStore.getState().roleplayConfig
        if (latestConfig) {
          useAppStore.getState().setRoleplayConfig({
            ...latestConfig,
            isInitialized: true
          })
        }
      }
    )
  }, [layoutMode, setIsChatExpanded, startRpStreaming])

  /**
   * Send a player action message during gameplay.
   */
  const handleRpSendMessage = useCallback(async (e?: React.FormEvent, customPrompt?: string) => {
    e?.preventDefault()

    const s = useAppStore.getState()
    const promptText = customPrompt ? customPrompt.trim() : rpChatInput.trim()
    if (!promptText || s.isStreaming) return

    const rpConfig = s.roleplayConfig
    if (!rpConfig) return

    if (layoutMode === 'portrait') {
      setIsChatExpanded(true)
    }

    setRpErrorMsg(null)

    // Clear input
    if (!customPrompt) {
      setRpChatInput('')
      if (rpChatInputRef.current) {
        rpChatInputRef.current.innerHTML = ''
      }
    }

    // 1. Create user message with rpType: 'action'
    const userMsgId = getTimestampId('user')
    const userMsg: ChatMessage = {
      id: userMsgId,
      role: 'user',
      content: promptText,
      images: uploadedImages.length > 0 ? uploadedImages : undefined,
      timestamp: new Date().toISOString(),
      provider: s.activeProvider,
      model: s.providerConfigs[s.activeProvider].model,
      rpType: 'action'
    }
    s.addMessage(userMsg)
    setUploadedImages([])

    // 2. Create assistant placeholder
    const assistantMsgId = getTimestampId('assistant')
    const assistantPlaceholder: ChatMessage = {
      id: assistantMsgId,
      role: 'assistant',
      content: 'The story unfolds...',
      timestamp: new Date().toISOString(),
      provider: s.activeProvider,
      model: s.providerConfigs[s.activeProvider].model
    }
    s.addMessage(assistantPlaceholder)
    s.setStreaming(true)

    accumulatedTextRef.current = ''

    // 3. Build API messages
    const systemPrompt = buildRoleplaySystemPrompt(rpConfig)

    // Fetch story lore and game state documents for context
    const currentState = useAppStore.getState()
    const storyLoreDoc = currentState.documents.find(d => d.id === rpConfig.storyLoreDocId)
    const gameStateDoc = currentState.documents.find(d => d.id === rpConfig.gameStateDocId)

    const storyLoreContext: LLMMessage = {
      role: 'user',
      content: `WORLD LORE:\n${stripHtmlTags(storyLoreDoc?.content || '')}`
    }

    const gameStateContext: LLMMessage = {
      role: 'user',
      content: `CURRENT GAME STATE:\n${stripHtmlTags(gameStateDoc?.content || '')}`
    }

    const contextAck: LLMMessage = {
      role: 'assistant',
      content: 'Understood. I have the world lore and game state context. I am ready to continue the adventure.'
    }

    // Build chat history from RP messages (excluding system events and the
    // messages we just added as context)
    const historyMessages: LLMMessage[] = currentState.messages
      .filter(m =>
        m.id !== 'welcome' &&
        m.rpType !== 'system_event' &&
        m.id !== assistantMsgId
      )
      .map(m => ({
        role: m.role,
        content: m.content,
        images: m.images
      }))

    const apiMessages: LLMMessage[] = [
      systemPrompt,
      storyLoreContext,
      gameStateContext,
      contextAck,
      ...historyMessages
    ]

    // 4–5. Stream the response
    await startRpStreaming(
      apiMessages,
      assistantMsgId,
      rpConfig.storyLoreDocId,
      rpConfig.gameStateDocId
    )
  }, [rpChatInput, uploadedImages, layoutMode, setIsChatExpanded, setUploadedImages, startRpStreaming])

  return {
    rpChatInput,
    setRpChatInput,
    rpChatInputRef,
    rpChatEndRef,
    rpErrorMsg,
    setRpErrorMsg,
    handleRpSendMessage,
    handleRpStopGeneration,
    handleInitializeGame
  }
}
