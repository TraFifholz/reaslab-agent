import { Installation } from "@/installation"
import { Provider } from "@/provider/provider"
import { ACPProviderMeta } from "@/acp/provider-meta"
import { Log } from "@/util/log"
import { ProviderQuirks } from "@/provider/quirks"
import {
  streamText,
  type ModelMessage,
  type StreamTextResult,
  type Tool,
  type ToolSet,
  tool,
  jsonSchema,
} from "ai"
import { mergeDeep, pipe } from "remeda"
import { ProviderTransform } from "@/provider/transform"
import type { Agent } from "@/agent/agent"
import type { MessageV2 } from "./message-v2"
import { Plugin } from "@/plugin"
import { SystemPrompt } from "./system"
import { Permission } from "@/permission"

export namespace LLM {
  const log = Log.create({ service: "llm" })
  export const OUTPUT_TOKEN_MAX = 32000

  type RepairableToolCall = {
    toolName: string
    input: string
    [key: string]: unknown
  }

  export function repairToolCall<T extends RepairableToolCall>(
    failed: {
      toolCall: T
      error: {
        message: string
      }
    },
    tools: Record<string, Tool>,
  ): T {
    const lower = failed.toolCall.toolName.toLowerCase()
    if (lower !== failed.toolCall.toolName && tools[lower]) {
      log.info("repairing tool call", {
        tool: failed.toolCall.toolName,
        repaired: lower,
      })
      return {
        ...failed.toolCall,
        toolName: lower,
      }
    }
    const repaired = {
      ...failed.toolCall,
      input: JSON.stringify({
        tool: failed.toolCall.toolName,
        error: failed.error.message,
      }),
      toolName: "invalid",
    }
    return repaired
  }

  export type StreamInput = {
    user: MessageV2.User
    sessionID: string
    model: Provider.Model
    agent: Agent.Info
    permission?: Permission.Ruleset
    system: string[]
    abort: AbortSignal
    messages: ModelMessage[]
    small?: boolean
    tools: Record<string, Tool>
    retries?: number
    toolChoice?: "auto" | "required" | "none"
    /** Provider meta for runtime model resolution */
    meta?: Provider.Meta
  }

  export type StreamOutput = StreamTextResult<ToolSet, unknown>

  export async function stream(input: StreamInput) {
    const l = log
      .clone()
      .tag("providerID", input.model.providerID)
      .tag("modelID", input.model.id)
      .tag("sessionID", input.sessionID)
      .tag("small", (input.small ?? false).toString())
      .tag("agent", input.agent.name)
      .tag("mode", input.agent.mode)
    l.info("stream", {
      modelID: input.model.id,
      providerID: input.model.providerID,
    })
    // In reaslab-agent, model resolution comes from meta at runtime.
    // Meta can be passed explicitly in StreamInput, or looked up from
    // ACPProviderMeta (populated by ACP server before SessionPrompt.prompt()).
    const meta = input.meta ?? ACPProviderMeta()[input.sessionID]
    const language = meta
      ? Provider.fromMeta(meta)
      : Provider.fromMeta({
          model: input.model.id,
          baseUrl: "http://localhost:8080",
          apiKey: "dummy",
        })

    const system: string[] = []
    system.push(
      [
        // use agent prompt otherwise provider prompt
        ...(input.agent.prompt ? [input.agent.prompt] : SystemPrompt.provider(input.model)),
        // any custom prompt passed into this call
        ...input.system,
        // any custom prompt from last user message
        ...(input.user.system ? [input.user.system] : []),
      ]
        .filter((x) => x)
        .join("\n"),
    )

    const header = system[0]
    await Plugin.trigger(
      "experimental.chat.system.transform",
      { sessionID: input.sessionID, model: input.model },
      { system },
    )
    // rejoin to maintain 2-part structure for caching if header unchanged
    if (system.length > 2 && system[0] === header) {
      const rest = system.slice(1)
      system.length = 0
      system.push(header, rest.join("\n"))
    }

    const base = input.small ? {} : {}
    const options: Record<string, any> = pipe(
      base,
      mergeDeep(input.agent.options),
    )

    // Some providers don't support certain message roles (e.g., 'developer')
    // Check provider quirks to determine how to send system prompts
    const useSystemAsUser = ProviderQuirks.requiresSystemAsUser(input.model.providerID)

    const messages = useSystemAsUser
      ? [
          ...(system.length > 0
            ? [
                {
                  role: "user" as const,
                  content: system.join("\n\n"),
                },
              ]
            : []),
          ...input.messages,
        ]
      : [
          ...system.map(
            (x): ModelMessage => ({
              role: "system",
              content: x,
            }),
          ),
          ...input.messages,
        ]

    const params = await Plugin.trigger(
      "chat.params",
      {
        sessionID: input.sessionID,
        agent: input.agent,
        model: input.model,
        message: input.user,
      },
      {
        temperature: input.agent.temperature,
        topP: input.agent.topP,
        topK: undefined as number | undefined,
        options,
      },
    )

    const { headers } = await Plugin.trigger(
      "chat.headers",
      {
        sessionID: input.sessionID,
        agent: input.agent,
        model: input.model,
        message: input.user,
      },
      {
        headers: {} as Record<string, string>,
      },
    )

    const maxOutputTokens = ProviderTransform.maxOutputTokens(input.model)

    const tools = await resolveTools(input)

    return streamText({
      onError(error) {
        l.error("stream error", {
          error,
        })
      },
      async experimental_repairToolCall(failed) {
        return repairToolCall(failed, tools)
      },
      temperature: params.temperature,
      topP: params.topP,
      topK: params.topK,
      providerOptions: {},
      activeTools: Object.keys(tools).filter((x) => x !== "invalid"),
      tools,
      toolChoice: input.toolChoice,
      maxOutputTokens,
      abortSignal: input.abort,
      headers: {
        "User-Agent": `reaslab-agent/${Installation.VERSION}`,
        ...headers,
      },
      maxRetries: input.retries ?? 0,
      messages,
      model: language,
    })
  }

  async function resolveTools(input: Pick<StreamInput, "tools" | "agent" | "permission" | "user">) {
    const disabled = Permission.disabled(
      Object.keys(input.tools),
      Permission.merge(input.agent.permission, input.permission ?? []),
    )
    for (const tool of Object.keys(input.tools)) {
      if (input.user.tools?.[tool] === false || disabled.has(tool)) {
        delete input.tools[tool]
      }
    }
    return input.tools
  }

  // Check if messages contain any tool-call content
  // Used to determine if a dummy tool should be added for LiteLLM proxy compatibility
  export function hasToolCalls(messages: ModelMessage[]): boolean {
    for (const msg of messages) {
      if (!Array.isArray(msg.content)) continue
      for (const part of msg.content) {
        if (part.type === "tool-call" || part.type === "tool-result") return true
      }
    }
    return false
  }
}
