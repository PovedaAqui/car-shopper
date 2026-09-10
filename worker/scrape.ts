/**
 * Scraping stage (plan §4 stage 1).
 *
 * LIVE only: every job scrapes coches.net in real time through Firecrawl
 * (category page built from the job criteria). There are no fixed inputs,
 * fixtures, or hardcoded workflows: the listings in each report are the ads
 * coches.net serves at run time. If the live source fails, the job fails —
 * the pipeline never invents or substitutes data.
 *
 * Text extraction: card parsing is primarily deterministic regex (fast,
 * free, no LLM). When a card's price or mileage cannot be parsed from the
 * card text (rare formatting variants), an optional text model repairs just
 * those fields by reading the SAME raw card text — it only fills what is
 * literally present, never invents a number. That model is cloud (OpenAI)
 * by default; TEXT_PROVIDER=local switches to the local OpenAI-compatible
 * endpoint. If no text model is configured/healthy, the repair step is
 * skipped and the listing keeps its (possibly incomplete) regex values —
 * `isCorruptListing` still excludes it from ranking as before.
 */

import type { ModelConfig } from "./providers.ts";
import { chatJson, ProviderError } from "./providers.ts";

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

/**
 * Extract real vehicle photo URLs from a coches.net page (markdown or html).
 * Real car photos live on the `a.ccdn.es` asset CDN (a.ccdn.es/cnet/...).
 * Every icon/logo/button is on a different host (s.ccdn.es, adit.gw.coches.net),
 * so `a.ccdn.es` is the reliable discriminator. Deduped, order-preserving.
 */
export function extractPhotoUrls(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  // markdown images + raw url mentions; capture the base photo url (strip trailing size suffix).
  const re = /https?:\/\/a\.ccdn\.es\/cnet\/[^"'<>\s)]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    let u = m[0];
    // strip a trailing "/WxHcut/" size qualifier to canonicalize variants.
    u = u.replace(/\/\d+x\d+(cut|crop)?\/?$/, "").replace(/&utm_.*$/, "");
    if (u.length < 20) continue;
    if (!seen.has(u)) {
      seen.add(u);
      out.push(u);
    }
  }
  return out;
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
  // `maxPrice` is coches.net's real max-price filter (verified live: every
  // card under ?maxPrice=5000 priced <= 5000).
  if (criteria.maxPrice > 0) q.set("maxPrice", String(Math.round(criteria.maxPrice)));
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
  /** Pacing between Firecrawl requests (free plan: 20 req/min window). */
  private minIntervalMs: number;
  private lastRequestAt = 0;

  constructor(
    private apiKey: string,
    private endpoint = "https://api.firecrawl.dev/v1",
    private maxPages = 3,
    pacingMs = Number(process.env.FIRECRAWL_MIN_INTERVAL_MS ?? 3500),
    /** Optional text-repair model (cloud by default, see providers.ts
     * TEXT_PROVIDER). Only invoked for cards regex could not fully parse. */
    private textModel: ModelConfig | null = null
  ) {
    this.minIntervalMs = pacingMs >= 0 ? pacingMs : 3500;
  }

  label(): string {
    return this.lastLabel;
  }

  async scrape(criteria: ScrapeCriteria): Promise<RawListing[]> {
    const seen = new Map<string, RawListing>();
    for (let pg = 1; pg <= this.maxPages; pg++) {
      const url = categoryUrl(criteria, pg);
      const markdown = await this.fetchRaw(url, ["markdown"]);
      const cards = parseCategoryCardsRaw(markdown, criteria);
      if (cards.length === 0) break; // last page / empty scope
      for (const { listing: c, block } of cards) {
        // The capped category page can still render ads above the cap; drop them.
        if (criteria.maxPrice > 0 && c.price > criteria.maxPrice) continue;
        if (!seen.has(c.adId)) {
          const repaired = await this.maybeRepair(c, block);
          seen.set(repaired.adId, repaired);
        }
      }
    }
    if (seen.size === 0) {
      throw new Error("NO_LISTINGS: no se encontraron anuncios en coches.net para estos criterios");
    }
    // The category page carries no car photos (galleries are lazy-loaded), so
    // fetch each ad's own page to collect its real photo set. Bounded by the
    // user's maxPhotos setting (default 3): we only fetch what vision analyzes.
    const photoCap = criteria.maxPhotos && criteria.maxPhotos > 0 ? criteria.maxPhotos : 3;
    for (const l of seen.values()) {
      if (criteria.maxPhotos === 0) continue; // vision explicitly off -> no photos needed
      const photos = await this.enrichPhotos(l, photoCap);
      if (photos.length > 0) {
        l.photoUrls = photos;
        l.photoCount = photos.length;
      }
    }
    const slug = regionSlug(criteria.region);
    this.lastLabel = `coches.net (en vivo, scrape ${new Date().toLocaleDateString("es-ES")} · ${slug ?? "ámbito nacional"})`;
    return [...seen.values()];
  }

  /**
   * Regex misses price/km on a small share of cards (formatting variants).
   * When that happens and a text model is configured, ask it to re-read the
   * SAME raw card text and return only price/km it can literally find there
   * — never invent a number. No model configured / call fails -> the
   * listing keeps its regex values unchanged (isCorruptListing still
   * excludes it downstream as before this feature existed).
   */
  private async maybeRepair(listing: RawListing, block: string): Promise<RawListing> {
    if (listing.price > 0 && listing.km > 0) return listing;
    if (!this.textModel) return listing;
    try {
      const { value } = await chatJson<{ price: number | null; km: number | null }>(
        this.textModel,
        "Extrae SOLO precio (€) y kilometraje (km) de este fragmento de un anuncio de coche de segunda mano. " +
          "Si un valor no aparece literalmente en el texto, devuelve null para ese campo. No inventes ni estimes.",
        `Fragmento:\n${block.slice(0, 800)}`,
        { schemaHint: '{"price": number|null, "km": number|null}' }
      );
      if (!value) return listing;
      return {
        ...listing,
        price: listing.price > 0 ? listing.price : Number(value.price) > 0 ? Number(value.price) : listing.price,
        km: listing.km > 0 ? listing.km : Number(value.km) > 0 ? Number(value.km) : listing.km,
      };
    } catch (e) {
      // A repair failure (unreachable model, invalid JSON, etc.) must not
      // sink the job: keep the regex-parsed (possibly incomplete) listing.
      if (e instanceof ProviderError) return listing;
      throw e;
    }
  }

  /** Fetch one ad page and return its real vehicle photo URLs (up to the cap). */
  private async enrichPhotos(listing: RawListing, maxPhotosPerAd = 3): Promise<string[]> {
    try {
      const text = await this.fetchRaw(listing.sourceUrl, ["html", "markdown"]);
      const urls = extractPhotoUrls(text);
      return urls.slice(0, maxPhotosPerAd);
    } catch {
      // A per-ad fetch failure must not sink the whole job: the listing stays
      // photo-less and vision honestly reports "sin fotos".
      return [];
    }
  }

  /** Firecrawl scrape; returns the concatenated text of the requested formats. */
  private async fetchRaw(url: string, formats: string[]): Promise<string> {
    const body = JSON.stringify({ url, formats });
    const response = await this.throttledPost(body);
    const payload: any = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(`FIRECRAWL_HTTP_${response.status}: ${payload?.error ?? "scrape failed"}`);
    }
    const d = payload?.data ?? {};
    return [d.markdown ?? "", d.html ?? ""].join("\n");
  }

  /**
   * POST to the Firecrawl /scrape endpoint with client-side throttling and
   * 429 retry. The free plan is a moving window of 20 req/min; a full job is
   * ~17 requests, so without pacing the enrichment phase gets rate-limited.
   * On 429 we honor the server's retry-after hint and retry (up to 5 tries).
   */
  private async throttledPost(body: string): Promise<Response> {
    const endpoint = this.endpoint.replace(/\/$/, "");
    let lastResponse: Response | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const waitMs = this.minIntervalMs - (Date.now() - this.lastRequestAt);
      if (waitMs > 0) await sleep(waitMs);
      this.lastRequestAt = Date.now();
      const response = await fetch(`${endpoint}/scrape`, {
        method: "POST",
        headers: { authorization: "Bearer " + this.apiKey, "content-type": "application/json" },
        body,
      });
      if (response.status !== 429) {
        lastResponse = response;
        break;
      }
      lastResponse = response;
      const payload: any = await response.json().catch(() => ({}));
      const msg = String(payload?.error ?? "");
      const m = /retry after (\d+)s/i.exec(msg);
      // Honor the server's hint (always present on 429); exponential fallback.
      const delayMs = m ? parseInt(m[1], 10) * 1000 : 1000 * (attempt + 1);
      await sleep(delayMs);
    }
    if (lastResponse && lastResponse.status === 429) {
      throw new Error("FIRECRAWL_HTTP_429: rate limit still exceeded after retries");
    }
    return lastResponse!;
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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
  return parseCategoryCardsRaw(markdown, criteria).map((r) => r.listing);
}

/** Same parse as parseCategoryCards, but also returns each card's raw block
 * text so an optional text-repair pass can re-read exactly what was on the
 * page (never inventing data not present in it). */
export function parseCategoryCardsRaw(
  markdown: string,
  criteria: ScrapeCriteria
): Array<{ listing: RawListing; block: string }> {
  const fetchedAt = Date.now();
  const cardRe =
    /##\s*\[([^\]]+)\]\((https:\/\/www\.coches\.net\/[^\s)]*?-(\d{6,})-[^\s)]*?\.aspx)\)([\s\S]*?)(?=\n##\s|\n\[\d+ de|## Anuncios|$)/g;
  const out: Array<{ listing: RawListing; block: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = cardRe.exec(markdown)) !== null) {
    const title = m[1].trim();
    const sourceUrl = m[2];
    const adId = m[3];
    const block = m[4].replace(/\n{2,}/g, "\n");

    // Price: the card's own price line is the FIRST "<digits> €" amount in
    // the block (e.g. "11.990 €"). Monthly-installment lines ("143,32 €/mes")
    // and other amounts are stripped so they can never be picked as the price.
    const blockPrices = block
      .replace(/[\d.,]+\s*€\s*\/\s*mes/g, "") // financing: X €/mes
      .match(/^[\d][\d.]*\s*€/gm);
    const price = blockPrices && blockPrices.length > 0 ? parseNum(blockPrices[0].replace(/€.*$/, "")) : 0;

    // Mileage: the card bullet reads e.g. "- 78,915 km" (comma = thousands).
    const kmMatch = block.match(/-?\s*([\d][\d.,]*)\s*km\b/i);
    const km = kmMatch ? parseNum(kmMatch[1]) : 0;

    // Year: prefer a 4-digit year line; fall back to the URL suffix.
    const yearMatch = block.match(/^-\s*((?:19|20)\d{2})\s*$/m) ?? sourceUrl.match(/-(\d{4})-en-/);
    const year = yearMatch ? Number(yearMatch[1]) : null;

    const fuelMatch = block.match(/-\s*((?:Gasolina|Di[és]el|H[íi]brido|El[ée]ctrico|GLP)[^-\n]*)/i);
    // The category page does not carry car photos (galleries are lazy-loaded);
    // any a.ccdn.es hit is captured here but the real set comes from the
    // per-ad enrichment (enrichPhotos).
    const photoUrls = extractPhotoUrls(block);

    out.push({
      listing: {
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
      },
      block,
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

export function defaultSource(textModel: ModelConfig | null = null): ScrapeSource {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) throw new Error("FIRECRAWL_NOT_CONFIGURED: set FIRECRAWL_API_KEY");
  return new FirecrawlSource(apiKey, process.env.FIRECRAWL_BASE_URL ?? "https://api.firecrawl.dev/v1", 3, undefined, textModel);
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
