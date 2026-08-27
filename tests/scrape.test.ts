import { afterEach, describe, expect, it, vi } from "vitest";
import { FirecrawlSource } from "../worker/scrape.ts";

describe("Firecrawl source", () => {
  afterEach(() => vi.restoreAllMocks());

  it("maps Firecrawl search results into listing records", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            {
              url: "https://www.coches.net/toyota-yaris-71348735.aspx",
              title: "Toyota Yaris 2011",
              markdown: "Toyota Yaris · 4.500 € · 112.000 km · 2011\n![car](https://cdn.example/car.jpg)",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const rows = await new FirecrawlSource("test-key").scrape({
      make: "Toyota",
      model: "Yaris",
      maxPrice: 5000,
      region: "Barcelona",
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: "firecrawl",
      adId: "71348735",
      price: 4500,
      km: 112000,
      year: 2011,
      photoUrls: ["https://cdn.example/car.jpg"],
    });
  });

  it("surfaces Firecrawl API errors", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "rate limited" }), { status: 429 }),
    );

    await expect(
      new FirecrawlSource("test-key").scrape({
        make: "Toyota",
        model: "Yaris",
        maxPrice: 5000,
        region: "Barcelona",
      }),
    ).rejects.toThrow("FIRECRAWL_HTTP_429");
  });
});
