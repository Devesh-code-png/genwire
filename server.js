
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

app.get("/", (_req, res) => {
  res.sendFile(path.join(root, "index.html"));
});

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

const ai = process.env.GEMINI_API_KEY
  ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
  : null;

const parser = new Parser({ timeout: 10000 });

const adminEmails = new Set(
  (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean)
);

// Basic per-instance rate limit for research generation.
const requestCounts = new Map();

function researchRateLimit(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  let record = requestCounts.get(ip);

  if (!record || now - record.start >= 60000) {
    record = { start: now, count: 0 };
  }

  record.count += 1;
  requestCounts.set(ip, record);

  if (record.count > 5) {
    return res.status(429).json({
      error: "Too many research requests. Wait one minute."
    });
  }

  if (requestCounts.size > 1000) {
    for (const [key, value] of requestCounts) {
      if (now - value.start >= 60000) {
        requestCounts.delete(key);
      }
    }
  }

  next();
}

// Secure editor authentication:
// Requires a valid Supabase access token and an allowlisted email.
async function requireEditor(req, res, next) {
  if (!db) {
    return res.status(503).json({
      error: "Editor authentication is not configured."
    });
  }

  const authorization = req.headers.authorization || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);

  if (!match) {
    return res.status(401).json({
      error: "Please sign in as an authorized editor."
    });
  }

  try {
    const { data, error } = await db.auth.getUser(match[1]);

    if (error || !data?.user) {
      return res.status(401).json({
        error: "Your session is invalid or expired."
      });
    }

    const email = String(data.user.email || "").toLowerCase();

    if (!email || !adminEmails.has(email)) {
      return res.status(403).json({
        error: "This account is not authorized to edit articles."
      });
    }

    req.editor = {
      id: data.user.id,
      email
    };

    next();
  } catch (error) {
    console.error("Editor authentication failed:", error.message);
    return res.status(401).json({
      error: "Could not verify editor session."
    });
  }
}

app.get("/api/health", (_req, res) => {
  res.json({
    status: "online",
    database: Boolean(db),
    ai: Boolean(ai),
    editorConfigured: adminEmails.size > 0
  });
});

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
      error: "Supabase is not configured."
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

    if (error) throw error;

    return res.json({ articles: data || [] });
  } catch (error) {
    console.error("News query failed:", error.message);
    return res.status(500).json({
      error: "Could not load news."
    });
  }
});

// Open debates
app.get("/api/debates", async (_req, res) => {
  if (!db) {
    return res.status(503).json({
      error: "Supabase is not configured."
    });
  }

  try {
    const { data, error } = await db
      .from("debates")
      .select("id,title,description,status,created_at")
      .eq("status", "open")
      .order("created_at", { ascending: false })
      .limit(50);

    if (error) throw error;

    return res.json({ debates: data || [] });
  } catch (error) {
    console.error("Debates query failed:", error.message);
    return res.status(500).json({
      error: "Could not load debates."
    });
  }
});

// Today's e-paper
app.get("/api/edition", async (_req, res) => {
  if (!db) {
    return res.status(503).json({
      error: "Supabase is not configured."
    });
  }

  try {
    const today = new Date().toISOString().slice(0, 10);

    const { data, error } = await db
      .from("editions")
      .select("*")
      .eq("edition_date", today)
      .maybeSingle();

    if (error) throw error;

    return res.json({ edition: data || null });
  } catch (error) {
    console.error("Edition query failed:", error.message);
    return res.status(500).json({
      error: "Could not load the e-paper."
    });
  }
});

const topicAliases = {
  technology: [
    "technology", "technologies", "tech",
    "artificial intelligence", "machine learning",
    "cybersecurity", "software", "robotics", "digital"
  ],
  ai: [
    "artificial intelligence", "machine learning",
    "generative ai", "chatbot"
  ],
  cricket: ["cricket", "test match", "t20", "ipl", "world cup"],
  politics: ["politics", "political", "government", "parliament", "election"],
  business: ["business", "economy", "economic", "market", "company"],
  sports: ["sports", "football", "cricket", "tennis", "olympic"]
};

// Public research generation. This creates a draft only.
app.post("/api/research", researchRateLimit, async (req, res) => {
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

  if (!feeds.length) {
    return res.status(400).json({
      error: "Configure NEWS_FEEDS first."
    });
  }

  try {
    const sources = [];
    const seen = new Set();
    const keywords = topicAliases[topic.toLowerCase()] || [topic];

    for (const url of feeds) {
      try {
        // Only use feeds configured by the site owner.
        const feed = await parser.parseURL(url);

        for (const item of feed.items || []) {
          const title = String(item.title || "");
          const snippet = String(item.contentSnippet || "")
            .slice(0, 500);
          const searchable = `${title} ${snippet}`.toLowerCase();

          if (!keywords.some((word) =>
            searchable.includes(word.toLowerCase())
          )) continue;

          const link = String(item.link || "");

          if (link && seen.has(link)) continue;
          if (link) seen.add(link);

          sources.push({
            title,
            url: link,
            date: item.isoDate || item.pubDate || null,
            snippet
          });
        }
      } catch (error) {
        console.error("RSS feed failed:", error.message);
      }
    }

    const selectedSources = sources.slice(0, 10);

    if (!selectedSources.length) {
      return res.status(404).json({
        error: "No matching headlines found. Nothing was published."
      });
    }

    const model = ai.getGenerativeModel({
      model: process.env.GEMINI_MODEL || "gemini-3.8-flash"
    });

    const prompt = `
You are GENWIRE's cautious newsroom research assistant.

Use only the supplied RSS titles, dates, snippets and links.
Never invent facts, quotes, dates, people or events.
Do not claim to have read the full linked articles.
A source mentioning a claim does not prove the claim is true.
Do not reproduce full source articles.

Return ONLY valid JSON using this schema:
{
  "headline": "Proposed headline",
  "summary": "Brief summary",
  "draft": "Unpublished article draft",
  "limitations": ["Missing evidence or context"],
  "claims": [
    {
      "claim": "One specific factual claim",
      "status": "needs_review",
      "sourceUrls": ["Exact URL from supplied evidence"],
      "reason": "What an editor should verify"
    }
  ],
  "checklist": [
    {
      "item": "Check the date against the original report",
      "completed": false
    }
  ]
}

Every claim must start with status "needs_review".
Do not label any claim verified or proven.
Only use URLs from the supplied source list.
If evidence is insufficient, say so.
Limit the draft to information supported by the supplied snippets.
The result is not independently verified and must not be published automatically.

Topic: ${topic}

RSS evidence:
${JSON.stringify(selectedSources)}
`;

    const response = await model.generateContent(prompt);
    const raw = response.response.text();

    let research;
    try {
      const cleaned = raw
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/, "")
        .trim();

      research = JSON.parse(cleaned);
    } catch {
      research = {
        headline: topic,
        summary: "AI returned a response that needs editor review.",
        draft: raw,
        limitations: ["The AI response was not valid JSON."],
        claims: [],
        checklist: [
          { item: "Review the AI response manually", completed: false }
        ]
      };
    }

    // Normalize statuses and reject source links not in supplied evidence.
    const allowedUrls = new Set(
      selectedSources.map((source) => source.url).filter(Boolean)
    );

    research.claims = (Array.isArray(research.claims)
      ? research.claims
      : []).map((claim) => ({
        claim: String(claim.claim || ""),
        status: "needs_review",
        sourceUrls: (Array.isArray(claim.sourceUrls)
          ? claim.sourceUrls
          : []).filter((url) => allowedUrls.has(url)),
        reason: String(claim.reason || "Editor verification required.")
      }));

    research.checklist = (Array.isArray(research.checklist)
      ? research.checklist
      : []).map((item) => ({
        item: String(item.item || "Review claim"),
        completed: false
      }));

    return res.json({
      research,
      sources: selectedSources,
      published: false,
      note: "Unverified research draft. Editor review is required."
    });
  } catch (error) {
    console.error("Research request failed:", error.message);
    return res.status(500).json({
      error: "Research request failed. Check server logs."
    });
  }
});

// Editor-only: list saved drafts.
app.get("/api/editor/drafts", requireEditor, async (_req, res) => {
  try {
    const { data, error } = await db
      .from("research_drafts")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(50);

    if (error) throw error;

    return res.json({ drafts: data || [] });
  } catch (error) {
    console.error("Draft list failed:", error.message);
    return res.status(500).json({
      error: "Could not load research drafts."
    });
  }
});

// Editor-only: save an AI-generated research draft for review.
app.post("/api/editor/drafts", requireEditor, async (req, res) => {
  const { research, sources } = req.body || {};

  if (!research || typeof research !== "object") {
    return res.status(400).json({
      error: "A research object is required."
    });
  }

  try {
    const { data, error } = await db
      .from("research_drafts")
      .insert({
        headline: String(research.headline || "").slice(0, 300),
        summary: String(research.summary || "").slice(0, 2000),
        body: String(research.draft || "").slice(0, 30000),
        claims: Array.isArray(research.claims) ? research.claims : [],
        checklist: Array.isArray(research.checklist)
          ? research.checklist
          : [],
        limitations: Array.isArray(research.limitations)
          ? research.limitations
          : [],
        source_urls: Array.isArray(sources) ? sources : [],
        status: "pending_review",
        created_by: req.editor.id
      })
      .select("*")
      .single();

    if (error) throw error;

    return res.status(201).json({
      draft: data,
      published: false
    });
  } catch (error) {
    console.error("Draft save failed:", error.message);
    return res.status(500).json({
      error: "Could not save the draft. Check the database setup."
    });
  }
});

// Editor-only: approve a draft for editorial workflow.
// Approval does NOT publish it on the public news page.
app.post("/api/editor/drafts/:id/approve", requireEditor, async (req, res) => {
  const id = String(req.params.id || "");

  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return res.status(400).json({ error: "Invalid draft ID." });
  }

  try {
    const { data, error } = await db
      .from("research_drafts")
      .update({
        status: "approved",
        reviewed_by: req.editor.id,
        reviewed_at: new Date().toISOString()
      })
      .eq("id", id)
      .eq("status", "pending_review")
      .select("id,headline,status,reviewed_at")
      .maybeSingle();

    if (error) throw error;

    if (!data) {
      return res.status(404).json({
        error: "Pending draft not found. It may already be reviewed."
      });
    }

    return res.json({
      draft: data,
      published: false,
      note: "Approved for editorial workflow; not publicly published."
    });
  } catch (error) {
    console.error("Draft approval failed:", error.message);
    return res.status(500).json({
      error: "Could not approve the draft."
    });
  }
});

// Editor-only: reject a pending draft.
app.post("/api/editor/drafts/:id/reject", requireEditor, async (req, res) => {
  const id = String(req.params.id || "");

  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return res.status(400).json({ error: "Invalid draft ID." });
  }

  try {
    const { data, error } = await db
      .from("research_drafts")
      .update({
        status: "rejected",
        reviewed_by: req.editor.id,
        reviewed_at: new Date().toISOString()
      })
      .eq("id", id)
      .eq("status", "pending_review")
      .select("id,headline,status,reviewed_at")
      .maybeSingle();

    if (error) throw error;

    if (!data) {
      return res.status(404).json({
        error: "Pending draft not found. It may already be reviewed."
      });
    }

    return res.json({ draft: data, published: false });
  } catch (error) {
    console.error("Draft rejection failed:", error.message);
    return res.status(500).json({
      error: "Could not reject the draft."
    });
  }
});

// Unknown API routes return JSON.
app.all("/api/*path", (_req, res) => {
  res.status(404).json({ error: "API endpoint not found." });
});

// Other page routes serve the homepage.
app.get("*path", (_req, res) => {
  res.sendFile(path.join(root, "index.html"));
});

app.use((error, _req, res, _next) => {
  console.error("Server error:", error.message);
  res.status(500).json({ error: "Internal server error." });
});

app.listen(port, "0.0.0.0", () => {
  console.log(`GENWIRE running on port ${port}`);
});
