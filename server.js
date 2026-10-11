
import express from "express";
import helmet from "helmet";
import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { GoogleGenerativeAI } from "@google/generative-ai";
import Parser from "rss-parser";

const app = express();
const port = process.env.PORT || 10000;
const root = path.dirname(fileURLToPath(import.meta.url));

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(root, "public")));

const supabaseReady =
  process.env.SUPABASE_URL &&
  process.env.SUPABASE_SERVICE_ROLE_KEY;

const db = supabaseReady
  ? createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    )
  : null;

const ai = process.env.GEMINI_API_KEY
  ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
  : null;

const parser = new Parser();

app.get("/api/config", (_req, res) => {
  res.json({
    supabaseUrl: process.env.SUPABASE_URL || "",
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || ""
  });
});

app.get("/api/health", (_req, res) => {
  res.json({
    status: "online",
    database: Boolean(db),
    ai: Boolean(ai)
  });
});

app.get("/api/news", async (_req, res) => {
  if (!db) {
    return res.status(503).json({
      error: "Supabase configure karo."
    });
  }

  const { data, error } = await db
    .from("articles")
    .select("*")
    .eq("is_published", true)
    .order("published_at", { ascending: false })
    .limit(30);

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json({ articles: data });
});

app.get("/api/debates", async (_req, res) => {
  if (!db) {
    return res.status(503).json({ error: "Database not configured." });
  }

  const { data, error } = await db
    .from("debates")
    .select("*")
    .eq("status", "open")
    .order("created_at", { ascending: false });

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json({ debates: data });
});

app.get("/api/edition", async (_req, res) => {
  if (!db) {
    return res.status(503).json({ error: "Database not configured." });
  }

  const today = new Date().toISOString().slice(0, 10);

  const { data, error } = await db
    .from("editions")
    .select("*")
    .eq("edition_date", today)
    .maybeSingle();

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json({ edition: data });
});

/*
  Basic RSS research endpoint.
  AI-generated output is NOT automatically treated as verified news.
  Only feeds you are permitted to use should be configured.
*/
app.post("/api/research", async (req, res) => {
  if (!ai) {
    return res.status(503).json({ error: "Gemini API key missing." });
  }

  const topic = String(req.body.topic || "").trim().slice(0, 150);

  if (!topic) {
    return res.status(400).json({ error: "Topic required." });
  }

  const feeds = (process.env.NEWS_FEEDS || "")
    .split(",")
    .map(x => x.trim())
    .filter(Boolean);

  if (!feeds.length) {
    return res.status(400).json({
      error: "Add permitted RSS feed URLs to NEWS_FEEDS first."
    });
  }

  try {
    const results = [];

    for (const url of feeds.slice(0, 5)) {
      try {
        const feed = await parser.parseURL(url);

        const matching = (feed.items || [])
          .filter(item =>
            String(item.title || "")
              .toLowerCase()
              .includes(topic.toLowerCase())
          )
          .slice(0, 5)
          .map(item => ({
            title: item.title,
            link: item.link,
            date: item.isoDate || item.pubDate || null,
            snippet: String(item.contentSnippet || "").slice(0, 400)
          }));

        results.push(...matching);
      } catch (error) {
        console.error("Feed failed:", error.message);
      }
    }

    if (!results.length) {
      return res.status(404).json({
        error: "No matching feed headlines found. Nothing published."
      });
    }

    const model = ai.getGenerativeModel({
      model: process.env.GEMINI_MODEL || "gemini-2.5-flash"
    });

    const prompt = `
You are a cautious news research assistant.
Use only the supplied RSS metadata.
Do not invent facts, quotes, photos, dates or locations.
If the evidence is insufficient, say so.
Return JSON with keys: headline, summary, draft, limitations.
This is a research draft, NOT verified news.
Include uncertainty and never claim independent verification.

Topic: ${topic}
Feed items: ${JSON.stringify(results)}
`;

    const response = await model.generateContent(prompt);

    res.json({
      draft: response.response.text(),
      sources: results,
      published: false,
      note: "Research draft only. Verification is still required."
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Research request failed." });
  }
});

app.get("*path", (_req, res) => {
  res.sendFile(path.join(root, "public", "index.html"));
});

app.listen(port, () => {
  console.log(`GENWIRE running on port ${port}`);
});
