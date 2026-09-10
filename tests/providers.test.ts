import { describe, expect, it, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { tryParseJson, selectProvider, checkHealth, chat, providerFor, defaultModels } from "../worker/providers.ts";
import type { ModelConfig } from "../worker/providers.ts";

const VISION_ENV_KEYS = [
  "VISION_PROVIDER",
  "TEXT_PROVIDER",
  "OPENAI_API_KEY",
  "OPENAI_VISION_MODEL",
  "OPENAI_TEXT_MODEL",
  "OPENAI_BASE_URL",
  "MODEL_BASE_URL",
  "MODEL_NAME",
  "MODEL_IS_VISION",
  "VISION_PRIMARY_BASE_URL",
  "VISION_PRIMARY_MODEL",
  "VISION_PRIMARY_PROVIDER",
];
let savedEnv: Record<string, string | undefined>;

describe("providers", () => {
  beforeEach(() => {
    savedEnv = {};
    for (const k of VISION_ENV_KEYS) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of VISION_ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  it("parses fenced JSON", () => {
    expect(tryParseJson<{ a: number }>("```json\n{\"a\":1}\n```")).toEqual({ a: 1 });
  });

  it("does not fall back to cloud in local_inference_only", () => {
    const decision = selectProvider(
      "local_inference_only",
      { provider: "vllm", baseUrl: "http://localhost:8000/v1", model: "local" },
      { ok: false, baseUrl: "http://localhost:8000/v1", model: "local", detail: "down" },
      { provider: "openai_compat", baseUrl: "https://api.openai.com/v1", model: "cloud" }
    );
    expect(decision.cfg).toBeNull();
  });

  it("records fallback reason in local_preferred", () => {
    const decision = selectProvider(
      "local_preferred",
      { provider: "vllm", baseUrl: "http://localhost:8000/v1", model: "local" },
      { ok: false, baseUrl: "http://localhost:8000/v1", model: "local", detail: "oom" },
      { provider: "openai_compat", baseUrl: "https://api.openai.com/v1", model: "cloud" }
    );
    expect(decision.cfg?.model).toBe("cloud");
    expect(decision.decision?.fallbackUsed).toBe(true);
    expect(decision.decision?.fallbackReason).toBe("oom");
  });

  it("stays on a healthy but non-vision local model when requireVision is not set", () => {
    const decision = selectProvider(
      "local_preferred",
      { provider: "vllm", baseUrl: "http://localhost:8000/v1", model: "local-text", visionCapable: false },
      { ok: true, baseUrl: "http://localhost:8000/v1", model: "local-text" },
      { provider: "openai_compat", baseUrl: "https://api.openai.com/v1", model: "cloud-vision", visionCapable: true }
    );
    expect(decision.cfg?.model).toBe("local-text");
    expect(decision.decision?.fallbackUsed).toBe(false);
  });

  it("falls back to cloud vision when the local model is healthy but not vision-capable and requireVision=true", () => {
    const decision = selectProvider(
      "local_preferred",
      { provider: "vllm", baseUrl: "http://localhost:8000/v1", model: "local-text", visionCapable: false },
      { ok: true, baseUrl: "http://localhost:8000/v1", model: "local-text" },
      { provider: "openai_compat", baseUrl: "https://api.openai.com/v1", model: "cloud-vision", visionCapable: true },
      /* requireVision */ true
    );
    expect(decision.cfg?.model).toBe("cloud-vision");
    expect(decision.decision?.fallbackUsed).toBe(true);
    expect(decision.decision?.fallbackReason).toMatch(/not vision-capable/);
  });

  it("does not fall back to vision-only cloud when local_inference_only, even with requireVision", () => {
    const decision = selectProvider(
      "local_inference_only",
      { provider: "vllm", baseUrl: "http://localhost:8000/v1", model: "local-text", visionCapable: false },
      { ok: true, baseUrl: "http://localhost:8000/v1", model: "local-text" },
      { provider: "openai_compat", baseUrl: "https://api.openai.com/v1", model: "cloud-vision", visionCapable: true },
      /* requireVision */ true
    );
    expect(decision.cfg).toBeNull();
  });

  it("providerFor: local endpoints infer vllm, remote APIs infer openai_compat, explicit wins", () => {
    expect(providerFor("http://localhost:8000/v1")).toBe("vllm");
    expect(providerFor("http://127.0.0.1:11434/v1")).toBe("vllm");
    expect(providerFor("http://192.168.1.50:8000/v1")).toBe("vllm");
    expect(providerFor("https://api.openai.com/v1")).toBe("openai_compat");
    expect(providerFor("https://openrouter.ai/api/v1")).toBe("openai_compat");
    // explicit env overrides the inference
    expect(providerFor("https://api.openai.com/v1", "vllm")).toBe("vllm");
    expect(providerFor("http://localhost:8000/v1", "ollama")).toBe("ollama");
  });

  it("checkHealth sends the auth header when an API key is configured", async () => {
    let seenAuth: string | null = null;
    const server = http.createServer((req, res) => {
      seenAuth = req.headers.authorization ?? null;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "the-model" }] }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as any).port;
    try {
      const health = await checkHealth({
        provider: "openai_compat",
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: "the-model",
        apiKey: "test-secret-key",
      });
      expect(health.ok).toBe(true);
      expect(seenAuth).toBe("Bearer test-secret-key");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("chat: vllm sends chat_template_kwargs (disableThinking); openai_compat must not", async () => {
    const bodies: any[] = [];
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        bodies.push(JSON.parse(raw || "{}"));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          })
        );
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as any).port;
    const base: Omit<ModelConfig, "provider"> = {
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: "m",
      temperature: 0,
      maxTokens: 100,
      disableThinking: true,
      timeoutMs: 5000,
    };
    try {
      await chat({ provider: "vllm", ...base }, [{ role: "user", content: "hi" }]);
      expect(bodies[0].chat_template_kwargs).toEqual({ enable_thinking: false });
      await chat({ provider: "openai_compat", ...base }, [{ role: "user", content: "hi" }]);
      // Regression: OpenAI rejects this unknown body field with HTTP 400.
      expect(bodies[1].chat_template_kwargs).toBeUndefined();
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("defaultModels: OpenAI is primary by default when OPENAI_API_KEY is set", () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const { visionPrimary, visionFallback } = defaultModels();
    expect(visionPrimary.provider).toBe("openai_compat");
    expect(visionPrimary.model).toBe("gpt-4o-mini");
    expect(visionPrimary.visionCapable).toBe(true);
    expect(visionFallback?.provider).toBe("vllm"); // local becomes the secondary
  });

  it("defaultModels: degrades to local as primary when OPENAI_API_KEY is unset (no VISION_PROVIDER override)", () => {
    const { visionPrimary, visionFallback } = defaultModels();
    expect(visionPrimary.provider).toBe("vllm");
    expect(visionFallback).toBeNull(); // nothing to fall back to without a key
  });

  it("defaultModels: VISION_PROVIDER=local makes local primary even with a valid OPENAI_API_KEY", () => {
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.VISION_PROVIDER = "local";
    process.env.MODEL_IS_VISION = "1";
    const { visionPrimary, visionFallback } = defaultModels();
    expect(visionPrimary.provider).toBe("vllm");
    expect(visionPrimary.visionCapable).toBe(true);
    expect(visionFallback?.provider).toBe("openai_compat"); // openai becomes the secondary
  });

  it("defaultModels: extraction (text) is OpenAI by default when OPENAI_API_KEY is set", () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const { extraction } = defaultModels();
    expect(extraction.provider).toBe("openai_compat");
    expect(extraction.model).toBe("gpt-4o-mini");
    expect(extraction.visionCapable).toBe(false);
  });

  it("defaultModels: extraction degrades to local when OPENAI_API_KEY is unset", () => {
    const { extraction } = defaultModels();
    expect(extraction.provider).toBe("vllm");
  });

  it("defaultModels: TEXT_PROVIDER=local keeps extraction local even with a valid OPENAI_API_KEY", () => {
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.TEXT_PROVIDER = "local";
    const { extraction } = defaultModels();
    expect(extraction.provider).toBe("vllm");
  });
});
