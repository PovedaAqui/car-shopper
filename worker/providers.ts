/**
 * ModelProvider abstraction (plan §7.1).
 *
 * One common interface over OpenAI-compatible local endpoints:
 *  - vLLM  (http://localhost:8000/v1) — default for this hackathon build
 *  - Ollama  (http://localhost:11434/v1) — optional, health-gated
 *  - LM Studio (http://localhost:1234/v1) — optional, health-gated
 *
 * No daemon is required to run the worker: providers are discovered by
 * health check, and the pipeline degrades to `no_evaluable` results when the
 * configured model is unavailable (local_inference_only mode).
 *
 * Typed errors: unsupported_vision | invalid_json | timeout |
 *                out_of_memory | model_unavailable | http_error
 */

export type ProviderKind = "vllm" | "ollama" | "lmstudio" | "openai_compat";

export interface ModelConfig {
  provider: ProviderKind;
  baseUrl: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  /** Separate (longer) timeout for the first request / cold start. */
  startTimeoutMs?: number;
  timeoutMs?: number;
  /** vLLM: disable thinking so content isn't eaten by reasoning tokens. */
  disableThinking?: boolean;
  /** Whether this endpoint can take image inputs. */
  visionCapable?: boolean;
  apiKey?: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string | Array<ContentPart>;
}

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface ChatResult {
  content: string | null;
  /** Present when the model emitted reasoning (Qwen3 thinking) instead of content. */
  reasoning?: string;
  finishReason: string;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs: number;
}

export type ProviderErrorKind =
  | "unsupported_vision"
  | "invalid_json"
  | "timeout"
  | "out_of_memory"
  | "model_unavailable"
  | "http_error"
  | "not_configured";

export class ProviderError extends Error {
  constructor(
    public readonly kind: ProviderErrorKind,
    message: string
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export interface Health {
  ok: boolean;
  baseUrl: string;
  model: string;
  detail?: string;
}

const DEFAULT_TIMEOUT = 120_000;
const DEFAULT_START_TIMEOUT = 300_000;

/** True for localhost/private endpoints (vLLM, Ollama, LM Studio). */
function isLocalEndpoint(baseUrl: string): boolean {
  try {
    const h = new URL(baseUrl).hostname;
    return (
      h === "localhost" ||
      h === "127.0.0.1" ||
      h === "0.0.0.0" ||
      h === "::1" ||
      /^192\.168\./.test(h) ||
      /^10\./.test(h) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(h)
    );
  } catch {
    return false;
  }
}

/**
 * Resolve the provider kind for a vision endpoint. Explicit env wins;
 * otherwise infer from the host: local hosts default to vLLM (which accepts
 * vLLM-specific args like `chat_template_kwargs`), remote OpenAI-compatible
 * APIs (e.g. api.openai.com) must be treated as strict `openai_compat` or
 * they reject unknown body fields with HTTP 400.
 */
export function providerFor(baseUrl: string, explicit?: string): ProviderKind {
  if (explicit) return explicit as ProviderKind;
  return isLocalEndpoint(baseUrl) ? "vllm" : "openai_compat";
}

export function defaultModels(): {
  extraction: ModelConfig;
  visionPrimary: ModelConfig;
  visionFallback: ModelConfig | null;
} {
  const base = process.env.MODEL_BASE_URL ?? "http://localhost:8000/v1";
  const model = process.env.MODEL_NAME ?? "qwen38-27b-unsloth-nvfp4-dflash2";
  const vBase = process.env.VISION_PRIMARY_BASE_URL ?? base;
  const vModel = process.env.VISION_PRIMARY_MODEL ?? model;
  return {
    extraction: {
      provider: providerFor(base, process.env.MODEL_PROVIDER),
      baseUrl: base,
      model,
      temperature: 0,
      maxTokens: 2048,
      disableThinking: true,
      visionCapable: false,
    },
    visionPrimary: {
      provider: providerFor(vBase, process.env.VISION_PRIMARY_PROVIDER),
      baseUrl: vBase,
      model: vModel,
      temperature: 0,
      maxTokens: 2048,
      disableThinking: true,
      visionCapable: process.env.MODEL_IS_VISION === "1",
      apiKey: process.env.VISION_PRIMARY_API_KEY,
    },
    visionFallback: openaiVisionFallback(),
  };
}

/**
 * Optional cloud vision fallback (OpenAI). Only built when OPENAI_API_KEY is
 * set — used exclusively in VISION_MODE=local_preferred when the local model
 * is unhealthy or is not vision-capable. Never used silently in
 * local_inference_only mode (no cloud egress in that mode).
 */
function openaiVisionFallback(): ModelConfig | null {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  return {
    provider: "openai_compat",
    baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
    model: process.env.OPENAI_VISION_MODEL ?? "gpt-4o-mini",
    temperature: 0,
    maxTokens: 2048,
    visionCapable: true,
    apiKey,
  };
}

function timeoutSignal(ms: number): AbortSignal {
  const c = new AbortController();
  setTimeout(() => c.abort(), ms).unref?.();
  return c.signal;
}

/** GET {baseUrl}/models — health check + model discovery. */
export async function checkHealth(cfg: ModelConfig): Promise<Health> {
  const url = `${cfg.baseUrl.replace(/\/$/, "")}/models`;
  try {
    const res = await fetch(url, {
      signal: timeoutSignal(cfg.startTimeoutMs ?? DEFAULT_START_TIMEOUT),
      headers: cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {},
    });
    if (!res.ok) return { ok: false, baseUrl: cfg.baseUrl, model: cfg.model, detail: `HTTP ${res.status}` };
    const data: any = await res.json();
    const ids: string[] = (data?.data ?? []).map((m: any) => m.id ?? m.name).filter(Boolean);
    if (ids.length > 0 && !ids.includes(cfg.model)) {
      return { ok: false, baseUrl: cfg.baseUrl, model: cfg.model, detail: `model not served; available: ${ids.join(", ")}` };
    }
    return { ok: true, baseUrl: cfg.baseUrl, model: cfg.model, detail: `served models: ${ids.join(", ")}` };
  } catch (e: any) {
    return { ok: false, baseUrl: cfg.baseUrl, model: cfg.model, detail: e?.message ?? "unreachable" };
  }
}

/**
 * Chat completion. Handles the Qwen3 reasoning-token pitfall: when
 * `content` is null and reasoning was emitted (finish_reason length), we
 * either retry with thinking disabled (vLLM chat_template_kwargs) or the
 * caller receives `content: null` and must mark the result `no_evaluable`.
 */
export async function chat(cfg: ModelConfig, messages: ChatMessage[], opts?: { maxTokens?: number }): Promise<ChatResult> {
  const body: Record<string, unknown> = {
    model: cfg.model,
    messages,
    temperature: cfg.temperature ?? 0,
    max_tokens: opts?.maxTokens ?? cfg.maxTokens ?? 2048,
  };
  if (cfg.disableThinking && cfg.provider === "vllm") {
    // vLLM-only knob: OpenAI-compatible endpoints reject unknown arguments.
    body.chat_template_kwargs = { enable_thinking: false };
  }
  const doRequest = async (b: Record<string, unknown>): Promise<ChatResult> => {
    const started = Date.now();
    let res: Response;
    try {
      res = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}),
        },
        body: JSON.stringify(b),
        signal: timeoutSignal(cfg.timeoutMs ?? DEFAULT_TIMEOUT),
      });
    } catch (e: any) {
      if (e?.name === "AbortError") throw new ProviderError("timeout", `request timed out after ${cfg.timeoutMs ?? DEFAULT_TIMEOUT}ms`);
      throw new ProviderError("model_unavailable", `endpoint unreachable: ${e?.message ?? e}`);
    }
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const lower = text.toLowerCase();
      if (lower.includes("out of memory") || lower.includes("cuda oom")) {
        throw new ProviderError("out_of_memory", text.slice(0, 200));
      }
      if (res.status === 404 && lower.includes("model")) {
        throw new ProviderError("model_unavailable", text.slice(0, 200));
      }
      if (res.status === 415 || lower.includes("image") && lower.includes("not supported")) {
        throw new ProviderError("unsupported_vision", text.slice(0, 200));
      }
      throw new ProviderError("http_error", `HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    const data: any = await res.json();
    const choice = data?.choices?.[0];
    const msg = choice?.message ?? {};
    return {
      content: msg.content ?? null,
      reasoning: msg.reasoning ?? undefined,
      finishReason: choice?.finish_reason ?? "unknown",
      inputTokens: data?.usage?.prompt_tokens,
      outputTokens: data?.usage?.completion_tokens,
      latencyMs,
    };
  };

  let first = await doRequest(body);
  if (first.content === null) {
    // Reasoning-token pitfall: retry once with thinking disabled.
    if (!body.chat_template_kwargs) {
      const retry = await doRequest({ ...body, chat_template_kwargs: { enable_thinking: false }, max_tokens: Math.max((opts?.maxTokens ?? cfg.maxTokens ?? 2048), 2048) });
      if (retry.content !== null) return retry;
    }
    return first; // caller marks no_evaluable
  }
  return first;
}

/**
 * Structured JSON: run chat, parse the first JSON object in the response,
 * retry once with the parse error appended (plan §7). Returns `null` when the
 * model cannot produce valid JSON — the pipeline must mark `no_evaluable`,
 * never invent data.
 */
export async function chatJson<T>(
  cfg: ModelConfig,
  system: string,
  user: string | ContentPart[],
  opts?: { maxTokens?: number; schemaHint?: string }
): Promise<{ value: T | null; raw: string; result: ChatResult; error?: string }> {
  const schemaNote = opts?.schemaHint
    ? `\nRespond with ONLY a JSON object matching: ${opts.schemaHint}. No prose outside the JSON.`
    : "\nRespond with ONLY a valid JSON object. No prose outside the JSON.";
  const messages: ChatMessage[] = [
    { role: "system", content: system + schemaNote },
    { role: "user", content: user },
  ];
  let result = await chat(cfg, messages, opts);
  let parsed = tryParseJson<T>(result.content ?? "");
  let error: string | undefined;
  if (parsed === null && result.content !== null) {
    error = "Response was not valid JSON. Fix the JSON and respond again with ONLY the JSON object.";
    result = await chat(cfg, [
      ...messages,
      { role: "assistant", content: result.content ?? "" },
      { role: "user", content: error },
    ], opts);
    parsed = tryParseJson<T>(result.content ?? "");
    if (parsed === null) error = "Second attempt still not valid JSON.";
  }
  if (result.content === null) {
    error = "Model returned no content (reasoning-token exhaustion or unsupported vision).";
  }
  return { value: parsed, raw: result.content ?? result.reasoning ?? "", result, error };
}

export function tryParseJson<T>(text: string): T | null {
  if (!text) return null;
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  const candidates = [cleaned];
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (m) candidates.push(m[0]);
  for (const c of candidates) {
    try {
      return JSON.parse(c) as T;
    } catch {
      // try next
    }
  }
  return null;
}

/**
 * Provider router (plan §7 local-first): try the local provider first;
 * fallback to an approved cloud provider only in `local_preferred` mode and
 * only when explicitly configured. Records which provider served the call.
 */
export interface RouterDecision {
  provider: ProviderKind;
  baseUrl: string;
  model: string;
  fallbackUsed: boolean;
  fallbackReason?: string;
}

export function selectProvider(
  mode: "local_inference_only" | "local_preferred",
  local: ModelConfig,
  localHealthy: Health,
  cloud: ModelConfig | null,
  requireVision = false
): { cfg: ModelConfig | null; decision: RouterDecision | null } {
  const localUsable = localHealthy.ok && (!requireVision || local.visionCapable === true);
  if (localUsable) {
    return { cfg: local, decision: { provider: local.provider, baseUrl: local.baseUrl, model: local.model, fallbackUsed: false } };
  }
  if (mode === "local_preferred" && cloud) {
    const reason = !localHealthy.ok
      ? (localHealthy.detail ?? "local model unavailable")
      : "local model is not vision-capable (set MODEL_IS_VISION=1 if it is)";
    return {
      cfg: cloud,
      decision: {
        provider: cloud.provider,
        baseUrl: cloud.baseUrl,
        model: cloud.model,
        fallbackUsed: true,
        fallbackReason: reason,
      },
    };
  }
  return { cfg: null, decision: null };
}
