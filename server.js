
import express from "express";
import helmet from "helmet";
import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { GoogleGenerativeAI } from "@google/generative-ai";
import Parser from "rss-parser";

const app = express();
const port = Number(process.env.PORT) || 10000;
const root = path.dirname(fileURLToPath(import.meta.url));

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "100kb" }));

// Serve the homepage from the repository root.
// index.html is NOT inside a public folder.
app.get("/", (_req, res) => {
  res.sendFile(path.join(root, "index.html"));
});

// Initialize Supabase only when server-side credentials exist.
const supabaseReady = Boolean(
  process.env.SUPABASE_URL &&
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const db = supabaseReady
  ? createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    )
  : null;

// Initialize Gemini only when an API key exists.
const ai = process.env.GEMINI_API_KEY
  ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
  : null;

const parser = new Parser();

// Health check
app.get("/api/health", (_req, res) => {
  res.json({
    status: "online",
    database: Boolean(db),
    ai: Boolean(ai)
  });
});

// Public browser configuration.
// The publishable/anon key is designed for browser use.
// Never expose the service-role key.
app.get("/api/config", (_req, res) => {
  res.json({
    supabaseUrl: process.env.SUPABASE_URL || "",
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || ""
  });
});

// Published news
app.get("/api/news", async (_req, res) => {
  if (!db) {
    return res.status(503).json({
      error: "Supabase is not configured on the server."
    });
  }

  try {
    const { data, error } = await db
      .from("articles")
      .select(
        "id,title,summary,body,category,city,author_name,source_urls,published_at,created_at"
      )
      .eq("is_published", true)
      .order("published_at", { ascending: false })
      .limit(30);

    if (error) {
      console.error("News query failed:", error.message);
      return res.status(500).json({
        error: "Could not load news."
      });
    }

    return res.json({ articles: data || [] });
  } catch (error) {
    console.error("News endpoint failed:", error);
    return res.status(500).json({
      error: "Internal server error."
    });
  }
});

// Open public debates
app.get("/api/debates", async (_req, res) => {
  if (!db) {
    return res.status(503).json({
      error: "Supabase is not configured on the server."
    });
  }

  try {
    const { data, error } = await db
      .from("debates")
      .select("id,title,description,status,created_at")
      .eq("status", "open")
      .order("created_at", { ascending: false })
      .limit(50);

    if (error) {
      console.error("Debates query failed:", error.message);
      return res.status(500).json({
        error: "Could not load debates."
      });
    }

    return res.json({ debates: data || [] });
  } catch (error) {
    console.error("Debates endpoint failed:", error);
    return res.status(500).json({
      error: "Internal server error."
    });
  }
});

// Today's e-paper edition
app.get("/api/edition", async (_req, res) => {
  if (!db) {
    return res.status(503).json({
      error: "Supabase is not configured on the server."
    });
  }

  try {
    const today = new Date().toISOString().slice(0, 10);

    const { data, error } = await db
      .from("editions")
      .select("*")
      .eq("edition_date", today)
      .maybeSingle();

    if (error) {
      console.error("Edition query failed:", error.message);
      return res.status(500).json({
        error: "Could not load the e-paper."
      });
    }

    return res.json({ edition: data || null });
  } catch (error) {
    console.error("Edition endpoint failed:", error);
    return res.status(500).json({
      error: "Internal server error."
    });
  }
});

/*
 * Research endpoint:
 * - Reads only RSS feeds configured by the site owner.
 * - Generates a draft, not a verified news report.
 * - Never publishes the draft automatically.
 */
app.post("/api/research", async (req, res) => {
  if (!ai) {
    return res.status(503).json({
      error: "GEMINI_API_KEY is not configured."
    });
  }

  const topic = String(req.body?.topic || "").trim().slice(0, 150);

  if (!topic) {
    return res.status(400).json({
      error: "Please provide a topic."
    });
  }

  const feeds = (process.env.NEWS_FEEDS || "")
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean)
    .slice(0, 5);

  if (feeds.length === 0) {
    return res.status(400).json({
      error: "Configure permitted RSS URLs in NEWS_FEEDS first."
    });
  }

  try {
    const results = [];

    for (const url of feeds) {
      try {
        const feed = await parser.parseURL(url);

        const matchingItems = (feed.items || [])
          .filter((item) => {
            const text = [
              item.title || "",
              item.contentSnippet || ""
            ].join(" ").toLowerCase();

            return text.includes(topic.toLowerCase());
          })
          .slice(0, 5)
          .map((item) => ({
            title: item.title || "",
            link: item.link || "",
            date: item.isoDate || item.pubDate || null,
            snippet: String(item.contentSnippet || "").slice(0, 400)
          }));

        results.push(...matchingItems);
      } catch (error) {
        console.error("RSS feed failed:", error.message);
      }
    }

    if (results.length === 0) {
      return res.status(404).json({
        error: "No matching headlines found. Nothing was published."
      });
    }

    const model = ai.getGenerativeModel({
      model: process.env.GEMINI_MODEL || "gemini-2.5-flash"
    });

    const prompt = `
You are a cautious news research assistant.

Use only the supplied RSS metadata and snippets.
Do not invent facts, quotes, dates, images, or locations.
Clearly identify uncertainty and missing information.
Do not claim that facts have been independently verified.
Do not reproduce full source articles.

Return a concise JSON object with these keys:
headline, summary, draft, limitations.

This is an unpublished research draft, not verified news.

Topic:
${topic}

RSS evidence:
${JSON.stringify(results)}
`;

    const response = await model.generateContent(prompt);
    const draft = response.response.text();

    return res.json({
      draft,
      sources: results,
      published: false,
      note: "Research draft only. Verify facts before publication."
    });
  } catch (error) {
    console.error("Research request failed:", error);
    return res.status(500).json({
      error: "Research request failed."
    });
  }
});

// Unknown API endpoints should return JSON, not the homepage.
app.all("/api/*path", (_req, res) => {
  res.status(404).json({
    error: "API endpoint not found."
  });
});

// Send the homepage for other browser page routes.
app.get("*path", (_req, res) => {
  res.sendFile(path.join(root, "index.html"));
});

// Handle unexpected errors.
app.use((error, _req, res, _next) => {
  console.error("Server error:", error);
  res.status(500).json({
    error: "Internal server error."
  });
});

app.listen(port, "0.0.0.0", () => {
  console.log(`GENWIRE running on port ${port}`);
});
