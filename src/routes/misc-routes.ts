import { Router } from "express";

export function createMiscRouter() {
  const router = Router();

  router.get("/", (_req, res) => {
    res.send("WELCOME TO SERVER");
  });

  router.get("/polymarket", async (req, res) => {
    const slug =
      typeof req.query.slug === "string"
        ? req.query.slug
        : "will-alexandria-ocasio-cortez-win-the-2028-democratic-presidential-nomination-653";

    const resp = await fetch(`https://gamma-api.polymarket.com/markets/slug/${slug}`);
    const result = (await resp.json()) as {
      id: string;
      question: string;
      image: string;
      description: string;
      outcomes: unknown;
      outcomePrices: unknown;
    };

    const relevantstuff = {
      id: result.id,
      question: result.question,
      image: result.image,
      description: result.description,
      outcome: result.outcomes,
      outcomePrices: result.outcomePrices,
    };

    res.send(relevantstuff);
  });

  return router;
}
