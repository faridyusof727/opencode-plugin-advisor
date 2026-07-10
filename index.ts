import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

type AdvisorConfig = {
  model: string
  system?: string
  tools?: Record<string, boolean>
}

function loadConfig(directory: string): AdvisorConfig | null {
  const candidates = [join(directory, "advisor.json"), join(homedir(), ".config", "opencode", "advisor.json")]
  for (const path of candidates) {
    if (!existsSync(path)) continue
    try {
      const raw = JSON.parse(readFileSync(path, "utf8"))
      if (typeof raw?.model === "string") return raw as AdvisorConfig
    } catch {
      // malformed file, try the next candidate
    }
  }
  return null
}

function parseModel(spec: string): { providerID: string; modelID: string } | null {
  const idx = spec.indexOf("/")
  if (idx <= 0 || idx === spec.length - 1) return null
  return { providerID: spec.slice(0, idx), modelID: spec.slice(idx + 1) }
}

// ponytail: only the mutating tools are denylisted; anything new opencode adds later
// (read/grep/glob/webfetch/etc.) defaults to enabled. Flip to an allowlist if that's ever wrong.
const READ_ONLY_TOOLS: Record<string, boolean> = {
  write: false,
  edit: false,
  patch: false,
  bash: false,
  task: false,
  todowrite: false,
}

const ADVISOR_SYSTEM_PROMPT = `You are an advisor consulted by another AI coding agent partway through its work.
You are NOT implementing anything yourself. You have read-only tools (read/grep/glob/webfetch) to verify
claims or inspect code if needed, but you must never write, edit, or run commands.

The agent will describe: the situation, its proposed approach, and a specific question.
Respond with direct, concise, technically rigorous feedback:
- Point out risks, edge cases, or simpler alternatives the agent may have missed.
- If the approach is sound, say so briefly and move on -- do not pad with praise.
- If you need more information to judge, say exactly what's missing rather than guessing.
- Prefer the smallest safe change over the most thorough one, unless the context implies otherwise.
Keep your answer focused; this is a second opinion, not a rewrite of the plan.`

// Advisor sessions are cached per parent session for this plugin instance's lifetime, so a
// multi-turn conversation with the advisor keeps context instead of starting fresh each call.
const advisorSessions = new Map<string, string>()

const ADVISE_COMMAND_TEMPLATE = `Call the \`advisor\` tool right now for a second opinion, using what you already
know from this session:

- \`situation\`: summarize what you're currently working on and why advice is needed.
- \`approach\`: the concrete solution or plan you're considering (if you haven't
  explored/decided on one yet, explore first, then call the tool).
- \`question\`: $ARGUMENTS

If $ARGUMENTS is empty, ask yourself what the single riskiest or most uncertain
part of the current approach is, and use that as the question.

Report the advisor's feedback back to me, then tell me whether you agree with it
and what you'll do next.`

export const AdvisorPlugin: Plugin = async ({ client }) => {
  return {
    // Registers /advise as a slash command by mutating the live merged config,
    // instead of shipping a separate command markdown file.
    config: async (cfg) => {
      cfg.command ??= {}
      cfg.command.advise ??= {
        description: "Get a second opinion from the advisor model on your current approach.",
        template: ADVISE_COMMAND_TEMPLATE,
      }
    },
    tool: {
      advisor: tool({
        description:
          "Consult a second, independent AI model for feedback before acting. Call this when: " +
          "(1) the change is big, risky, hard to reverse, or involves many blocking/destructive operations; " +
          "(2) exploration is done and you have a concrete solution but want a second opinion before implementing; " +
          "(3) the user explicitly asks you to get advice, a second opinion, or to check your approach. " +
          "The advisor cannot edit files or run commands -- it only reasons and responds with feedback.",
        args: {
          situation: tool.schema.string().describe("What you're working on and why you need advice right now."),
          approach: tool.schema.string().describe("The concrete solution or plan you're considering, after exploration."),
          question: tool.schema.string().describe("The specific decision or risk you want the advisor to weigh in on."),
          context: tool.schema.string().optional().describe("Relevant files, constraints, or alternatives already considered."),
        },
        async execute(args, ctx) {
          const config = loadConfig(ctx.directory)
          if (!config) {
            return (
              'Advisor is not configured. Create advisor.json with a "model" field ' +
              '(e.g. { "model": "anthropic/claude-fable-5" }) in the project root or at ' +
              "~/.config/opencode/advisor.json, then retry."
            )
          }

          const model = parseModel(config.model)
          if (!model) {
            return `Advisor config has an invalid "model" value: ${JSON.stringify(config.model)}. Expected "provider/model-id".`
          }

          let sessionID = advisorSessions.get(ctx.sessionID)
          if (!sessionID) {
            const created = await client.session.create({
              body: { parentID: ctx.sessionID, title: "Advisor" },
            })
            sessionID = created.data!.id
            advisorSessions.set(ctx.sessionID, sessionID)
          }

          const prompt = [
            `Situation:\n${args.situation}`,
            `Proposed approach:\n${args.approach}`,
            args.context ? `Additional context:\n${args.context}` : null,
            `Question for you:\n${args.question}`,
          ]
            .filter((section): section is string => Boolean(section))
            .join("\n\n")

          const response = await client.session.prompt({
            path: { id: sessionID },
            body: {
              model,
              system: config.system ?? ADVISOR_SYSTEM_PROMPT,
              tools: config.tools ?? READ_ONLY_TOOLS,
              parts: [{ type: "text", text: prompt }],
            },
          })

          const text = (response.data?.parts ?? [])
            .filter((part) => part.type === "text")
            .map((part) => (part as { text: string }).text)
            .join("\n")
            .trim()

          return text || "Advisor returned no text response."
        },
      }),
    },
  }
}

export default AdvisorPlugin
