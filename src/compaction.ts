// Compaction: when total tokens exceed threshold, replaces message history with a summary

import Anthropic from "@anthropic-ai/sdk";
import { COMPACTION_PROMPT } from "./prompts.ts";

export const COMPACTION_TOKEN_THRESHOLD = 100_000;

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
  if (totalTokensUsed < COMPACTION_TOKEN_THRESHOLD) {
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
const MAX_RETRIES = 5;
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 16_000;

function backoffMs(attempt: number): number {
  return Math.min(BASE_BACKOFF_MS * Math.pow(2, attempt), MAX_BACKOFF_MS) * (1 + 0.25 * Math.random());
}

export async function compact(
  client: Anthropic,
  messages: Anthropic.MessageParam[],
  systemPrompt: string,
  model: string
): Promise<string> {
  const compactionMessages: Anthropic.MessageParam[] = [
    ...messages,
    { role: "user", content: COMPACTION_PROMPT },
  ];

  let response!: Anthropic.Message;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      response = await client.messages.create({
        model,
        max_tokens: 8096,
        system: systemPrompt,
        messages: compactionMessages,
      });
      break;
    } catch (err: unknown) {
      const status = (err as { status?: number }).status;
      const retryable = status === 429 || status === 529 || status === 500 || status === 503;
      if (!retryable || attempt === MAX_RETRIES) throw err;
      await new Promise(r => setTimeout(r, backoffMs(attempt)));
    }
  }

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

