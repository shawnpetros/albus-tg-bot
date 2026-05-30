// Voice asides: a fast in-character ack before the heavy turn, and a spoken
// TL;DR fallback after it. Both run via spawnQuick (stripped, sessionless,
// fast model) with the persona-voice card as the system prompt. Pure prompt
// builders are exported for unit testing; the spawn wrappers are best-effort.

import { existsSync, readFileSync } from "node:fs";
import { spawnQuick } from "./claude.ts";
import {
  VOICE_ASIDE_MODEL,
  VOICE_TLDR_MAX_CHARS,
  PERSONA_VOICE_PATH,
} from "./config.ts";

// First-pass wording. Task 5 (bake-off) replaces these with tuned text.
export const ACK_INSTRUCTION =
  "Reply in ONE line, in character, reacting to the shape and ambition of what the operator just asked. " +
  "A long-winded build-out earns a dry, weary quip; a one-line question earns a deadpan beat. " +
  "Do NOT summarize the request back. Do NOT say you will start or 'get on it' literally. " +
  "Do NOT attempt to answer anything that needs tools, files, or memory. Just the aside.";

export const SUMMARY_INSTRUCTION =
  "Condense the reply below into a short spoken TL;DR in the operator's assistant voice. " +
  "Two or three sentences, plain spoken prose, faithful to the reply, nothing the reply does not say.";

let cachedCard: string | null = null;
// Loads the persona-voice card once. Missing file degrades gracefully to an
// empty system prompt (asides still run, just with less flavour).
export function loadVoiceCard(): string {
  if (cachedCard !== null) return cachedCard;
  try {
    cachedCard = existsSync(PERSONA_VOICE_PATH)
      ? readFileSync(PERSONA_VOICE_PATH, "utf8")
      : "";
  } catch {
    cachedCard = "";
  }
  return cachedCard;
}

export function buildAckPrompt(transcript: string): string {
  return (
    `${ACK_INSTRUCTION}\n\n` +
    `The operator just sent this voice memo:\n"""\n${transcript.trim()}\n"""\n\n` +
    `Your one-line reply:`
  );
}

export function buildSummaryPrompt(replyText: string, maxChars: number): string {
  return (
    `${SUMMARY_INSTRUCTION} Keep it under ${maxChars} characters.\n\n` +
    `Reply to condense:\n"""\n${replyText.trim()}\n"""\n\n` +
    `Spoken TL;DR:`
  );
}

// Best-effort: callers wrap in try/catch. Returns the spoken text.
export async function quickAck(transcript: string): Promise<string> {
  const out = await spawnQuick({
    input: buildAckPrompt(transcript),
    system: loadVoiceCard(),
    model: VOICE_ASIDE_MODEL,
  });
  return out.trim();
}

export async function voiceSummary(replyText: string): Promise<string> {
  const out = await spawnQuick({
    input: buildSummaryPrompt(replyText, VOICE_TLDR_MAX_CHARS),
    system: loadVoiceCard(),
    model: VOICE_ASIDE_MODEL,
  });
  return out.trim();
}
