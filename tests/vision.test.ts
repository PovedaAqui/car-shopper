import { describe, expect, it } from "vitest";
import http from "node:http";
import { runVision, defaultMaxPhotosPerCar } from "../worker/vision.ts";
import type { ModelConfig, Health } from "../worker/providers.ts";
import type { RawListing } from "../worker/scrape.ts";

function listing(adId: string, photos: string[]): RawListing {
  return {
    source: "firecrawl",
    adId,
    sourceUrl: `https://example.test/${adId}`,
    title: `Test ${adId}`,
    price: 3000,
    km: 100000,
    hasWarranty: false,
    isPro: false,
    photoCount: photos.length,
    photoUrls: photos,
    dataQualityFlag: "ok",
    fetchedAt: 1,
  };
}

const PHOTOS = ["https://img.test/1.jpg", "https://img.test/2.jpg", "https://img.test/3.jpg"];

function mockCfg(port: number): ModelConfig {
  return {
    provider: "vllm",
    baseUrl: `http://127.0.0.1:${port}/v1`,
    model: "mock-vision",
    temperature: 0,
    maxTokens: 512,
    visionCapable: true,
    timeoutMs: 5000,
    startTimeoutMs: 5000,
  };
}

/** Tiny OpenAI-compatible server: returns strict JSON; records request bodies. */
async function startServer(photosAnalyzed: number): Promise<{ port: number; bodies: any[]; close: () => Promise<void> }> {
  const bodies: any[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      bodies.push(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  photos_analyzed: photosAnalyzed,
                  photo_type: "amateur",
                  exterior_state: "regular",
                  interior_state: "no_evaluable",
                  cleanliness: "limpio",
                  color: "gris",
                  red_flags: [],
                }),
              },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 10 },
        })
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as any).port;
  return { port, bodies, close: () => new Promise((r) => server.close(() => r())) };
}

const healthy: Health = { ok: true, baseUrl: "http://127.0.0.1", model: "mock-vision" };

describe("runVision maxPhotos", () => {
  it("maxPhotos=0 disables vision: honest no_evaluable, no model call, no sin_fotos", async () => {
    const server = await startServer(3);
    try {
      const out = await runVision([listing("a1", PHOTOS), listing("a2", [])], mockCfg(server.port), healthy, "local_inference_only", 0);
      expect(server.bodies).toHaveLength(0); // no network call at all
      for (const r of out.primary) {
        expect(r.exteriorState).toBe("no_evaluable");
        expect(r.noEvaluableReason).toBe("inspección visual desactivada por configuración");
        expect(r.photosAnalyzed).toBe(0);
      }
      // a1 has photos -> not "sin_fotos"; a2 has none -> "sin_fotos"
      const a1 = out.primary.find((r) => r.adId === "a1")!;
      const a2 = out.primary.find((r) => r.adId === "a2")!;
      expect(a1.photoType).toBeUndefined();
      expect(a2.photoType).toBe("sin_fotos");
    } finally {
      await server.close();
    }
  });

  it("maxPhotos=1 caps the photo set sent to the model", async () => {
    const server = await startServer(3);
    try {
      const out = await runVision([listing("a1", PHOTOS)], mockCfg(server.port), healthy, "local_inference_only", 1);
      const primaryCall = server.bodies[0];
      const images = primaryCall.messages[1].content.filter((p: any) => p.type === "image_url");
      expect(images).toHaveLength(1);
      expect(out.primary[0].photosAnalyzed).toBe(1); // capped even though model claims 3
      expect(out.primary[0].exteriorState).toBe("regular");
    } finally {
      await server.close();
    }
  });

  it("default (undefined) uses the configured MAX_PHOTOS_PER_CAR (default 1) cap", async () => {
    const server = await startServer(3);
    try {
      const out = await runVision([listing("a1", PHOTOS)], mockCfg(server.port), healthy, "local_inference_only");
      const images = server.bodies[0].messages[1].content.filter((p: any) => p.type === "image_url");
      expect(images).toHaveLength(1);
      expect(out.primary[0].photosAnalyzed).toBe(1);
    } finally {
      await server.close();
    }
  });

  it("defaultMaxPhotosPerCar: falls back to 1 when VISION_MAX_PHOTOS_PER_CAR is unset/invalid", () => {
    const saved = process.env.VISION_MAX_PHOTOS_PER_CAR;
    try {
      delete process.env.VISION_MAX_PHOTOS_PER_CAR;
      expect(defaultMaxPhotosPerCar()).toBe(1);
      process.env.VISION_MAX_PHOTOS_PER_CAR = "not-a-number";
      expect(defaultMaxPhotosPerCar()).toBe(1);
    } finally {
      if (saved === undefined) delete process.env.VISION_MAX_PHOTOS_PER_CAR;
      else process.env.VISION_MAX_PHOTOS_PER_CAR = saved;
    }
  });

  it("VISION_MAX_PHOTOS_PER_CAR overrides the default cap used by runVision", async () => {
    const saved = process.env.VISION_MAX_PHOTOS_PER_CAR;
    process.env.VISION_MAX_PHOTOS_PER_CAR = "2";
    const server = await startServer(3);
    try {
      expect(defaultMaxPhotosPerCar()).toBe(2);
      const out = await runVision([listing("a1", PHOTOS)], mockCfg(server.port), healthy, "local_inference_only");
      const images = server.bodies[0].messages[1].content.filter((p: any) => p.type === "image_url");
      expect(images).toHaveLength(2);
      expect(out.primary[0].photosAnalyzed).toBe(2);
    } finally {
      await server.close();
      if (saved === undefined) delete process.env.VISION_MAX_PHOTOS_PER_CAR;
      else process.env.VISION_MAX_PHOTOS_PER_CAR = saved;
    }
  });

  it("maxPhotos larger than available sends all photos", async () => {
    const server = await startServer(3);
    try {
      const out = await runVision([listing("a1", PHOTOS)], mockCfg(server.port), healthy, "local_inference_only", 10);
      const images = server.bodies[0].messages[1].content.filter((p: any) => p.type === "image_url");
      expect(images).toHaveLength(3);
      expect(out.primary[0].photosAnalyzed).toBe(3);
    } finally {
      await server.close();
    }
  });

  it("v4 prompt: never sends price (avoids anchoring 'cheap = worse'), only km/year", async () => {
    const server = await startServer(3);
    try {
      await runVision([listing("a1", PHOTOS)], mockCfg(server.port), healthy, "local_inference_only", 1);
      const sentText = server.bodies[0].messages[1].content.find((p: any) => p.type === "text").text as string;
      expect(sentText).not.toMatch(/EUR|€|price/i);
      expect(sentText).toMatch(/km/i);
    } finally {
      await server.close();
    }
  });

  it("v4 prompt: reverify pass explicitly frames itself as an independent second read, primary as the first", async () => {
    const server = await startServer(3);
    try {
      const out = await runVision([listing("a1", PHOTOS)], mockCfg(server.port), healthy, "local_inference_only", 1);
      expect(out.primary[0].promptVersion).toBe("vision-v4");
      const primarySystem = server.bodies[0].messages[0].content as string;
      const reverifySystem = server.bodies[1].messages[0].content as string;
      expect(primarySystem).toMatch(/first independent read/i);
      expect(reverifySystem).toMatch(/independent second read/i);
      expect(reverifySystem).not.toBe(primarySystem);
    } finally {
      await server.close();
    }
  });

  it("v4 prompt: schema hint asks for cited evidence in exterior_details, not a generic summary", async () => {
    const server = await startServer(3);
    try {
      await runVision([listing("a1", PHOTOS)], mockCfg(server.port), healthy, "local_inference_only", 1);
      const system = server.bodies[0].messages[0].content as string;
      expect(system).toMatch(/cite specific visible evidence/i);
    } finally {
      await server.close();
    }
  });

  it("normalizes an English photo_type (e.g. 'professional') back to the Spanish enum, regression for a real prod failure", async () => {
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    photos_analyzed: 1,
                    photo_type: "professional", // model ignored the Spanish-enum instruction
                    exterior_state: "bien",
                    interior_state: "no_ver",
                    cleanliness: "limpio",
                    color: "red",
                    red_flags: [],
                  }),
                },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 5, completion_tokens: 5 },
          })
        );
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as any).port;
    try {
      const out = await runVision([listing("a1", PHOTOS)], mockCfg(port), healthy, "local_inference_only", 1);
      // Must be a valid Spanish enum value (Convex's schema validator would
      // reject "professional" outright and fail the whole job).
      expect(out.primary[0].photoType).toBe("profesional");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("routes to the OpenAI cloud fallback when local is text-only and mode=local_preferred", async () => {
    const server = await startServer(3);
    let seenAuth: string | null = null;
    let seenBody: any = null;
    const cloudServer = http.createServer((req, res) => {
      seenAuth = req.headers.authorization ?? null;
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        seenBody = JSON.parse(raw || "{}");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    photos_analyzed: 3,
                    photo_type: "profesional",
                    exterior_state: "bien",
                    interior_state: "no_evaluable",
                    cleanliness: "limpio",
                    color: "azul",
                    red_flags: [],
                  }),
                },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 5, completion_tokens: 5 },
          })
        );
      });
    });
    await new Promise<void>((r) => cloudServer.listen(0, "127.0.0.1", () => r()));
    const cloudPort = (cloudServer.address() as any).port;
    const textOnlyLocal: ModelConfig = { ...mockCfg(server.port), visionCapable: false };
    const cloudFallback: ModelConfig = {
      provider: "openai_compat",
      baseUrl: `http://127.0.0.1:${cloudPort}/v1`,
      model: "gpt-4o-mini",
      visionCapable: true,
      apiKey: "sk-test-secret",
    };
    try {
      const out = await runVision(
        [listing("a1", PHOTOS)],
        textOnlyLocal,
        healthy,
        "local_preferred",
        undefined,
        cloudFallback
      );
      expect(server.bodies).toHaveLength(0); // never called the text-only local model
      expect(seenAuth).toBe("Bearer sk-test-secret");
      expect(seenBody.chat_template_kwargs).toBeUndefined(); // openai_compat must not send vLLM-only fields
      expect(out.primary[0].provider).toBe("openai_compat");
      expect(out.primary[0].exteriorState).toBe("bien");
      expect(out.providerLabel).toMatch(/fallback/);
    } finally {
      await server.close();
      await new Promise<void>((r) => cloudServer.close(() => r()));
    }
  });

  it("never calls the cloud fallback in local_inference_only even when local is text-only", async () => {
    const server = await startServer(3);
    let cloudCalled = false;
    const cloudServer = http.createServer((_req, res) => {
      cloudCalled = true;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "{}" }, finish_reason: "stop" }] }));
    });
    await new Promise<void>((r) => cloudServer.listen(0, "127.0.0.1", () => r()));
    const cloudPort = (cloudServer.address() as any).port;
    const textOnlyLocal: ModelConfig = { ...mockCfg(server.port), visionCapable: false };
    const cloudFallback: ModelConfig = {
      provider: "openai_compat",
      baseUrl: `http://127.0.0.1:${cloudPort}/v1`,
      model: "gpt-4o-mini",
      visionCapable: true,
      apiKey: "sk-test-secret",
    };
    try {
      const out = await runVision(
        [listing("a1", PHOTOS)],
        textOnlyLocal,
        healthy,
        "local_inference_only",
        undefined,
        cloudFallback
      );
      expect(cloudCalled).toBe(false);
      expect(out.primary[0].exteriorState).toBe("no_evaluable");
    } finally {
      await server.close();
      await new Promise<void>((r) => cloudServer.close(() => r()));
    }
  });
});
