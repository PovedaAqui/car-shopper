import { describe, expect, it } from "vitest";
import { renderReportHTML } from "../worker/report.ts";
import type { RawListing } from "../worker/scrape.ts";
import type { ScoreRow } from "../worker/scoring.ts";

const listing: RawListing = {
  source: "fixtures",
  adId: "1",
  sourceUrl: "https://example.test/1",
  title: "<script>alert(1)</script>",
  price: 3000,
  km: 100000,
  year: 2011,
  fuel: "gasolina",
  city: "Barcelona",
  hasWarranty: false,
  isPro: false,
  photoCount: 1,
  photoUrls: ["https://example.test/p.jpg"],
  dataQualityFlag: "ok",
  fetchedAt: 1,
};

const score: ScoreRow = {
  adId: "1",
  base: 50,
  bonuses: 0,
  riskFactor: 0,
  visDelta: 0,
  final: 50,
  pricePerKm: 30,
  notes: [],
  included: true,
  rank: 1,
};

describe("report HTML", () => {
  it("escapes listing titles and keeps 8 header cells per ranked row", () => {
    const html = renderReportHTML({
      criteria: { make: "Toyota", model: "Yaris", maxPrice: 5000, region: "Barcelona" },
      listings: [listing],
      scores: [score],
      visionPrimary: [],
      consensus: [],
      providerLabel: "test",
      usedReferenceVision: true,
      generatedAt: 1,
      jobStage: "completed",
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("<meta name=\"robots\" content=\"noindex\">");
    expect(html).toContain("no sustituye una inspección mecánica");
    const headerCells = (html.match(/<thead><tr>(.*?)<\/tr><\/thead>/s)?.[1].match(/<th/g) ?? []).length;
    const firstRowTds = (html.match(/<tbody><tr>(.*?)<\/tr>/s)?.[1].match(/<td/g) ?? []).length;
    expect(headerCells).toBe(8);
    expect(firstRowTds).toBe(8);
  });
});
