export type ExternalMarketSource = "polymarket" | "kalshi";

export interface ExternalMarketPreview {
  source: ExternalMarketSource;
  sourceUrl: string;
  externalId: string;
  title: string;
  description?: string;
  image?: string;
  outcomes: string[];
  outcomePrices: number[];
  closesAt?: string;
  raw: unknown;
}

function parseJsonArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string");
}

function parsePriceArray(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => {
      if (typeof item === "number") {
        return item;
      }

      if (typeof item === "string") {
        const parsed = Number(item);
        return Number.isNaN(parsed) ? null : parsed;
      }

      return null;
    })
    .filter((item): item is number => item !== null);
}

export function extractPolymarketSlugFromUrl(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl);

    if (!parsed.hostname.includes("polymarket.com")) {
      return null;
    }

    const pathParts = parsed.pathname.split("/").filter(Boolean);

    const marketIdx = pathParts.findIndex((part) => part === "market" || part === "event");
    if (marketIdx >= 0 && pathParts[marketIdx + 1]) {
      return pathParts[marketIdx + 1];
    }

    if (pathParts[0]) {
      return pathParts[pathParts.length - 1] ?? null;
    }

    return parsed.searchParams.get("slug");
  } catch {
    return null;
  }
}

export function extractKalshiTickerFromUrl(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl);

    if (!parsed.hostname.includes("kalshi.com")) {
      return null;
    }

    const pathParts = parsed.pathname.split("/").filter(Boolean);

    const marketIdx = pathParts.findIndex((part) => part === "markets");
    if (marketIdx >= 0 && pathParts[marketIdx + 1]) {
      return pathParts[marketIdx + 1].toUpperCase();
    }

    const ticker = parsed.searchParams.get("ticker");
    return ticker ? ticker.toUpperCase() : null;
  } catch {
    return null;
  }
}

export function inferMarketSourceFromUrl(rawUrl: string): ExternalMarketSource | null {
  if (extractPolymarketSlugFromUrl(rawUrl)) {
    return "polymarket";
  }

  if (extractKalshiTickerFromUrl(rawUrl)) {
    return "kalshi";
  }

  return null;
}

export async function fetchPolymarketPreviewBySlug(slug: string): Promise<ExternalMarketPreview> {
  const sourceUrl = `https://polymarket.com/event/${slug}`;
  const response = await fetch(`https://gamma-api.polymarket.com/markets/slug/${slug}`);

  if (!response.ok) {
    throw new Error(`Polymarket lookup failed with status ${response.status}`);
  }

  const raw = (await response.json()) as {
    id?: string;
    slug?: string;
    question?: string;
    image?: string;
    description?: string;
    outcomes?: unknown;
    outcomePrices?: unknown;
    endDate?: string;
  };

  const outcomes = parseJsonArray(raw.outcomes);
  const outcomePrices = parsePriceArray(raw.outcomePrices);

  return {
    source: "polymarket",
    sourceUrl,
    externalId: raw.id ?? slug,
    title: raw.question ?? slug,
    description: raw.description,
    image: raw.image,
    outcomes,
    outcomePrices,
    closesAt: raw.endDate,
    raw,
  };
}

export async function fetchKalshiPreviewByTicker(
  ticker: string,
  apiBaseUrl = process.env.KALSHI_API_BASE_URL ?? "https://api.elections.kalshi.com/trade-api/v2",
): Promise<ExternalMarketPreview> {
  const normalizedTicker = ticker.toUpperCase();
  const sourceUrl = `https://kalshi.com/markets/${normalizedTicker}`;
  const response = await fetch(`${apiBaseUrl}/markets/${encodeURIComponent(normalizedTicker)}`);

  if (!response.ok) {
    throw new Error(`Kalshi lookup failed with status ${response.status}`);
  }

  const payload = (await response.json()) as {
    market?: {
      ticker?: string;
      title?: string;
      subtitle?: string;
      yes_price?: number;
      no_price?: number;
      close_time?: string;
    };
    ticker?: string;
    title?: string;
    subtitle?: string;
    yes_price?: number;
    no_price?: number;
    close_time?: string;
  };

  const market = payload.market ?? payload;
  const yes = typeof market.yes_price === "number" ? market.yes_price : null;
  const no = typeof market.no_price === "number" ? market.no_price : null;

  return {
    source: "kalshi",
    sourceUrl,
    externalId: market.ticker ?? normalizedTicker,
    title: market.title ?? normalizedTicker,
    description: market.subtitle,
    outcomes: ["YES", "NO"],
    outcomePrices: [yes, no].filter((value): value is number => value !== null),
    closesAt: market.close_time,
    raw: payload,
  };
}

export async function fetchExternalMarketPreviewByUrl(rawUrl: string): Promise<ExternalMarketPreview> {
  const source = inferMarketSourceFromUrl(rawUrl);

  if (source === "polymarket") {
    const slug = extractPolymarketSlugFromUrl(rawUrl);
    if (!slug) {
      throw new Error("Unable to extract polymarket slug from URL");
    }

    return fetchPolymarketPreviewBySlug(slug);
  }

  if (source === "kalshi") {
    const ticker = extractKalshiTickerFromUrl(rawUrl);
    if (!ticker) {
      throw new Error("Unable to extract kalshi ticker from URL");
    }

    return fetchKalshiPreviewByTicker(ticker);
  }

  throw new Error("Unsupported market URL. Use polymarket.com or kalshi.com market links.");
}
