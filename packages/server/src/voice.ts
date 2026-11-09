/**
 * A voice for the PureStrings button: OpenAI's speech model turns what the key says into sound, which PureStrings
 * streams to the button's speaker. Raw 16-bit mono PCM at 24 kHz, the rate the button plays. Only words go to the
 * model, never a key or a signature; what's paid is still only what the key signs.
 */

export const VOICE_RATE = 24_000;
export const SPEECH_MODEL = "gpt-4o-mini-tts";

export interface Voice {
  /** The model's name, to show. */
  readonly name: string;
  /**
   * The words as sound, piece by piece as the model makes them, so the button starts speaking within a second:
   * 16-bit little-endian mono PCM at VOICE_RATE, whole samples. Throws when the model doesn't answer.
   */
  speak(text: string): AsyncIterable<Uint8Array>;
}

export function openAiVoice(options: { readonly key: string; readonly url?: string; readonly model?: string; readonly voice?: string; readonly fetcher?: typeof fetch }): Voice {
  const fetcher = options.fetcher ?? globalThis.fetch;
  const model = options.model ?? SPEECH_MODEL;
  const endpoint = `${(options.url ?? "https://api.openai.com/v1").replace(/\/$/, "")}/audio/speech`;
  return {
    name: model,
    async *speak(text) {
      const response = await fetcher(endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${options.key}`, "content-type": "application/json" },
        body: JSON.stringify({
          model,
          voice: options.voice ?? "alloy",
          input: text.slice(0, 1_000),
          response_format: "pcm",
          instructions: "Calm, clear and quick, like a careful cashier reading back an order. Say amounts plainly.",
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        const said = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(`The voice said: ${(said?.error?.message ?? `HTTP ${response.status}`).replaceAll(options.key, "[key]")}`);
      }
      if (!response.body) return yield evenOf(new Uint8Array(await response.arrayBuffer()));
      // A piece can end halfway through a sample: its last byte waits for the next piece.
      let half: number | undefined;
      for await (const piece of response.body) {
        let bytes: Uint8Array = piece;
        if (half !== undefined) {
          bytes = new Uint8Array(piece.length + 1);
          bytes[0] = half;
          bytes.set(piece, 1);
          half = undefined;
        }
        if (bytes.length % 2) half = bytes[bytes.length - 1];
        const whole = evenOf(bytes);
        if (whole.length) yield whole;
      }
    },
  };
}

const evenOf = (bytes: Uint8Array) => bytes.subarray(0, bytes.length - (bytes.length % 2));

/**
 * The voice the environment sets up: OPENAI_API_KEY, or MODEL_KEY when MODEL_URL is OpenAI's; VOICE_MODEL and
 * VOICE pick the model and the voice. None without a key: the button then shows and beeps.
 */
export function voiceFromEnv(env: NodeJS.ProcessEnv, fetcher?: typeof fetch): Voice | null {
  const openAiUrl = env.MODEL_URL?.trim() && /(^|\.)openai\.com/.test(new URL(env.MODEL_URL.trim()).hostname) ? env.MODEL_URL.trim() : undefined;
  const key = env.OPENAI_API_KEY?.trim() || (openAiUrl ? env.MODEL_KEY?.trim() : undefined);
  if (!key || env.VOICE?.trim() === "off") return null;
  return openAiVoice({ key, ...(openAiUrl ? { url: openAiUrl } : {}), ...(env.VOICE_MODEL?.trim() ? { model: env.VOICE_MODEL.trim() } : {}), ...(env.VOICE?.trim() ? { voice: env.VOICE.trim() } : {}), ...(fetcher ? { fetcher } : {}) });
}
