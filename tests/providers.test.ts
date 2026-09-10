import { describe, expect, it } from "vitest";
import http from "node:http";
import { tryParseJson, selectProvider, checkHealth, chat, providerFor } from "../worker/providers.ts";
import type { ModelConfig } from "../worker/providers.ts";

describe("providers", () => {
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
});
