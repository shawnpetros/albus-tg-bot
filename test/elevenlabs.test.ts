import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Capture and restore the env + global fetch so tests don't leak.
let origFetch: typeof globalThis.fetch;
let origKey: string | undefined;
let tmpDir: string;

beforeEach(() => {
  origFetch = globalThis.fetch;
  origKey = process.env.ELEVENLABS_API_KEY;
  tmpDir = mkdtempSync(join(tmpdir(), "albus-11l-"));
});

afterEach(() => {
  globalThis.fetch = origFetch;
  if (origKey === undefined) delete process.env.ELEVENLABS_API_KEY;
  else process.env.ELEVENLABS_API_KEY = origKey;
  rmSync(tmpDir, { recursive: true, force: true });
});

// Import is dynamic so we can re-import after mutating env, though Bun does
// module-caching just like Node so the import is hoisted once. Tests rely on
// process.env reads inside the functions themselves rather than at top-level.
import { synthesizeSpeech, transcribeAudio } from "../lib/elevenlabs.ts";

describe("synthesizeSpeech - input validation", () => {
  test("throws when ELEVENLABS_API_KEY not set", async () => {
    delete process.env.ELEVENLABS_API_KEY;
    await expect(
      synthesizeSpeech("hi", { voiceId: "v1" })
    ).rejects.toThrow(/ELEVENLABS_API_KEY/);
  });

  test("throws when voiceId is empty", async () => {
    process.env.ELEVENLABS_API_KEY = "sk_test_dummy";
    await expect(
      synthesizeSpeech("hi", { voiceId: "" })
    ).rejects.toThrow(/voiceId/);
  });

  test("throws when text is empty", async () => {
    process.env.ELEVENLABS_API_KEY = "sk_test_dummy";
    await expect(
      synthesizeSpeech("   ", { voiceId: "v1" })
    ).rejects.toThrow(/text/);
  });
});

describe("synthesizeSpeech - happy path", () => {
  test("returns Buffer with audio bytes from mocked TTS endpoint", async () => {
    process.env.ELEVENLABS_API_KEY = "sk_test_dummy";
    const fake = new Uint8Array([0xff, 0xfb, 0x90, 0x00, 0x68]); // fake mp3 header bytes
    let captured: { url?: string; body?: any; headers?: any } = {};
    globalThis.fetch = (async (input: any, init: any) => {
      captured.url = String(input);
      captured.headers = init?.headers;
      captured.body = init?.body ? JSON.parse(init.body) : null;
      return new Response(fake, { status: 200, headers: { "Content-Type": "audio/mpeg" } });
    }) as unknown as typeof globalThis.fetch;

    const result = await synthesizeSpeech("Hello", { voiceId: "abc123" });

    expect(Buffer.isBuffer(result)).toBe(true);
    expect(result.length).toBe(fake.length);
    // Default output_format is mp3 (keeps tts.ts + mp3 consumers working).
    expect(captured.url).toBe(
      "https://api.elevenlabs.io/v1/text-to-speech/abc123?output_format=mp3_44100_128"
    );
    expect(captured.headers["xi-api-key"]).toBe("sk_test_dummy");
    expect(captured.headers["Accept"]).toBe("audio/mpeg");
    expect(captured.body.text).toBe("Hello");
    expect(captured.body.model_id).toBe("eleven_turbo_v2_5");
    expect(captured.body.voice_settings).toEqual({ stability: 0.5, similarity_boost: 0.75 });
  });

  test("opus outputFormat sets output_format query param and audio/ogg Accept", async () => {
    process.env.ELEVENLABS_API_KEY = "sk_test_dummy";
    let captured: { url?: string; headers?: any } = {};
    globalThis.fetch = (async (input: any, init: any) => {
      captured.url = String(input);
      captured.headers = init?.headers;
      return new Response(new Uint8Array([0x4f, 0x67, 0x67, 0x53]), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    await synthesizeSpeech("Hello", { voiceId: "abc123", outputFormat: "opus_48000_64" });

    expect(captured.url).toBe(
      "https://api.elevenlabs.io/v1/text-to-speech/abc123?output_format=opus_48000_64"
    );
    expect(captured.headers["Accept"]).toBe("audio/ogg");
  });

  test("custom modelId and voice_settings flow through", async () => {
    process.env.ELEVENLABS_API_KEY = "sk_test_dummy";
    let body: any = null;
    globalThis.fetch = (async (_url: any, init: any) => {
      body = init?.body ? JSON.parse(init.body) : null;
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    await synthesizeSpeech("Hi", {
      voiceId: "v",
      modelId: "eleven_multilingual_v2",
      stability: 0.3,
      similarityBoost: 0.9,
    });

    expect(body.model_id).toBe("eleven_multilingual_v2");
    expect(body.voice_settings).toEqual({ stability: 0.3, similarity_boost: 0.9 });
  });
});

describe("synthesizeSpeech - failure mapping", () => {
  test("non-2xx wraps error body into thrown message", async () => {
    process.env.ELEVENLABS_API_KEY = "sk_test_dummy";
    globalThis.fetch = (async () => {
      return new Response('{"detail":"invalid voice"}', { status: 422 });
    }) as unknown as typeof globalThis.fetch;

    await expect(
      synthesizeSpeech("hi", { voiceId: "v" })
    ).rejects.toThrow(/elevenlabs TTS 422.*invalid voice/);
  });
});

describe("transcribeAudio", () => {
  test("throws when ELEVENLABS_API_KEY not set", async () => {
    delete process.env.ELEVENLABS_API_KEY;
    const audio = join(tmpDir, "voice.ogg");
    writeFileSync(audio, Buffer.from([1, 2, 3]));
    await expect(transcribeAudio(audio)).rejects.toThrow(/ELEVENLABS_API_KEY/);
  });

  test("parses text + language + duration from response", async () => {
    process.env.ELEVENLABS_API_KEY = "sk_test_dummy";
    const audio = join(tmpDir, "voice.ogg");
    writeFileSync(audio, Buffer.from([1, 2, 3]));
    let url = "";
    globalThis.fetch = (async (input: any) => {
      url = String(input);
      return new Response(
        JSON.stringify({
          text: "hello there",
          language_code: "en",
          duration_secs: 1.5,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as unknown as typeof globalThis.fetch;

    const out = await transcribeAudio(audio);
    expect(url).toBe("https://api.elevenlabs.io/v1/speech-to-text");
    expect(out.text).toBe("hello there");
    expect(out.languageCode).toBe("en");
    expect(out.durationSecs).toBe(1.5);
  });

  test("missing fields default cleanly", async () => {
    process.env.ELEVENLABS_API_KEY = "sk_test_dummy";
    const audio = join(tmpDir, "voice.ogg");
    writeFileSync(audio, Buffer.from([1, 2, 3]));
    globalThis.fetch = (async () =>
      new Response("{}", { status: 200 })) as unknown as typeof globalThis.fetch;
    const out = await transcribeAudio(audio);
    expect(out.text).toBe("");
    expect(out.languageCode).toBeUndefined();
    expect(out.durationSecs).toBeUndefined();
  });

  test("non-2xx wraps error body into thrown message", async () => {
    process.env.ELEVENLABS_API_KEY = "sk_test_dummy";
    const audio = join(tmpDir, "voice.ogg");
    writeFileSync(audio, Buffer.from([1, 2, 3]));
    globalThis.fetch = (async () =>
      new Response('{"detail":"unsupported audio"}', { status: 415 })) as unknown as typeof globalThis.fetch;
    await expect(transcribeAudio(audio)).rejects.toThrow(
      /elevenlabs STT 415.*unsupported audio/
    );
  });
});
