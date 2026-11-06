/**
 * The model PureStrings asks for words: turning "coffee, up to $20 a week" into an allowance's limits, and drafting
 * a dispute for a charge nobody signed. NVIDIA's Nemotron on Nebius Token Factory with NEBIUS_API_KEY, or any
 * OpenAI-style chat API with MODEL_URL and MODEL. A model only ever writes words: what's paid is what your key signs.
 */

export const TOKEN_FACTORY_URL = "https://api.tokenfactory.nebius.com/v1";
/** Nemotron 3.5 Super: careful writing, quick enough with its thinking off. */
export const NEMOTRON = "nvidia/Nemotron-3.5-Super-VL";

export interface Model {
  /** The model's name, to show. */
  readonly name: string;
  /** One answer to a system prompt and a message; throws when the model doesn't give one. */
  ask(system: string, user: string, options?: { readonly maxTokens?: number; readonly temperature?: number }): Promise<string>;
}

export function chatModel(options: { readonly url: string; readonly model: string; readonly key?: string; readonly fetcher?: typeof fetch }): Model {
  const fetcher = options.fetcher ?? globalThis.fetch;
  const endpoint = /\/chat\/completions\/?$/.test(options.url) ? options.url : `${options.url.replace(/\/$/, "")}/chat/completions`;
  // Nemotron thinks before it answers unless told not to; these are short jobs, so it doesn't.
  const quick = new URL(endpoint).hostname === new URL(TOKEN_FACTORY_URL).hostname ? { chat_template_kwargs: { enable_thinking: false } } : {};
  const hide = (said: string) => (options.key ? said.replaceAll(options.key, "[key]") : said);
  return {
    name: options.model,
    async ask(system, user, { maxTokens = 300, temperature = 0 } = {}) {
      const response = await fetcher(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", ...(options.key ? { authorization: `Bearer ${options.key}` } : {}) },
        body: JSON.stringify({ model: options.model, messages: [{ role: "system", content: system }, { role: "user", content: user }], temperature, max_tokens: maxTokens, ...quick }),
        signal: AbortSignal.timeout(30_000),
      });
      const body = (await response.json().catch(() => null)) as { choices?: { message?: { content?: unknown } }[]; error?: { message?: string } } | null;
      if (!response.ok) throw new Error(`The model said: ${hide(body?.error?.message ?? `HTTP ${response.status}`)}`);
      const content = body?.choices?.[0]?.message?.content;
      if (typeof content !== "string" || !content.trim()) throw new Error("The model sent an empty answer.");
      return content.trim();
    },
  };
}

/** The model the environment sets up: MODEL_URL and MODEL (with MODEL_KEY when it takes one), else Nemotron with NEBIUS_API_KEY; none without. */
export function modelFromEnv(env: NodeJS.ProcessEnv, fetcher?: typeof fetch): Model | null {
  const url = env.MODEL_URL?.trim();
  const model = env.MODEL?.trim();
  const reach = fetcher ? { fetcher } : {};
  if (url && model) return chatModel({ url, model, ...(env.MODEL_KEY?.trim() ? { key: env.MODEL_KEY.trim() } : {}), ...reach });
  const nebius = env.NEBIUS_API_KEY?.trim();
  return nebius ? chatModel({ url: TOKEN_FACTORY_URL, model: model || NEMOTRON, key: nebius, ...reach }) : null;
}

/** The JSON object in a model's answer, fenced or not. */
export function jsonIn(reply: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(reply)?.[1] ?? reply;
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("The model didn't answer with JSON.");
  try {
    return JSON.parse(fenced.slice(start, end + 1));
  } catch {
    throw new Error("The model's answer wasn't valid JSON.");
  }
}
