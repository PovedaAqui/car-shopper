import { describe, expect, it } from "vitest";
import { runPipeline } from "../worker/pipeline.ts";
import type { WorkerConfig, JobSnapshot } from "../worker/convex_client.ts";
import type { RawListing } from "../worker/scrape.ts";

const dummyCfg: WorkerConfig = {
  convexUrl: "unused",
  siteUrl: "unused",
  apiBase: "unused",
  apiKey: "",
  workerId: "test",
  useDevHeader: true,
};

const listing: RawListing = {
  source: "fixtures",
  adId: "cached",
  sourceUrl: "https://example.test/c",
  title: "Cached Yaris",
  price: 4000,
  km: 110000,
  year: 2011,
  hasWarranty: false,
  isPro: false,
  photoCount: 0,
  photoUrls: [],
  dataQualityFlag: "ok",
  fetchedAt: 1,
};

describe("pipeline stage cache", () => {
  it("skips scrape when a snapshot already has listings", async () => {
    const stages: string[] = [];
    const snapshot: JobSnapshot = {
      listings: [listing],
      scores: [{ adId: "cached", scorerVersion: "score-1.0.0-v1" }],
      visionPrimary: [],
      visionReverify: [],
      consensus: [],
      hasReport: false,
    };
    const result = await runPipeline(
      "job-1",
      { make: "Toyota", model: "Yaris", maxPrice: 5000, region: "B" },
      dummyCfg,
      {
        onStage: async (stage) => {
          stages.push(stage);
        },
        onListings: async () => {
          throw new Error("scrape should not rewrite listings");
        },
        onScores: async () => {},
        onVision: async () => {},
        onConsensus: async () => {},
        onReport: async () => {},
        onDone: async () => {},
      },
      { snapshot, model: null, health: { ok: false, baseUrl: "", model: "" } }
    );
    expect(stages).not.toContain("scraping");
    expect(result.ranked).toBe(1);
  });
});
