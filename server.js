
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

// Homepage
app.get("/", (_req, res) => {
  res.sendFile(path.join(root, "index.html"));
});

// Supabase: service-role key remains server-side only.
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

// Gemini
const ai = process.env.GEMINI_API_KEY
  ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
  : null;

const parser = new Parser({
  timeout: 10000,
  headers: {
    "User-Agent": "GENWIRE-NewsResearch/1.0"
  }
});

// Basic in-memory rate limit for the public research endpoint.
// This resets when the server restarts and is per server instance.
const researchRequests = new Map();
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = 5;

function researchRateLimit(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  let record = researchRequests.get(ip);

  if (!record || now - record.start >= RATE_WINDOW_MS) {
    record = { start: now, count: 0 };
  }

  record.count += 1;
  researchRequests.set(ip, record);

  if (record.count > RATE_MAX) {
    return res.status(429).json({
      error: "Too many research requests. Please wait one minute."
    });
  }

  // Keep the map from growing indefinitely.
  if (researchRequests.size > 1000) {
    for (const [key, value] of researchRequests) {
      if (now - value.start >= RATE_WINDOW_MS) {
        researchRequests.delete(key);
      }
    }
  }

  next();
}

// Health check: confirms configuration, not successful AI generation.
app.get("/api/health", (_req, res) => {
  res.json({
    status: "online",
    database: Boolean(db),
    ai: Boolean(ai)
  });
});

// Public browser configuration.
// Never return the Supabase service-role key here.
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
    console.error("News endpoint failed:", error.message);
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
    console.error("Debates endpoint failed:", error.message);
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
    console.error("Edition endpoint failed:", error.message);
    return res.status(500).json({
      error: "Internal server error."
    });
  }
});

/*
 * AI Research:
 * - Uses owner-configured RSS feeds.
 * - Searches related keywords for common topics.
 * - Generates an unpublished draft only.
 * - Does not automatically publish articles.
 */
app.post(
  "/api/research",
  researchRateLimit,
  async (req, res) => {
    if (!ai) {
      return res.status(503).json({
        error: "GEMINI_API_KEY is not configured."
      });
    }

    const topic = String(req.body?.topic || "")
      .trim()
      .slice(0, 150);

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

    const aliases = {
      technology: [
        "technology",
        "technologies",
        "tech",
        "artificial intelligence",
        "machine learning",
        "cybersecurity",
        "software",
        "robotics",
        "digital"
      ],
      ai: [
        "artificial intelligence",
        "machine learning",
        "generative ai",
        "chatbot"
      ],
      cricket: [
        "cricket",
        "test match",
        "t20",
        "ipl",
        "world cup"
      ],
      politics: [
        "politics",
        "political",
        "government",
        "parliament",
        "election"
      ],
      business: [
        "business",
        "economy",
        "economic",
        "market",
        "company",
        "companies"
      ],
      sports: [
        "sport",
        "sports",
        "football",
        "cricket",
        "tennis",
        "olympic"
      ]
    };

    const normalizedTopic = topic.toLowerCase();
    const keywords = aliases[normalizedTopic] || [normalizedTopic];

    try {
      const results = [];
      const seenLinks = new Set();

      for (const url of feeds) {
        try {
          const feed = await parser.parseURL(url);

          for (const item of feed.items || []) {
            const title = String(item.title || "");
            const snippet = String(
              item.contentSnippet || item.content || ""
            )
              .replace(/<[^>]*>/g, " ")
              .slice(0, 1500);

            const searchableText =
              ` ${title} ${snippet} `.toLowerCase();

            const matched = keywords.some((keyword) =>
              searchableText.includes(keyword.toLowerCase())
            );

            if (!matched) continue;

            const link = String(item.link || "");

            if (link && seenLinks.has(link)) continue;
            if (link) seenLinks.add(link);

            results.push({
              title,
              link,
              date: item.isoDate || item.pubDate || null,
              snippet: snippet.slice(0, 400)
            });
          }
        } catch (error) {
          console.error("RSS feed failed:", error.message);
        }
      }

      const selectedResults = results.slice(0, 10);

      if (selectedResults.length === 0) {
        return res.status(404).json({
          error:
            "No matching headlines found in the configured RSS feeds. Try AI, cricket, politics, business, sports, or another specific topic. Nothing was published."
        });
      }

      const model = ai.getGenerativeModel({
        model: process.env.GEMINI_MODEL || "gemini-2.5-flash"
      });

      const prompt = `
You are a cautious news research assistant.

Use only the supplied RSS titles, dates and snippets.
Do not invent facts, quotes, dates, images or locations.
Do not claim independent verification.
Do not reproduce full source articles.
Clearly mention uncertainty and missing evidence.

Return a concise JSON object with these keys:
headline, summary, draft, limitations.

This is an unpublished research draft, not verified news.
Do not claim that the draft has been published.

Requested topic:
${topic}

RSS evidence:
${JSON.stringify(selectedResults)}
`;

      const response = await model.generateContent(prompt);
      const draft = response.response.text();

      return res.json({
        draft,
        sources: selectedResults,
        published: false,
        note:
          "Research draft only. Verify facts before publication."
      });
    } catch (error) {
      console.error(
        "Research request failed:",
        error.message
      );

      return res.status(500).json({
        error: "Research request failed. Check the server logs."
      });
    }
  }
);

// Unknown API endpoints return JSON.
app.all("/api/*path", (_req, res) => {
  res.status(404).json({
    error: "API endpoint not found."
  });
});

// Other browser routes serve the homepage.
app.get("*path", (_req, res) => {
  res.sendFile(path.join(root, "index.html"));
});

// General error handler
app.use((error, _req, res, _next) => {
  console.error("Server error:", error.message);

  res.status(500).json({
    error: "Internal server error."
  });
});

app.listen(port, "0.0.0.0", () => {
  console.log(`GENWIRE running on port ${port}`);
});
