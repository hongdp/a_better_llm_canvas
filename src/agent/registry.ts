/**
 * The tool registry: the one list the loop offers, previews and executes from.
 *
 * Adding a tool is `defineTool({...})` in its own module plus one `register`
 * call where the registry is assembled. Nothing else in the loop names a tool:
 * offering, the provider schemas, the live preview and execution all go
 * through here.
 */
import type { AgentTool, ToolContext, ToolInvocation, ToolKind, ToolResult, ToolSpec } from './types'

/** A tool with its argument type erased, as the registry holds it. */
export interface RegisteredTool extends ToolSpec {
  kind: ToolKind
  markupForm?: boolean
  runLast?: boolean
  isAvailable(ctx: ToolContext): boolean
  preview?(partialArgumentsText: string, ctx: ToolContext): void
  /** Parse, then execute. An argument error becomes a failed result. */
  invoke(call: ToolInvocation, ctx: ToolContext): ToolResult | Promise<ToolResult>
}

export function defineTool<A>(tool: AgentTool<A>): RegisteredTool {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    kind: tool.kind,
    markupForm: tool.markupForm,
    runLast: tool.runLast,
    isAvailable: ctx => tool.isAvailable(ctx),
    preview: tool.preview ? (text, ctx) => tool.preview?.(text, ctx) : undefined,
    invoke: (call, ctx) => {
      const parsed = tool.parse(call.args)
      if (typeof parsed === 'string') {
        return {
          ok: false,
          content: `${tool.name} was not run: ${parsed}`,
          trace: `⚠️ ${tool.name}: ${parsed}`,
          // A write the model attempted but could not express is reported as
          // such — otherwise the turn ends in silence over an unchanged document.
          effects: tool.kind === 'write' ? { producedNothing: true } : undefined
        }
      }
      return tool.execute(parsed, ctx, call)
    }
  }
}

export class ToolRegistry {
  private readonly tools: RegisteredTool[] = []

  constructor(tools: RegisteredTool[] = []) {
    tools.forEach(t => this.register(t))
  }

  register(tool: RegisteredTool): void {
    if (this.get(tool.name)) throw new Error(`Tool "${tool.name}" is already registered`)
    this.tools.push(tool)
  }

  get(name: string | undefined): RegisteredTool | undefined {
    return name ? this.tools.find(t => t.name === name) : undefined
  }

  /** The tools a step may offer, in registration order. */
  available(ctx: ToolContext, filter: (tool: RegisteredTool) => boolean = () => true): RegisteredTool[] {
    return this.tools.filter(t => filter(t) && t.isAvailable(ctx))
  }
}

/** Strip a tool to the schema the provider adapters translate. */
export function toToolSpecs(tools: RegisteredTool[]): ToolSpec[] {
  return tools.map(({ name, description, parameters }) => ({ name, description, parameters }))
}
