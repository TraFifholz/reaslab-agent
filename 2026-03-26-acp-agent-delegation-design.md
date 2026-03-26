# ACP Agent Delegation Design

**Date:** 2026-03-26

## Goal

Allow `reaslab-agent` to delegate a single turn to another ACP agent while keeping `reaslab-agent` as the main conversational entrypoint. The capability must work both when the user explicitly uses an inline slash command and when the user asks in natural language for the default agent to invoke another agent.

## Scope

This design covers:

- single-turn delegation from `reaslab-agent` to another ACP agent
- a tool-first execution model
- slash-command compatibility for explicit user invocation
- fuzzy target-agent matching with explicit ambiguity handling
- result projection back into the current `reaslab-agent` turn

This design does not cover:

- session-wide agent switching
- multi-agent orchestration in one turn
- automatic agent selection without an explicit target hint
- implementation planning or code changes

## Context

`reaslab-uni` already supports multiple ACP agents, but it does so through a brokered model rather than direct frontend-to-agent routing. The frontend sends `session/prompt` to a single ACP endpoint and includes the intended target agent in prompt metadata. Backend broker code then resolves the target agent, switches or creates the correct runtime container, initializes ACP if needed, and forwards the prompt to that agent.

The most relevant reference seams are:

- `reaslab-uni/reaslab-be/reaslab-ai-modeling/src/chat_prompt.rs`
  - `sync_agent_from_prompt_meta(...)` switches the active runtime based on `_meta.agentID`
- `reaslab-uni/reaslab-be/reaslab-ai-modeling/src/aiagent_manager.rs`
  - per-agent process-manager reuse and startup
- `reaslab-uni/reaslab-be/reaslab-ai-agent/src/registry.rs`
  - agent lookup, image resolution, and MCP configuration
- `reaslab-uni/reaslab-fe/reaslab-ide/components/ide/sidebar/reaslingo/Chat/ReasLingoChatArea.tsx`
  - prompt-time `_meta.agentID` emission

On the `reaslab-agent` side, the important existing pieces are:

- `src/acp/server.ts`
  - ACP prompt ingress and slash-command parsing on the `slash-parsing` branch
- `src/session/prompt.ts`
  - command execution and prompt execution boundaries
- `src/command/index.ts`
  - command discovery and resolution
- `src/tool/task.ts`
  - reference for delegated execution patterns inside the agent runtime

The key design decision is to avoid making slash commands the only invocation path. Users may explicitly write a slash command, but they may also naturally ask the default agent to invoke another agent. The underlying delegation capability therefore needs to exist as an actual tool, with slash as a convenience entrypoint rather than the core execution path.

## User Experience Requirements

The feature must support both of these interaction styles:

1. Explicit command style

```text
/delegate survey 查一下 xxxx
```

2. Natural-language style

```text
帮我调起 survey agent 来查一个 xxxx
```

Both forms should produce the same semantic outcome:

- the current turn is delegated to a resolved external ACP agent
- the resolved agent performs the requested work
- the result is returned inside the current `reaslab-agent` conversation
- the next turn returns to normal `reaslab-agent` behavior unless the user delegates again

The feature should feel like a single-turn capability, not a session mode switch.

Natural-language delegation must not trigger from every mention of another agent. For v1, the default agent should only delegate when both of the following are true:

- the user expresses explicit invocation intent, such as “use”, “invoke”, “call”, “delegate to”, “调起”, or equivalent wording
- the user provides an explicit target hint that can be resolved against delegatable agents

Requests that merely discuss another agent, compare agents, or ask whether an agent exists should stay in normal `reaslab-agent` conversation flow and should not trigger delegation.

## Design Overview

### Decision

Use a `tool-first` design:

- the core capability is a dedicated delegation tool
- slash command support is an explicit shortcut into that same capability
- natural-language delegation is handled by the default agent choosing to call the tool

### Why Tool-First

This design is preferred over a slash-only design for four reasons:

1. It supports natural-language requests like “help me invoke the survey agent” without requiring the user to know slash syntax.
2. It keeps delegation as a real runtime action with structured inputs, structured errors, and auditable results.
3. It avoids duplicating business logic between slash execution and model-directed execution.
4. It matches the underlying reality that delegation is a runtime capability, not just a text templating trick.

## Proposed Capability Model

### New Core Tool

Add a dedicated tool, referred to here as `delegate_agent`.

Its responsibility is:

- resolve an external ACP agent from a user-provided hint
- perform a single delegated prompt against that target agent
- return the result, matched agent metadata, and any warnings or failures

Illustrative input shape:

```ts
{
  agent: string,
  prompt: string,
  resources?: [...],
  files?: [...],
  reason?: string,
}
```

Illustrative output shape:

```ts
{
  matchedAgentId: string,
  matchedBy: "exact_id" | "display_name" | "alias" | "normalized" | "fuzzy",
  output: string,
  warnings?: string[],
  delegationTraceId?: string,
}
```

The exact shape can change during implementation, but the spec requires structured success and failure states rather than only plain text.

### Slash Command as Shortcut

Add a built-in slash command:

```text
/delegate <agent-hint> <prompt>
```

For v1, slash parsing must be unambiguous for multi-word agent names and aliases. The command should therefore support either:

- quoted agent hints, such as `/delegate "survey agent" 查一下 xxxx`
- a multiline form where the first line carries the agent hint and the remaining body carries the delegated prompt

Recommended v1 parsing rule:

- single-line form: the first argument is `agent-hint`; multi-word hints must be quoted
- multiline form: the first line is `/delegate <agent-hint>` and the remaining lines become the delegated prompt body

The slash command does not implement delegation itself. Its role is only to funnel explicit user input into the same delegation capability that the tool exposes.

That keeps behavior aligned across:

- slash invocation
- natural-language invocation
- future reuse by other commands, skills, or flows

## Single-Turn Delegation Semantics

Delegation must be single-turn only.

That means:

- it does not change the current session’s default agent
- it does not persist a new target agent for later turns
- it does not turn the current conversation into a child conversation with the external agent
- the external agent is treated as a one-turn executor for the current request

At the protocol/runtime level, “single turn” means exactly one delegated ACP `session/prompt` request initiated by `reaslab-agent` for the current user turn. Inside that delegated turn, the external agent may perform its own internal multi-step reasoning and tool use according to its normal runtime behavior, but it may not receive a second user follow-up as part of the same delegation contract.

To preserve that contract, delegated execution must use isolated backend session identity. V1 should require either:

- a fresh ephemeral delegated session per delegation request, or
- an equivalently isolated backend execution mode that guarantees no hidden reuse of prior delegated conversational context

Reusing a long-lived delegated backend session with retained prior user context is out of scope for v1.

For v1:

- delegation ends when that single delegated prompt reaches a terminal ACP outcome such as success, error, cancellation, or timeout
- server-driven continuations or multi-turn handshakes are out of scope
- the delegated agent may stream within its own turn, but `reaslab-agent` only needs a well-defined final projected result contract for the current conversation turn

This aligns with user intuition for requests like “use survey agent for this one thing” and avoids introducing hidden mode changes.

## Matching Model For Agent Hints

External agents should be resolved through a dedicated matching layer instead of ad hoc string comparison.

### Candidate Fields

Matching should consider, in order:

- `agentID`
- `displayName`
- `aliases`

The design assumes adding or exposing aliases in the relevant agent registry view. Aliases are strongly recommended because user-facing names are often shorter and more colloquial than internal IDs.

### Normalization

Before fuzzy comparison, normalize strings by:

- lowercasing
- trimming surrounding whitespace
- collapsing separators such as spaces, `-`, and `_`

### Resolution Order

Resolution should proceed in this order:

1. exact `agentID`
2. exact `displayName`
3. exact alias
4. normalized exact match
5. prefix match
6. token containment / lightweight fuzzy match

Prefix and fuzzy stages must be deterministic. The implementation should compute a stable ranked candidate list, using a documented scoring order, and may auto-execute only when there is a unique top candidate under the accepted-match rule below.

Recommended ranking order:

1. exact field match
2. normalized exact match
3. prefix match on full field
4. token-prefix match
5. token containment / lightweight fuzzy match

Within the same rank, ties should be broken deterministically by:

1. field priority: `agentID` > `displayName` > `alias`
2. shorter normalized candidate length
3. lexical `agentID`

These tie-breakers are for stable ordering and suggestion presentation only. They must not be used to silently select a winner when multiple candidates remain plausible at the best rank.

Accepted-match rule for v1:

- auto-execute only when exactly one candidate occupies the best rank after tie-break evaluation
- if two or more candidates remain plausible at that best rank, return `ambiguous`
- normalized collisions are never silently ignored; they must also return `ambiguous` unless higher-priority exact matching already picked a unique result

### Resolution Outcomes

Resolution must produce one of four states:

- `exact_match`
- `single_fuzzy_match`
- `ambiguous`
- `not_found`

Behavior requirements:

- `exact_match` and `single_fuzzy_match` may execute
- `ambiguous` must fail with explicit candidate suggestions
- `not_found` must fail with explicit guidance
- no ambiguous or missing case may silently fall back to the default agent

## Delegation Execution Flow

### Natural-Language Path

1. User asks `reaslab-agent` to invoke another agent in ordinary language.
2. The default agent recognizes that the user wants external-agent delegation.
3. The default agent calls `delegate_agent`.
4. The tool resolves the target agent.
5. The tool submits a single delegated prompt through the ACP broker path.
6. The external agent completes.
7. The tool returns the result to the current session.
8. The current turn ends with visible evidence of which agent executed the work.

### Slash Path

1. User enters `/delegate ...`.
2. ACP slash parsing recognizes the command and routes it through command flow.
3. The command resolves arguments into the same delegation request shape.
4. The unified delegation capability executes.
5. The result returns through the current session.

The slash path and natural-language path must converge on the same business logic after entrypoint parsing.

## Architecture Boundaries

The runtime should be split into four responsibilities.

### 1. ACP Prompt Entry

`src/acp/server.ts`

Responsibilities:

- accept ACP prompt traffic
- recognize slash commands when present
- route slash input into command flow

Non-responsibilities:

- fuzzy agent matching
- external-agent registry logic
- broker delegation logic

### 2. Command Layer

`src/command/index.ts` and `SessionPrompt.command(...)`

Responsibilities:

- expose `/delegate`
- parse slash arguments into a structured request
- invoke the same delegation capability used by the tool-first path

Non-responsibility:

- direct ownership of external-agent execution semantics

### 3. Delegation Tool

Suggested home: `src/tool/delegate-agent.ts`

Responsibilities:

- receive structured delegation intent
- resolve target agent hint
- validate delegatability
- invoke one external ACP agent for one turn
- surface structured result and structured failure

### 4. ACP Delegation Service

Suggested home: `src/acp/delegation.ts`

Responsibilities:

- list or resolve delegatable agents from the backend integration surface
- call the broker/runtime path that actually executes the external agent
- collect the result and normalize it for the tool layer

This separation keeps parsing, command UX, tool semantics, and infrastructure integration independent.

## Backend Integration Direction

The design intentionally reuses the existing `reaslab-uni` broker model rather than introducing a direct point-to-point invocation path from `reaslab-agent` to random agent containers.

The intended integration shape is:

- `reaslab-agent` resolves the target external agent
- `reaslab-agent` requests one delegated ACP prompt against that target agent
- the `reaslab-uni` backend broker continues to own:
  - runtime/container selection
  - ACP initialization
  - session restoration if needed
  - MCP server configuration tied to that external agent

This keeps the source of truth for external agents in the backend registry and process-manager stack that already exists.

Authority is split as follows:

- backend is the source of truth for which agents exist and which are delegatable
- backend is also the source of truth for canonical IDs, display names, aliases, and runtime execution
- `reaslab-agent` may perform local hint matching only against backend-provided agent metadata
- final execution still targets the backend using the canonical resolved `agentID`

For v1, the backend integration contract must provide a stable way to:

- list delegatable agents, including `agentID`, `displayName`, and aliases
- submit one delegated prompt against a resolved `agentID`
- submit forwarded current-turn resources/attachments through a documented schema
- distinguish success, timeout, cancellation, startup failure, transport failure, and delegated-agent execution failure
- report unsupported, dropped, or partially forwarded resources explicitly

This spec does not require those APIs to be implemented now, but it does require implementation work to define and use a clear contract instead of relying on implicit broker behavior.

## Result Projection Requirements

When delegation succeeds, the current conversation should visibly indicate that an external agent handled the work.

At minimum, the user-visible output should include equivalent metadata to:

```text
Delegated this turn to "agentscope-survey" (matched from "survey").
```

The exact presentation can vary, but the user must be able to tell:

- which agent was used
- whether the hint was exact or fuzzy-resolved
- that the result came from a delegated execution path

For v1, the projected result contract should be:

- always show attribution for the matched external agent
- always include the delegated agent's final text result when available
- do not require replaying the delegated agent's internal tool trace into the parent conversation
- treat delegated warnings as optional structured metadata or short visible notes
- do not require preserving arbitrary structured attachments from the delegated turn unless they are explicitly supported by the backend contract

For v1 success semantics:

- text-bearing delegated results count as success
- attachment-only or structured-only delegated results do not count as success unless the backend contract explicitly marks them as parent-displayable result content
- if delegated execution completes without any usable parent-displayable result content, treat that as an empty-result failure rather than a silent success

The current turn should still read as part of the main conversation, not as a detached child session transcript.

## Failure Handling Requirements

Failure states must be explicit and user-visible.

### Required failure categories

- target agent not found
- target agent match ambiguous
- target agent exists but is not delegatable
- broker/runtime startup failure
- ACP handshake or transport failure
- delegated agent execution error
- delegated timeout
- user cancellation during delegation
- delegated response completes with no usable output

### Required failure properties

- errors must not silently fall back to `reaslab-agent` default execution
- errors must explain whether the failure happened during matching, startup, transport, or delegated execution
- ambiguous matches should include a short candidate list
- not-found cases should include examples of valid agents when available
- timeout and cancellation must be represented distinctly rather than merged into generic execution failure
- empty-result cases must not be presented as success without explanation

## Delegatability Control

Not every registered external agent should automatically become callable from `reaslab-agent`.

The design therefore recommends an explicit delegatability filter, such as:

- a boolean capability on agent registry/config
- a filtered list exposed by the backend API
- or a policy layer in the delegation service

This avoids exposing internal or incompatible agents through generic fuzzy matching.

## Resource And Context Passing

The delegated turn may need access to the same user-provided context that the default agent received.

For v1, the forwarding policy is intentionally narrow. The delegated request should forward:

- the delegated prompt text
- user-attached files/resources already present on the current turn, when they are explicit turn inputs rather than inferred history
- workspace context required for broker routing

The delegated request should not automatically forward:

- the full prior conversation transcript
- hidden system/internal chain-of-thought artifacts
- unrelated historical attachments from earlier turns

If a forwarded file or resource cannot be passed through because of type, size, or transport limitations, v1 should prefer one of two deterministic outcomes:

- fail the delegation when the missing resource is necessary to satisfy the request, or
- continue with an explicit warning when the delegated task is still meaningful without that resource

The implementation may define concrete size/type limits, but they must be documented and surfaced through the integration contract rather than remaining implicit.

This keeps delegation predictable and reduces the risk of accidental context leakage or prompt inflation.

## Testing Requirements

The implementation plan that follows this spec should cover at least these behaviors.

### Entry and routing

- `/delegate ...` is recognized through ACP slash-command compatibility
- slash invocation and natural-language invocation converge on the same delegation behavior

### Matching

- exact `agentID` match succeeds
- exact alias or display-name match succeeds
- fuzzy single match succeeds and reports how it matched
- ambiguous match fails with candidate suggestions
- not-found match fails with guidance

### Execution

- delegated ACP invocation returns a result into the current session
- current-turn delegation does not change the next turn’s default agent
- delegated errors surface clearly to the user

### Context

- delegated prompt text is forwarded as intended
- attached resources/files follow the documented forwarding policy

## Non-Goals And Rejected Alternatives

### Rejected: Slash-Only Design

A slash-only design would align with the new ACP slash-command path, but it would fail the natural-language case where users ask the default agent to invoke another agent without knowing command syntax.

### Rejected: Session-Wide Agent Switching

This would be closer to the frontend agent-selector model in `reaslab-uni`, but it is less intuitive inside a natural-language conversation with `reaslab-agent` and creates hidden persistent state.

### Rejected: Automatic Best-Agent Selection

This would overreach the current goal and encourage opaque model decisions about which external runtime to use. V1 should require an explicit target hint from the user.

### Rejected: Reusing Internal Subagent Task Flow As-Is

`task` and subagent flows inside `reaslab-agent` are a useful conceptual reference, but external ACP-agent invocation is a different boundary. It crosses backend registry, broker, container, and transport layers. The user-facing concept is similar, but the runtime integration should remain distinct.

## Recommended Outcome

Implement external ACP-agent invocation in `reaslab-agent` as a tool-first, single-turn delegation capability.

The product model should be:

- users can explicitly say `/delegate survey ...`
- users can also naturally say “help me invoke the survey agent ...”
- both paths resolve to the same `delegate_agent` capability
- delegation is fuzzy-matchable but never ambiguous by silent guess
- the delegated result is clearly attributed and does not alter future-turn routing

This design best matches user intuition, preserves explicit system boundaries, and reuses the existing `reaslab-uni` multi-agent backend model without duplicating its runtime responsibilities.
