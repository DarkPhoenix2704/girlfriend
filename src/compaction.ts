// Compaction: when total tokens exceed threshold, replaces message history with a summary

import Anthropic from "@anthropic-ai/sdk";
import { COMPACTION_PROMPT } from "./prompts.ts";
import { withRetry } from "./retry.ts";

// Always use Haiku for compaction — cheaper and sufficient for summarization
const COMPACTION_MODEL = "claude-haiku-4-5-20251001";

const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  "claude-opus-4":   200_000,
  "claude-sonnet-4": 200_000,
  "claude-haiku-4":  200_000,
  "claude-3-5":      200_000,
  "claude-3-opus":   200_000,
};

/** Returns compaction threshold: 50% of the model's context window. */
export function getCompactionThreshold(model: string): number {
  for (const [prefix, ctx] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
    if (model.includes(prefix)) return Math.floor(ctx * 0.5);
  }
  return 100_000; // safe default
}


export interface CompactionResult {
  compacted: boolean;
  messages: Anthropic.MessageParam[];
  summary?: string;
}

/**
 * Checks if total token usage exceeds the threshold and compacts if needed.
 * Replaces all messages with a single summary message.
 */
export async function maybeCompact(
  client: Anthropic,
  messages: Anthropic.MessageParam[],
  systemPrompt: string,
  model: string,
  totalTokensUsed: number
): Promise<CompactionResult> {
  if (totalTokensUsed < getCompactionThreshold(model)) {
    return { compacted: false, messages };
  }

  const summary = await compact(client, messages, systemPrompt, model);
  const compactedMessages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: summary,
    },
  ];

  return { compacted: true, messages: compactedMessages, summary };
}

/**
 * Runs the compaction summarization call.
 * Appends COMPACTION_PROMPT to the last user message, calls the model,
 * extracts <summary>...</summary> tags from the response.
 */
export async function compact(
  client: Anthropic,
  messages: Anthropic.MessageParam[],
  systemPrompt: string,
  _model: string, // kept for signature compatibility; we always use Haiku
): Promise<string> {
  const compactionMessages: Anthropic.MessageParam[] = [
    ...messages,
    { role: "user", content: COMPACTION_PROMPT },
  ];

  const response = await withRetry(() =>
    client.messages.create({
      model: COMPACTION_MODEL,
      max_tokens: 8192,
      system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
      messages: compactionMessages,
    })
  );

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  // Extract <summary>...</summary>
  const match = text.match(/<summary>([\s\S]*?)<\/summary>/);
  if (match) {
    return (match[1] ?? "").trim();
  }

  // Fallback: return full text if tags not found
  return text;
}

