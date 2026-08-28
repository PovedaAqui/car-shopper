import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FirecrawlSource,
  categoryUrl,
  regionSlug,
  parseCategoryCards,
  normalize,
  type ScrapeCriteria,
} from "../worker/scrape.ts";

const CRITERIA: ScrapeCriteria = {
  make: "Toyota",
  model: "Yaris",
  maxPrice: 5000,
  region: "Barcelona / Zaragoza",
};

// Real card shape captured from coches.net via Firecrawl (2026-08-28).
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

![TOYOTA Yaris 1.5 100 Hybrid Active](https://a.ccdn.es/cnet/vehicles/20391352/cc68e9e5-75fb-4a78-9848-f5a2d4fec377.jpg/712x535cut/)

Comparar

## [TOYOTA Yaris 1.3 Active](https://www.coches.net/toyota-yaris-13-active-5p-gasolina-2014-en-barcelona-71383043-covo.aspx)

4.200 \u20ac

- Diésel
- 2014
- 112.400 km
- 95 cv
- Barcelona

![TOYOTA Yaris 1.3 Active](https://a.ccdn.es/cnet/vehicles/20990001/aaaa-1111.jpg/712x535cut/)

![icon](https://s.ccdn.es/images/common/eco-label-icons/c.svg)

## [TOYOTA Yaris 1.5 125 SEdition](https://www.coches.net/toyota-yaris-15-125-sedition-5p-gasolina-2022-en-barcelona-71027732-covo.aspx)

15.900 \u20ac

- Gasolina
- 2022
- 12.300 km
- 125 cv
- Barcelona

![TOYOTA Yaris 1.5 125 SEdition](https://a.ccdn.es/cnet/vehicles/20380948/6509d627-2290-454b-ac52-396e469287d3.jpg/560x421cut/)
`;

describe("category URL building", () => {
  it("builds the coches.net category URL from criteria", () => {
    expect(categoryUrl(CRITERIA, 1)).toBe(
      "https://www.coches.net/toyota/yaris/segunda-mano/barcelona/?p=5000&pg=1",
    );
  });

  it("falls back to national scope for unknown regions", () => {
    expect(regionSlug("Bilbao, Vizcaya")).toBe("bilbao");
    expect(regionSlug("Cáceres")).toBeNull();
    expect(categoryUrl({ ...CRITERIA, region: "Cáceres" }, 2)).toBe(
      "https://www.coches.net/toyota/yaris/segunda-mano/?p=5000&pg=2",
    );
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
      photoUrls: [
        "https://a.ccdn.es/cnet/vehicles/20391352/cc68e9e5-75fb-4a78-9848-f5a2d4fec377.jpg/712x535cut/",
      ],
    });
    expect(b.price).toBe(4200);
    expect(b.km).toBe(112400);
    expect(b.isPro).toBe(false);
    expect(b.photoUrls).toHaveLength(1); // the eco-label icon is not a vehicle photo
    expect(c.price).toBe(15900);
  });
});

describe("Firecrawl source (live coches.net scrape)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("scrapes the category page and maps cards into listing records", async () => {
    const endpoints: string[] = [];
    const urls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any, init: any) => {
      const body = JSON.parse(String(init.body));
      endpoints.push(String(input));
      urls.push(body.url);
      const page = /pg=(\d+)/.exec(body.url)?.[1] ?? "1";
      const payload =
        page === "1" ? { data: { markdown: CATEGORY_MD } } : { data: { markdown: "# no more ads" } };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const source = new FirecrawlSource("test-key");
    const rows = await source.scrape(CRITERIA);

    expect(endpoints[0]).toBe("https://api.firecrawl.dev/v1/scrape");
    expect(urls[0]).toBe(
      "https://www.coches.net/toyota/yaris/segunda-mano/barcelona/?p=5000&pg=1",
    );
    // The €15.900 card is above the €5.000 cap → filtered out by the source.
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.adId)).toEqual(["71038515", "71383043"]);
    expect(source.label()).toContain("en vivo");
  });

  it("stops paginating when a page has no cards", async () => {
    const calls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => {
      calls.push(String(input));
      return new Response(
        JSON.stringify({ data: { markdown: calls.length === 1 ? CATEGORY_MD : "# fin" } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const rows = await new FirecrawlSource("test-key").scrape(CRITERIA);
    expect(rows).toHaveLength(2); // €15.900 card is over the €5.000 cap
    expect(calls.length).toBe(2); // page 1 + page 2 (empty), no page 3
  });

  it("surfaces Firecrawl API errors", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "rate limited" }), { status: 429 }),
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
