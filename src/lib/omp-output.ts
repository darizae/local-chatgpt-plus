/**
 * Parses an OMP `--mode json` print-mode stream into a single consolidated,
 * honest result. OMP can exit nonzero (e.g. --max-cost stop, tool error,
 * operator interruption) leaving only incremental observation deltas and no
 * final "report" text. Rather than returning an empty/opaque failure, this
 * rebuilds a bounded summary from what was actually observed and marks it as
 * such (`endedWithoutReport`). It never fabricates a report that was not
 * emitted: when a final text exists it is used verbatim.
 */
import { z } from "zod";

export interface OmpAssistantMessage {
  text: string;
  thinking: string;
  toolCallCount: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

export interface OmpConsolidatedResult {
  /** Verbatim final assistant text, if one was emitted. */
  finalText: string;
  /** Last thinking block (bounded, best-effort) — never presented as evidence. */
  thinking: string;
  /** Number of tool executions observed in the stream. */
  toolSteps: number;
  /** Last non-empty observation text before the run ended (bounded). */
  lastObservation: string;
  /** Total model spend in USD cents (rounded). */
  costCents: number;
  inputTokens: number;
  outputTokens: number;
  /** True when agent_end reported isTerminal=true. */
  terminal: boolean;
  /** True when the stream ended without a substantive final text report. */
  endedWithoutReport: boolean;
  /** finalText when present, otherwise an honest rebuilt summary. */
  report: string;
}

const MAX_TEXT = 20_000;

const TextBlock = z.object({ type: z.literal("text"), text: z.string().optional().default("") });
const ThinkingBlock = z.object({ type: z.literal("thinking"), text: z.string().optional().default("") });
const ToolCallBlock = z.object({ type: z.literal("toolCall"), arguments: z.unknown().optional() });
const ContentBlock = z.union([TextBlock, ThinkingBlock, ToolCallBlock, z.record(z.string(), z.unknown())]);

const Usage = z.object({
  input: z.number().optional().default(0),
  output: z.number().optional().default(0),
  cost: z.object({ total: z.number().optional().default(0) }).optional(),
});

const OmpEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("tool_execution_start") }),
  z.object({ type: z.literal("agent_end"), isTerminal: z.boolean().optional() }),
  z.object({
    type: z.literal("message_end"),
    message: z.object({
      role: z.literal("assistant"),
      content: z.array(ContentBlock).optional(),
      usage: Usage.optional(),
    }),
  }),
]);

function blockText(content: unknown, type: "text" | "thinking"): string {
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const block of content) {
    if (!(block && typeof block === "object")) continue;
    const rec = block as Record<string, unknown>;
    if (rec.type === type && typeof rec.text === "string") out += rec.text;
  }
  return out.trim();
}

/**
 * Parse an OMP `--mode json` print-mode stream. `exitCode` is the subprocess
 * exit code (not carried inside the JSON stream). Returns null when the stream
 * is not recognizable as OMP JSONL (so non-OMP or non-JSON runners are
 * untouched).
 */
export function parseOmpJsonOutput(stdout: string, exitCode: number | null): OmpConsolidatedResult | null {
  if (!stdout || !stdout.includes("\n")) return null;

  const messages: OmpAssistantMessage[] = [];
  let toolSteps = 0;
  let terminal = false;
  let sawJsonEvent = false;

  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      continue; // not JSON -> not an OMP-JSON stream line
    }
    const event = OmpEvent.safeParse(parsed);
    if (!event.success) continue; // event we don't track (session/turn/update/start)
    sawJsonEvent = true;
    const data = event.data;
    if (data.type === "tool_execution_start") {
      toolSteps++;
    } else if (data.type === "agent_end") {
      terminal = data.isTerminal === true;
    } else if (data.message.role === "assistant") {
      const usage = data.message.usage;
      messages.push({
        text: blockText(data.message.content, "text"),
        thinking: blockText(data.message.content, "thinking"),
        toolCallCount: Array.isArray(data.message.content)
          ? data.message.content.filter((block) => block.type === "toolCall").length
          : 0,
        costUsd: usage?.cost?.total ?? 0,
        inputTokens: usage?.input ?? 0,
        outputTokens: usage?.output ?? 0,
      });
    }
  }

  if (!sawJsonEvent || messages.length === 0) return null;

  // The terminal assistant message is authoritative: if it carries text that
  // IS the final answer; if it carries only thinking/observations, the run ended
  // without a consolidated report.
  const last = messages[messages.length - 1];
  const finalText = last.text;
  const lastThinking = last.thinking;
  // Most recent non-empty observation text (used only when there is no final report).
  let lastObservation = "";
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].text) {
      lastObservation = messages[i].text;
      break;
    }
  }

  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  for (const m of messages) {
    inputTokens += m.inputTokens;
    outputTokens += m.outputTokens;
    costUsd += m.costUsd;
  }
  const costCents = Math.round(costUsd * 100);
  const endedWithoutReport = finalText.length === 0;
  const report = endedWithoutReport
    ? `[consolidated by Local ChatGPT Plus] The OMP worker exited without emitting a final report text (exitCode=${exitCode ?? "?"}, terminal=${terminal}, ${toolSteps} tool step(s) observed). Last observation before stop: ${lastObservation.slice(0, MAX_TEXT) || "(none)"}`
    : finalText.slice(0, MAX_TEXT);

  return {
    finalText: finalText.slice(0, MAX_TEXT),
    thinking: lastThinking.slice(0, MAX_TEXT),
    toolSteps,
    lastObservation: lastObservation.slice(0, MAX_TEXT),
    costCents,
    inputTokens,
    outputTokens,
    terminal,
    endedWithoutReport,
    report,
  };
}