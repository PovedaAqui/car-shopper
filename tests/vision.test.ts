import { describe, expect, it } from "vitest";
import http from "node:http";
import { runVision } from "../worker/vision.ts";
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

  it("default (undefined) uses the MAX_PHOTOS_PER_CAR=3 cap", async () => {
    const server = await startServer(3);
    try {
      const out = await runVision([listing("a1", PHOTOS)], mockCfg(server.port), healthy, "local_inference_only");
      const images = server.bodies[0].messages[1].content.filter((p: any) => p.type === "image_url");
      expect(images).toHaveLength(3);
      expect(out.primary[0].photosAnalyzed).toBe(3);
    } finally {
      await server.close();
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
});
