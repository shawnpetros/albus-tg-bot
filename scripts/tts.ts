#!/usr/bin/env bun
// Tiny CLI that synthesises speech via ElevenLabs and writes an mp3 file.
// Designed for Claude (the bot's subprocess) to invoke via Bash when it
// wants to send the operator a voice reply.
//
// Usage:
//   bun run scripts/tts.ts --text "Hello, friend." --out /path/to/reply.mp3
//   echo "Hello" | bun run scripts/tts.ts --out /path/to/reply.mp3
//
// Requires ELEVENLABS_API_KEY in env. Voice defaults to VOICE_ID
// unless --voice is passed explicitly.

import { writeFileSync } from "node:fs";
import { synthesizeSpeech } from "../lib/elevenlabs.ts";
import { VOICE_ID } from "../lib/config.ts";

function parseArgs(argv: string[]): { text?: string; out?: string; voice?: string } {
  const out: { text?: string; out?: string; voice?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--text" && next) {
      out.text = next;
      i++;
    } else if (a === "--out" && next) {
      out.out = next;
      i++;
    } else if (a === "--voice" && next) {
      out.voice = next;
      i++;
    } else if (a === "--help" || a === "-h") {
      printUsage();
      process.exit(0);
    }
  }
  return out;
}

function printUsage(): void {
  console.error(
    "Usage:\n" +
      "  bun run scripts/tts.ts --text \"...\" --out reply.mp3\n" +
      "  echo \"...\" | bun run scripts/tts.ts --out reply.mp3\n\n" +
      "Options:\n" +
      "  --text  TEXT     Inline text (else reads stdin)\n" +
      "  --out   PATH     Output mp3 path (required)\n" +
      "  --voice ID       ElevenLabs voice id (default: VOICE_ID)\n"
  );
}

async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Uint8Array);
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.out) {
    console.error("ERROR: --out is required");
    printUsage();
    process.exit(2);
  }
  const text = args.text ?? (await readStdin());
  if (!text || !text.trim()) {
    console.error("ERROR: no text supplied (use --text or pipe to stdin)");
    process.exit(2);
  }
  const voiceId = args.voice ?? VOICE_ID;
  if (!voiceId) {
    console.error(
      "ERROR: no voice id (pass --voice or set VOICE_ID in env)"
    );
    process.exit(2);
  }
  const mp3 = await synthesizeSpeech(text, { voiceId });
  writeFileSync(args.out, mp3);
  console.error(`wrote ${mp3.length} bytes to ${args.out}`);
}

main().catch((e) => {
  console.error("tts failed:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
