import { Router } from "express";
import {
  fetchExternalMarketPreviewByUrl,
  fetchKalshiPreviewByTicker,
  fetchPolymarketPreviewBySlug,
} from "../services/market-source.ts";

export function createMarketSourceRouter() {
  const router = Router();

  router.get("/api/markets/preview", async (req, res) => {
    const sourceUrl = typeof req.query.url === "string" ? req.query.url : "";

    if (!sourceUrl) {
      return res.status(400).json({ error: "url query param is required" });
    }

    try {
      const preview = await fetchExternalMarketPreviewByUrl(sourceUrl);
      return res.json(preview);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Market preview failed";
      return res.status(400).json({ error: message });
    }
  });

  router.get("/api/markets/polymarket", async (req, res) => {
    const slug = typeof req.query.slug === "string" ? req.query.slug.trim() : "";

    if (!slug) {
      return res.status(400).json({ error: "slug query param is required" });
    }

    try {
      const preview = await fetchPolymarketPreviewBySlug(slug);
      return res.json(preview);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Polymarket preview failed";
      return res.status(400).json({ error: message });
    }
  });

  router.get("/api/markets/kalshi", async (req, res) => {
    const ticker = typeof req.query.ticker === "string" ? req.query.ticker.trim() : "";

    if (!ticker) {
      return res.status(400).json({ error: "ticker query param is required" });
    }

    try {
      const preview = await fetchKalshiPreviewByTicker(ticker);
      return res.json(preview);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Kalshi preview failed";
      return res.status(400).json({ error: message });
    }
  });

  return router;
}
