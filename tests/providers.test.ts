import { describe, expect, it } from "vitest";
import { tryParseJson, selectProvider } from "../worker/providers.ts";

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
});
