import { describe, expect, it } from "vitest";
import {
  extractKalshiTickerFromUrl,
  extractPolymarketSlugFromUrl,
  inferMarketSourceFromUrl,
} from "./market-source.ts";

describe("market source URL parsing", () => {
  it("extracts polymarket slug from event URL", () => {
    const slug = extractPolymarketSlugFromUrl(
      "https://polymarket.com/event/will-btc-hit-200k-before-2027",
    );
    expect(slug).toBe("will-btc-hit-200k-before-2027");
  });

  it("extracts polymarket slug from market URL", () => {
    const slug = extractPolymarketSlugFromUrl(
      "https://polymarket.com/market/will-sol-hit-500-in-2026",
    );
    expect(slug).toBe("will-sol-hit-500-in-2026");
  });

  it("extracts kalshi ticker from URL", () => {
    const ticker = extractKalshiTickerFromUrl(
      "https://kalshi.com/markets/pres24/which-party-wins",
    );
    expect(ticker).toBe("PRES24");
  });

  it("detects polymarket source", () => {
    const source = inferMarketSourceFromUrl(
      "https://polymarket.com/event/will-eth-hit-10k-before-2028",
    );
    expect(source).toBe("polymarket");
  });

  it("detects kalshi source", () => {
    const source = inferMarketSourceFromUrl("https://kalshi.com/markets/econinflation");
    expect(source).toBe("kalshi");
  });

  it("returns null for unsupported source", () => {
    const source = inferMarketSourceFromUrl("https://example.com/market/abc");
    expect(source).toBeNull();
  });
});
