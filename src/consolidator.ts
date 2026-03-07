// Memory consolidator — reads recent messages and extracts memorable facts via Haiku.
// Call consolidate() from a nightly cron or on-demand.

import Anthropic from "@anthropic-ai/sdk";
import { getRecentMessages, upsertMemory, memoryGet, memorySet, logEvent } from "./sessions.ts";

const LAST_RUN_KEY = "consolidator.last_run";
const BATCH_CHARS = 40_000; // max chars fed to Haiku per run

interface ExtractedFact {
  key: string;
  value: string;
  category: string;
  confidence: number;
}

const SYSTEM_PROMPT = `You are a memory extraction assistant. Given a conversation history, extract facts worth remembering long-term about the user — their preferences, habits, goals, finances, contacts, recurring tasks, and explicit instructions they gave the assistant.

Output ONLY a JSON array. Each element must have:
- key: string — dot-notation identifier (e.g. "user.diet", "finance.monthly_budget")
- value: string — the fact in one clear sentence
- category: string — one of: preference, finance, stocks, calendar, contact, health, task, fact
- confidence: number — 0.0–1.0 (1.0 = explicitly stated, 0.7 = clearly implied, 0.5 = inferred)

Only extract facts that are stable, reusable across future sessions, and personalisation-relevant.
If nothing is worth extracting, output: []`;

/**
 * Run one consolidation pass.
 * Reads messages since last run (or last 200 if first run),
 * calls Haiku to extract facts, upserts into memories table.
 */
export async function consolidate(
  client?: Anthropic,
  options: { sessionId?: number; since?: string } = {}
): Promise<{ factsUpserted: number; messagesScanned: number }> {
  const anthropic = client ?? new Anthropic();
  const since = options.since ?? memoryGet(LAST_RUN_KEY);

  const rawMessages = getRecentMessages(since, 200);
  if (rawMessages.length === 0) {
    return { factsUpserted: 0, messagesScanned: 0 };
  }

  // Build conversation text, capped at BATCH_CHARS
  let conversationText = "";
  for (const m of rawMessages) {
    let text = m.content;
    try {
      const parsed = JSON.parse(m.content);
      if (typeof parsed === "string") {
        text = parsed;
      } else if (Array.isArray(parsed)) {
        text = parsed
          .filter((b: { type: string; text?: string }) => b.type === "text" && b.text)
          .map((b: { text: string }) => b.text)
          .join(" ");
      }
    } catch { /* leave raw */ }
    const line = `[${m.role.toUpperCase()}]: ${text}\n`;
    if (conversationText.length + line.length > BATCH_CHARS) break;
    conversationText += line;
  }

  let facts: ExtractedFact[] = [];
  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: `Extract memorable facts from this conversation:\n\n${conversationText}` }],
    });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    const jsonStr = text.replace(/^```(?:json)?\s*/m, "").replace(/\s*```$/m, "").trim();
    const parsed = JSON.parse(jsonStr);
    if (Array.isArray(parsed)) {
      facts = parsed.filter(
        (f): f is ExtractedFact =>
          typeof f.key === "string" &&
          typeof f.value === "string" &&
          typeof f.category === "string" &&
          typeof f.confidence === "number"
      );
    }
  } catch (err) {
    logEvent("tool_call", {
      sessionId: options.sessionId,
      name: "consolidator",
      output: `ERROR: ${err instanceof Error ? err.message : String(err)}`,
    });
    throw err;
  }

  for (const fact of facts) {
    upsertMemory(fact.key, fact.value, {
      category: fact.category,
      confidence: fact.confidence,
      sourceSession: options.sessionId,
    });
  }

  memorySet(LAST_RUN_KEY, new Date().toISOString());

  logEvent("tool_call", {
    sessionId: options.sessionId,
    name: "consolidator",
    output: `Extracted ${facts.length} facts from ${rawMessages.length} messages`,
  });

  return { factsUpserted: facts.length, messagesScanned: rawMessages.length };
}
