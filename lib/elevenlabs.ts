// ElevenLabs wrappers for text-to-speech and speech-to-text.
//
// Both calls require ELEVENLABS_API_KEY in the env. Voice IDs come from
// the caller; for Albus's Jarvis/Friday voice see ALBUS_VOICE_ID in
// lib/config.ts. Network errors propagate; non-2xx responses raise with
// the API's error body included for debugging.
//
// Reference:
//   TTS  POST /v1/text-to-speech/{voice_id}
//   STT  POST /v1/speech-to-text (multipart, file + model_id=scribe_v1)

import { readFileSync } from "node:fs";
import { Buffer } from "node:buffer";

const TTS_BASE = "https://api.elevenlabs.io/v1/text-to-speech";
const STT_URL = "https://api.elevenlabs.io/v1/speech-to-text";

export interface SynthesizeOptions {
  voiceId: string;
  // ElevenLabs model. eleven_turbo_v2_5 is fast + cheap + multilingual.
  // eleven_multilingual_v2 is higher quality but slower. Default to turbo.
  modelId?: string;
  // 0.0 (very expressive) to 1.0 (very stable). 0.5 is a balanced default
  // for conversational replies.
  stability?: number;
  // 0.0 (less like the original speaker) to 1.0 (more). 0.75 is the docs default.
  similarityBoost?: number;
  // ElevenLabs output container/codec, passed as the `output_format` query
  // param (the reliable lever on the TTS endpoint). Defaults to mp3 to keep
  // the tts.ts CLI and any mp3 consumers working. Telegram's sendVoice needs
  // OGG/Opus, so the voice-reply path passes "opus_48000_64".
  // See: https://elevenlabs.io/docs/api-reference/text-to-speech
  outputFormat?: string;
}

// Map an ElevenLabs output_format to the HTTP Accept mime type. Opus formats
// ship as an OGG/Opus container (audio/ogg); everything else here is mp3.
function acceptForFormat(format: string): string {
  return format.startsWith("opus") ? "audio/ogg" : "audio/mpeg";
}

export async function synthesizeSpeech(
  text: string,
  opts: SynthesizeOptions
): Promise<Buffer> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    throw new Error("ELEVENLABS_API_KEY not in env");
  }
  if (!opts.voiceId) {
    throw new Error("synthesizeSpeech: voiceId is required");
  }
  if (!text || !text.trim()) {
    throw new Error("synthesizeSpeech: text is required");
  }
  const outputFormat = opts.outputFormat ?? "mp3_44100_128";
  const body = {
    text,
    model_id: opts.modelId ?? "eleven_turbo_v2_5",
    voice_settings: {
      stability: opts.stability ?? 0.5,
      similarity_boost: opts.similarityBoost ?? 0.75,
    },
  };
  const url = `${TTS_BASE}/${opts.voiceId}?output_format=${encodeURIComponent(outputFormat)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
      "Content-Type": "application/json",
      Accept: acceptForFormat(outputFormat),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`elevenlabs TTS ${res.status}: ${errBody.slice(0, 300)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

export interface TranscribeResult {
  text: string;
  languageCode?: string;
  durationSecs?: number;
}

export async function transcribeAudio(filePath: string): Promise<TranscribeResult> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    throw new Error("ELEVENLABS_API_KEY not in env");
  }
  const buf = readFileSync(filePath);
  const fname = filePath.split("/").pop() || "audio.ogg";
  const form = new FormData();
  form.append("file", new Blob([buf]), fname);
  form.append("model_id", "scribe_v1");
  const res = await fetch(STT_URL, {
    method: "POST",
    headers: { "xi-api-key": apiKey },
    body: form,
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`elevenlabs STT ${res.status}: ${errBody.slice(0, 300)}`);
  }
  const data = (await res.json()) as {
    text?: string;
    language_code?: string;
    duration_secs?: number;
  };
  return {
    text: data.text ?? "",
    languageCode: data.language_code,
    durationSecs: data.duration_secs,
  };
}
