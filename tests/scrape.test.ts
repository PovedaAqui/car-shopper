import { afterEach, describe, expect, it, vi } from "vitest";
// Tests run with pacing disabled (the real throttle is verified by the 429-retry
// test, which uses the mock's retry-after hint).
process.env.FIRECRAWL_MIN_INTERVAL_MS = "0";
import {
  FirecrawlSource,
  categoryUrl,
  regionSlug,
  parseCategoryCards,
  extractPhotoUrls,
  normalize,
  type ScrapeCriteria,
} from "../worker/scrape.ts";
import type { ModelConfig } from "../worker/providers.ts";

const CRITERIA: ScrapeCriteria = {
  make: "Toyota",
  model: "Yaris",
  maxPrice: 5000,
  region: "Barcelona / Zaragoza",
};

// Real card shape captured from coches.net via Firecrawl (2026-08-28).
// NOTE: the live category page carries no car photos (galleries are
// lazy-loaded); the per-ad photo set comes from the ad-detail page.
const CATEGORY_MD = `# 184 TOYOTA Yaris de segunda mano y ocasión en Barcelona

## [TOYOTA Yaris 1.5 100 Hybrid Active](https://www.coches.net/toyota-yaris-15-hybrid-active-5p-electrico-hibrido-2016-en-barcelona-71038515-covo.aspx)

Precio justo

4.850 \u20ac

Garantía 2 años

- Gasolina
- 2016
- 78,915 km
- 100 cv
- Barcelona

Profesional 4.1

1/19

Comparar

## [TOYOTA Yaris 1.3 Active](https://www.coches.net/toyota-yaris-13-active-5p-gasolina-2014-en-barcelona-71383043-covo.aspx)

4.200 \u20ac

- Diésel
- 2014
- 112.400 km
- 95 cv
- Barcelona

![icon](https://s.ccdn.es/images/common/eco-label-icons/c.svg)

## [TOYOTA Yaris 1.5 125 SEdition](https://www.coches.net/toyota-yaris-15-125-sedition-5p-gasolina-2022-en-barcelona-71027732-covo.aspx)

15.900 \u20ac

- Gasolina
- 2022
- 12.300 km
- 125 cv
- Barcelona

Comparar
`;

describe("category URL building", () => {
  it("builds the coches.net category URL from criteria", () => {
    expect(categoryUrl(CRITERIA, 1)).toBe(
      "https://www.coches.net/toyota/yaris/segunda-mano/barcelona/?maxPrice=5000&pg=1",
    );
  });

  it("falls back to national scope for unknown regions", () => {
    expect(regionSlug("Bilbao, Vizcaya")).toBe("bilbao");
    expect(regionSlug("Cáceres")).toBeNull();
    expect(categoryUrl({ ...CRITERIA, region: "Cáceres" }, 2)).toBe(
      "https://www.coches.net/toyota/yaris/segunda-mano/?maxPrice=5000&pg=2",
    );
  });
});

describe("extractPhotoUrls", () => {
  it("keeps only a.ccdn.es car photos and drops icons/logos", () => {
    const text = [
      '![photo](https://a.ccdn.es/cnet/2026/08/26/71371924/2126251333_g.jpg/712x535cut/)',
      '![label](https://s.ccdn.es/images/common/eco-label-icons/c.svg)',
      '![logo](https://s.ccdn.es/images/common/logos/santander.svg)',
      '![icon](https://adit.gw.coches.net/twintail/v1/product/insurance-car-v2/logos/mosaic)',
      'raw https://a.ccdn.es/cnet/2026/08/26/71371924/2126251334_g.jpg/712x535cut/',
      'dup https://a.ccdn.es/cnet/2026/08/26/71371924/2126251333_g.jpg',
    ].join("\n");
    const urls = extractPhotoUrls(text);
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain("71371924");
    expect(urls.every((u) => u.startsWith("https://a.ccdn.es/cnet/"))).toBe(true);
    expect(urls.every((u) => !u.includes(".svg"))).toBe(true);
  });

  it("returns an empty list for a page with no car photos", () => {
    expect(extractPhotoUrls("no images here https://s.ccdn.es/images/bell-color.svg")).toHaveLength(0);
  });
});

describe("category card parsing", () => {
  it("extracts price, km (comma thousands), year, fuel, warranty, pro, real photos only", () => {
    const rows = parseCategoryCards(CATEGORY_MD, CRITERIA);
    expect(rows.map((r) => r.adId)).toEqual(["71038515", "71383043", "71027732"]);

    const [a, b, c] = rows;
    expect(a).toMatchObject({
      price: 4850,
      km: 78915,
      year: 2016,
      hasWarranty: true,
      isPro: true,
      fuel: "Gasolina",
    });
    // The live category page carries no car photos; the eco-label icon must
    // NOT be captured as a photo. Real photos come from the ad-detail page.
    expect(a.photoUrls).toHaveLength(0);
    expect(b.price).toBe(4200);
    expect(b.km).toBe(112400);
    expect(b.isPro).toBe(false);
    expect(b.photoUrls).toHaveLength(0);
    expect(c.price).toBe(15900);
  });

  it("ignores monthly-installment (€/mes) amounts and uses the card's own price line", () => {
    // Real shape: a "11.990 €" price line followed by a "143,32 €/mes" financing line.
    const md = `## [PEUGEOT 208 PureTech Active](https://www.coches.net/peugeot-208-x-2023-en-madrid-71318800-covo.aspx)

11.990 €

Financiado: **11.990 €**

143,32 €/mes*

- Gasolina
- 2022
- 58,928 km
- 75 cv
- Madrid

Comparar
`;
    const rows = parseCategoryCards(md, { make: "Peugeot", model: "208", maxPrice: 20000, region: "Madrid" });
    expect(rows).toHaveLength(1);
    expect(rows[0].price).toBe(11990); // NOT 143 (the /mes amount)
    expect(rows[0].km).toBe(58928);
  });
});

describe("Firecrawl source (live coches.net scrape)", () => {
  afterEach(() => vi.restoreAllMocks());

  // Category page (has cards, no photos) vs ad-detail page (has the a.ccdn.es photo).
  const AD_PAGE = (adId: string) => `# Ad ${adId}\n![photo](https://a.ccdn.es/cnet/2026/08/26/${adId}/12345_g.jpg/712x535cut/)\n`;

  it("scrapes the category page, enriches each ad with its real photos, and maps records", async () => {
    const urls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input: any, init: any) => {
      const body = JSON.parse(String(init.body));
      urls.push(body.url);
      const isAdDetail = /-covo\.aspx$/.test(body.url);
      const adId = /-(\d{6,})-/.exec(body.url)?.[1] ?? "0";
      const pg = /pg=(\d+)/.exec(body.url)?.[1] ?? "1";
      const markdown = isAdDetail ? AD_PAGE(adId) : pg === "1" ? CATEGORY_MD : "# fin";
      return new Response(JSON.stringify({ data: { markdown } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const source = new FirecrawlSource("test-key");
    const rows = await source.scrape(CRITERIA);

    expect(urls[0]).toBe(
      "https://www.coches.net/toyota/yaris/segunda-mano/barcelona/?maxPrice=5000&pg=1",
    );
    // The €15.900 card is above the €5.000 cap → filtered out by the source.
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.adId)).toEqual(["71038515", "71383043"]);
    // Each listing was enriched with its ad-page photo (a.ccdn.es, real).
    expect(rows.every((r) => r.photoUrls.length === 1)).toBe(true);
    expect(rows[0].photoUrls[0]).toContain("a.ccdn.es/cnet/");
    expect(source.label()).toContain("live");
  });

  it("stops paginating when a page has no cards", async () => {
    const calls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input: any, init: any) => {
      const body = JSON.parse(String(init.body));
      calls.push(body.url);
      const isCategory = /segunda-mano/.test(body.url);
      const markdown = isCategory
        ? (calls.filter((c) => /segunda-mano/.test(c)).length === 1 ? CATEGORY_MD : "# fin")
        : "# ad detail";
      return new Response(
        JSON.stringify({ data: { markdown } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const rows = await new FirecrawlSource("test-key").scrape(CRITERIA);
    expect(rows).toHaveLength(2); // €15.900 card is over the €5.000 cap
    // 2 category pages (pg=1 with cards, pg=2 empty) + 2 ad-detail enrichments.
    expect(calls.filter((c) => /segunda-mano/.test(c))).toHaveLength(2);
    expect(calls.length).toBe(4);
  });

  it("surfaces Firecrawl API errors", async () => {
    // Real Firecrawl 429s carry a "retry after Ns" hint; honor it (1s), then
    // the client gives up after the retry budget and surfaces the error.
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(
          JSON.stringify({ error: "Rate limit exceeded. Retry after 1s." }),
          { status: 429 },
        ),
    );
    await expect(new FirecrawlSource("test-key").scrape(CRITERIA)).rejects.toThrow(
      "FIRECRAWL_HTTP_429",
    );
  });

  it("throws NO_LISTINGS when the portal has no ads for the criteria", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: { markdown: "# 0 results" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(new FirecrawlSource("test-key").scrape(CRITERIA)).rejects.toThrow("NO_LISTINGS");
  });

  it("paces requests by the configured minimum interval", async () => {
    // pg=1 -> cards (maxPhotos=0 skips enrichment), pg=2 -> empty -> stop.
    const pages: Record<string, string> = {
      "1": CATEGORY_MD,
      "2": "# 0 resultados",
    };
    const timestamps: number[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      timestamps.push(Date.now());
      const body = JSON.parse((init as RequestInit).body as string);
      const pg = /pg=(\d+)/.exec(body.url)?.[1] ?? "1";
      return new Response(JSON.stringify({ data: { markdown: pages[pg] ?? "" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const source = new FirecrawlSource("test-key", "https://api.firecrawl.dev/v1", 3, 250);
    const rows = await source.scrape({ ...CRITERIA, maxPhotos: 0 });
    expect(rows).toHaveLength(2);
    expect(timestamps.length).toBe(2);
    expect(timestamps[1] - timestamps[0]).toBeGreaterThanOrEqual(240);
  });
});

describe("normalize on live-scraped rows", () => {
  it("keeps plausible live cards and flags duplicate signatures", () => {
    const rows = parseCategoryCards(CATEGORY_MD, CRITERIA);
    // Simulate the portal repeating an ad on page 2: same km/price/year/city.
    const withDup = [...rows, { ...rows[0], adId: "79999999", sourceUrl: rows[0].sourceUrl }];
    const normalized = normalize(withDup);
    expect(normalized.valid).toBe(rows.length);
    expect(normalized.excluded).toBe(1);
    expect(normalized.listings.at(-1)?.dataQualityFlag).toBe("duplicate");
    expect(normalized.listings.at(-1)?.duplicateOfAdId).toBe(rows[0].adId);
  });
});

describe("FirecrawlSource text-repair (optional model, price/km only)", () => {
  afterEach(() => vi.restoreAllMocks());

  // A card missing its price line (the regex path yields price=0).
  const BROKEN_CARD_MD = `## [SEAT Ibiza 1.0 Reference](https://www.coches.net/seat-ibiza-10-reference-2019-en-madrid-71500001-covo.aspx)

- Gasolina
- 2019
- 45.000 km
- Madrid
`;

  it("does not call the text model when price/km already parsed cleanly", async () => {
    let modelCalled = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any, init: any) => {
      const url = String(input);
      if (url.includes("/chat/completions")) {
        modelCalled = true;
        return new Response(JSON.stringify({ choices: [{ message: { content: "{}" }, finish_reason: "stop" }] }), { status: 200 });
      }
      const body = JSON.parse(String(init.body));
      const isAdDetail = /-covo\.aspx$/.test(body.url) && !/segunda-mano/.test(body.url);
      const markdown = isAdDetail ? "# ad" : CATEGORY_MD;
      return new Response(JSON.stringify({ data: { markdown } }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const textModel: ModelConfig = { provider: "openai_compat", baseUrl: "https://api.openai.test/v1", model: "gpt-4o-mini", apiKey: "sk-test" };
    const source = new FirecrawlSource("test-key", "https://api.firecrawl.dev/v1", 3, undefined, textModel);
    const rows = await source.scrape(CRITERIA);
    expect(rows.every((r) => r.price > 0)).toBe(true); // regex already parsed these cleanly
    expect(modelCalled).toBe(false);
  });

  it("repairs a missing price via the text model, reading only the card's own block", async () => {
    let seenPrompt = "";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any, init: any) => {
      const url = String(input);
      if (url.includes("/chat/completions")) {
        const body = JSON.parse(String(init.body));
        seenPrompt = body.messages[1].content;
        return new Response(
          JSON.stringify({ choices: [{ message: { content: JSON.stringify({ price: 6500, km: null }) }, finish_reason: "stop" }] }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      const body = JSON.parse(String(init.body));
      const isAdDetail = /-71500001-/.test(body.url) && !/segunda-mano/.test(body.url);
      const markdown = isAdDetail ? "# ad" : BROKEN_CARD_MD;
      return new Response(JSON.stringify({ data: { markdown } }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const textModel: ModelConfig = { provider: "openai_compat", baseUrl: "https://api.openai.test/v1", model: "gpt-4o-mini", apiKey: "sk-test" };
    const source = new FirecrawlSource("test-key", "https://api.firecrawl.dev/v1", 1, undefined, textModel);
    const rows = await source.scrape({ ...CRITERIA, maxPrice: 0 });
    expect(rows).toHaveLength(1);
    expect(rows[0].price).toBe(6500); // repaired from the model
    expect(rows[0].km).toBe(45000); // regex already had this; model's null must not overwrite it
    expect(seenPrompt).toContain("45.000 km"); // model only sees the card's own raw block
  });

  it("keeps the regex (possibly incomplete) listing when the text model call fails", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any, init: any) => {
      const url = String(input);
      if (url.includes("/chat/completions")) {
        return new Response("boom", { status: 500 });
      }
      const body = JSON.parse(String(init.body));
      const isAdDetail = /-71500001-/.test(body.url) && !/segunda-mano/.test(body.url);
      const markdown = isAdDetail ? "# ad" : BROKEN_CARD_MD;
      return new Response(JSON.stringify({ data: { markdown } }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const textModel: ModelConfig = { provider: "openai_compat", baseUrl: "https://api.openai.test/v1", model: "gpt-4o-mini", apiKey: "sk-test" };
    const source = new FirecrawlSource("test-key", "https://api.firecrawl.dev/v1", 1, undefined, textModel);
    const rows = await source.scrape({ ...CRITERIA, maxPrice: 0 });
    expect(rows).toHaveLength(1);
    expect(rows[0].price).toBe(0); // repair failed -> stays as regex parsed it (0)
    expect(rows[0].km).toBe(45000);
  });
});
