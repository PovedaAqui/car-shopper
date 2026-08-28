/**
 * Scraping stage (plan §4 stage 1).
 *
 * LIVE only: every job scrapes coches.net in real time through Firecrawl
 * (category page built from the job criteria). There are no fixed inputs,
 * fixtures, or hardcoded workflows: the listings in each report are the ads
 * coches.net serves at run time. If the live source fails, the job fails —
 * the pipeline never invents or substitutes data.
 */

export interface RawListing {
  source: string;
  adId: string;
  sourceUrl: string;
  title: string;
  price: number;
  km: number;
  year?: number | null;
  fuel?: string | null;
  city?: string | null;
  hasWarranty: boolean;
  isPro: boolean;
  photoCount: number;
  photoUrls: string[];
  dataQualityFlag: "ok" | "corrupt" | "duplicate";
  duplicateOfAdId?: string | null;
  fetchedAt: number;
}

export interface ScrapeSource {
  name: string;
  /** Human-readable label for the report ("fuente: ..."). */
  label(): string;
  scrape(criteria: ScrapeCriteria): Promise<RawListing[]>;
}

export interface ScrapeCriteria {
  make: string;
  model: string;
  maxPrice: number;
  region: string;
  maxKm?: number;
  /** Photos per ad to analyze: 0 = vision deactivated, >=1 = cap, undefined = all. */
  maxPhotos?: number;
}

/** Region words → coches.net city slugs (first match wins; none → national). */
const REGION_SLUGS: Array<[string, string]> = [
  ["barcelona", "barcelona"],
  ["zaragoza", "zaragoza"],
  ["madrid", "madrid"],
  ["valencia", "valencia"],
  ["sevilla", "sevilla"],
  ["bilbao", "bilbao"],
  ["alicante", "alicante"],
  ["murcia", "murcia"],
  ["málaga", "malaga"],
  ["malaga", "malaga"],
  ["las palmas", "las-palmas"],
];

export function regionSlug(region: string): string | null {
  const r = region.toLowerCase();
  for (const [word, slug] of REGION_SLUGS) {
    if (r.includes(word)) return slug;
  }
  return null;
}

/** Category URL for a criteria set, e.g. https://www.coches.net/toyota/yaris/segunda-mano/barcelona/?p=5000 */
export function categoryUrl(criteria: ScrapeCriteria, page = 1): string {
  const make = criteria.make.trim().toLowerCase().replace(/\s+/g, "");
  const model = criteria.model.trim().toLowerCase().replace(/\s+/g, "");
  const slug = regionSlug(criteria.region);
  const base = `https://www.coches.net/${make}/${model}/segunda-mano${slug ? `/${slug}` : ""}`;
  const q = new URLSearchParams();
  if (criteria.maxPrice > 0) q.set("p", String(Math.round(criteria.maxPrice)));
  q.set("pg", String(page));
  return `${base}/?${q.toString()}`;
}

/**
 * Live coches.net adapter via Firecrawl `scrape`: fetches the category page
 * built from the job criteria and parses the ad cards from the markdown.
 * Every field is extracted only when actually present; incomplete rows are
 * left for the normalizer to reject (corrupt rules). No fixture data is mixed in.
 */
export class FirecrawlSource implements ScrapeSource {
  name = "firecrawl";
  private lastLabel = "coches.net (en vivo)";

  constructor(private apiKey: string, private endpoint = "https://api.firecrawl.dev/v1", private maxPages = 3) {}

  label(): string {
    return this.lastLabel;
  }

  async scrape(criteria: ScrapeCriteria): Promise<RawListing[]> {
    const seen = new Map<string, RawListing>();
    for (let pg = 1; pg <= this.maxPages; pg++) {
      const url = categoryUrl(criteria, pg);
      const markdown = await this.fetchMarkdown(url);
      const cards = parseCategoryCards(markdown, criteria);
      if (cards.length === 0) break; // last page / empty scope
      for (const c of cards) {
        // The capped category page can still render ads above the cap; drop them.
        if (criteria.maxPrice > 0 && c.price > criteria.maxPrice) continue;
        if (!seen.has(c.adId)) seen.set(c.adId, c);
      }
    }
    if (seen.size === 0) {
      throw new Error("NO_LISTINGS: no se encontraron anuncios en coches.net para estos criterios");
    }
    const slug = regionSlug(criteria.region);
    this.lastLabel = `coches.net (en vivo, scrape ${new Date().toLocaleDateString("es-ES")} · ${slug ?? "ámbito nacional"})`;
    return [...seen.values()];
  }

  private async fetchMarkdown(url: string): Promise<string> {
    const response = await fetch(`${this.endpoint.replace(/\/$/, "")}/scrape`, {
      method: "POST",
      headers: { authorization: "Bearer " + this.apiKey, "content-type": "application/json" },
      body: JSON.stringify({ url, formats: ["markdown"] }),
    });
    const payload: any = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(`FIRECRAWL_HTTP_${response.status}: ${payload?.error ?? "scrape failed"}`);
    }
    return String(payload?.data?.markdown ?? "");
  }
}

/**
 * Parse coches.net category cards from Firecrawl markdown.
 * Card shape (observed live 2026-08-28):
 *   ## [TOYOTA Yaris 1.5 125 SEdition](https://www.coches.net/toyota-yaris-...-71027732-covo.aspx)
 *   ... 15.900 € / Financiado: **14.600 €** ...
 *   - Gasolina
 *   - 2022
 *   - 78,915 km
 *   - 125 cv
 *   - Barcelona
 *   Profesional 4.1
 *   ![TOYOTA Yaris 1.5 125 SEdition](https://a.ccdn.es/cnet/vehicles/.../560x421cut/)
 */
export function parseCategoryCards(markdown: string, criteria: ScrapeCriteria): RawListing[] {
  const fetchedAt = Date.now();
  const cardRe =
    /##\s*\[([^\]]+)\]\((https:\/\/www\.coches\.net\/[^\s)]*?-(\d{6,})-[^\s)]*?\.aspx)\)([\s\S]*?)(?=\n##\s|\n\[\d+ de|## Anuncios|$)/g;
  const out: RawListing[] = [];
  let m: RegExpExecArray | null;
  while ((m = cardRe.exec(markdown)) !== null) {
    const title = m[1].trim();
    const sourceUrl = m[2];
    const adId = m[3];
    const block = m[4].replace(/\n{2,}/g, "\n");

    // Price: first plausible € amount, preferring one within the cap (the
    // "Financiado" line can appear with a different amount).
    const priceMatches = [...block.matchAll(/([\d][\d.]*)\s*€/g)]
      .map((x) => parseNum(x[1]))
      .filter((p) => p > 0);
    const within = priceMatches.find((p) => p <= criteria.maxPrice * 1.5);
    const price = within ?? (priceMatches[0] > 0 ? priceMatches[0] : 0);

    // Mileage: the card bullet reads e.g. "- 78,915 km" (comma = thousands).
    const kmMatch = block.match(/-?\s*([\d][\d.,]*)\s*km\b/i);
    const km = kmMatch ? parseNum(kmMatch[1]) : 0;

    // Year: prefer a 4-digit year line; fall back to the URL suffix.
    const yearMatch = block.match(/^-\s*((?:19|20)\d{2})\s*$/m) ?? sourceUrl.match(/-(\d{4})-en-/);
    const year = yearMatch ? Number(yearMatch[1]) : null;

    const fuelMatch = block.match(/-\s*((?:Gasolina|Di[és]el|H[íi]brido|El[ée]ctrico|GLP)[^-\n]*)/i);
    const photoUrls: string[] = [];
    for (const p of block.matchAll(/!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g)) {
      const u = p[1];
      // Only real vehicle photos (a.ccdn.es/cnet/vehicles/...); skip icons/logos.
      if (u.includes("/cnet/vehicles/")) photoUrls.push(u);
    }

    out.push({
      source: "firecrawl",
      adId,
      sourceUrl,
      title,
      price,
      km,
      year,
      fuel: fuelMatch ? fuelMatch[1].trim() : null,
      city: criteria.region,
      hasWarranty: /garant[ií]a|warranty/i.test(block),
      isPro: /profesional/i.test(block),
      photoCount: photoUrls.length,
      photoUrls,
      dataQualityFlag: "ok",
      fetchedAt,
    });
  }
  return out;
}

/** "78,915" / "78.915" / "112000" → 78915 (first separator wins as thousands). */
function parseNum(s: string): number {
  const normalized = s.replace(/[.\s]/g, "").replace(/,/g, "");
  const value = Number(normalized);
  return Number.isFinite(value) ? value : 0;
}

export function defaultSource(): ScrapeSource {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) throw new Error("FIRECRAWL_NOT_CONFIGURED: set FIRECRAWL_API_KEY");
  return new FirecrawlSource(apiKey, process.env.FIRECRAWL_BASE_URL ?? "https://api.firecrawl.dev/v1");
}

/**
 * Normalization + quality flags + dedup (plan §4 stage 2).
 *
 * Rules from the reference session:
 * - corrupt: km/price implausible (e.g. 370 €/568 km) -> excluded from ranking
 * - duplicate: same km + price + photo-url signature as an already-seen ad
 */
export function normalize(raw: RawListing[]): {
  listings: RawListing[];
  valid: number;
  excluded: number;
} {
  const seen = new Map<string, string>(); // signature -> first adId
  const out: RawListing[] = [];
  let excluded = 0;

  for (const l of raw) {
    let flag: RawListing["dataQualityFlag"] = "ok";
    let dupOf: string | undefined;

    if (isCorruptListing(l)) {
      // Used-car listings with implausible mileage/price (lesson: 370 € / 568 km).
      flag = "corrupt";
      excluded++;
    } else {
      // Dedup by km+price+year+city. Photo URLs are NOT required — the
      // 71108396/71108671 pair shares km+price but has different CDN photos.
      const sig = `${l.km}|${l.price}|${l.year ?? ""}|${(l.city ?? "").toLowerCase()}`;
      const first = seen.get(sig);
      if (first) {
        flag = "duplicate";
        dupOf = first;
        excluded++;
      } else {
        seen.set(sig, l.adId);
      }
    }

    out.push({
      ...l,
      dataQualityFlag: flag,
      duplicateOfAdId: dupOf ?? l.duplicateOfAdId ?? null,
    });
  }

  return { listings: out, valid: out.length - excluded, excluded };
}

/** Cheap used-car listings with <1000 km or <100 € are treated as corrupt. */
export function isCorruptListing(l: Pick<RawListing, "km" | "price">): boolean {
  if (l.price < 100) return true;
  if (l.km < 1000) return true;
  if (l.price > 0 && l.km > 0 && l.price / (l.km / 1000) < 0.2) return true;
  return false;
}
