import { createClient } from "https://esm.sh/@supabase/supabase-js@2.56.0";
import { XMLParser } from "https://esm.sh/fast-xml-parser@4.5.1";

const FEEDS = [
  { name: "Daily Monitor Business", url: "https://www.monitor.co.ug/rss/business" },
  { name: "New Vision Business", url: "https://www.newvision.co.ug/feed" },
  { name: "Nile Post Business", url: "https://nilepost.co.ug/feed/" },
  { name: "The Independent Uganda", url: "https://www.independent.co.ug/feed/" },
  { name: "The EastAfrican", url: "https://www.theeastafrican.co.ke/rss.xml" },
  { name: "Business Daily Africa", url: "https://www.businessdailyafrica.com/rss.xml" },
  { name: "The Citizen Tanzania", url: "https://www.thecitizen.co.tz/rss" },
  { name: "The New Times Rwanda", url: "https://www.newtimes.co.rw/feed/" },
  { name: "Google News - Uganda economy", url: "https://news.google.com/rss/search?q=Uganda+economy" },
  { name: "Google News - East Africa economy", url: "https://news.google.com/rss/search?q=East+Africa+economy" },
  { name: "Google News - Bank of Uganda", url: "https://news.google.com/rss/search?q=Bank+of+Uganda" },
  { name: "Google News - Uganda shilling", url: "https://news.google.com/rss/search?q=Uganda+shilling" },
];

const CACHE_TTL_MS = 30 * 60 * 1000;
const cache = new Map<string, { expiresAt: number; data: any }>();
const allowedOrigins = [
  "https://allanorabaasa-hash.github.io",
  "https://localhost",
  "capacitor://localhost",
  "http://localhost:8000",
  "http://localhost:8080",
  "http://127.0.0.1:8000",
  "http://127.0.0.1:8080",
];

const withCors = (response: Response, origin: string) => {
  if (allowedOrigins.includes(origin)) {
    response.headers.set("Access-Control-Allow-Origin", origin);
  }
  response.headers.set("Access-Control-Allow-Headers", "authorization, x-client-info, apikey, content-type");
  response.headers.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  return response;
};
const stripHtml = (value: string) =>
  String(value || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const normalizeSummary = (value: string) => {
  const summary = stripHtml(value || "").replace(/\u00a0/g, " ");
  return summary.length > 200 ? `${summary.slice(0, 197).trim()}...` : summary;
};

// Text from a feed field that may be a string, a number or an {#text} object.
const textOf = (value: unknown): string => {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return textOf(value[0]);
  if (typeof value === "object") {
    const v = value as Record<string, unknown>;
    return textOf(v["#text"] ?? v["@_href"] ?? v.href ?? "");
  }
  return String(value);
};

const safeIso = (value: unknown) => {
  const date = new Date(textOf(value));
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
};

type NewsItem = { title: string; link: string; source: string; published: string; summary: string };

// One feed: one request, 8 seconds at most. A broken feed returns nothing
// instead of failing the whole News section.
const readFeed = async (feed: { name: string; url: string }): Promise<NewsItem[]> => {
  const response = await fetch(feed.url, {
    headers: { "User-Agent": "BizTrackNews/1.0" },
    redirect: "follow",
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) return [];
  const xml = await response.text();
  if (!/<\s*(rss|feed|rdf|entry)[\s>:]/i.test(xml)) return [];
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", parseTagValue: true, trimValues: true });
  const doc = parser.parse(xml);
  const channels = [doc?.rss?.channel, doc?.feed, doc?.["rdf:RDF"], doc?.rdf?.channel].filter(Boolean);
  const entries: any[] = [];
  for (const channel of channels) {
    const list = channel?.item ?? channel?.entry ?? [];
    if (Array.isArray(list)) entries.push(...list);
    else if (list) entries.push(list);
  }
  const items: NewsItem[] = [];
  for (const item of entries) {
    const title = textOf(item.title ?? item?.["media:title"]).trim() || "Untitled";
    const link = textOf(item.link ?? item.guid ?? item.id).trim();
    if (!link.startsWith("http")) continue;
    const description = textOf(item.description ?? item.summary ?? item["content:encoded"] ?? item.content);
    items.push({
      title,
      link,
      source: feed.name,
      published: safeIso(item.pubDate ?? item.published ?? item.updated ?? item["dc:date"]),
      summary: normalizeSummary(description || title),
    });
  }
  return items;
};

const fetchFeedEntries = async () => {
  const results = await Promise.allSettled(FEEDS.map(readFeed));
  const items = results.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
  if (!items.length) throw new Error("No news sources could be reached right now.");

  const cleaned = Array.from(
    new Map(
      items
        .filter((item) => item.title && item.link)
        .map((item) => [item.link, item]),
    ).values(),
  )
    .filter((item, index, arr) => {
      const sameTitle = arr.filter((other) => other.title.toLowerCase() === item.title.toLowerCase()).length;
      return sameTitle <= 2;
    })
    .sort((a, b) => new Date(b.published).getTime() - new Date(a.published).getTime())
    .slice(0, 60);

  return cleaned;
};

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("Origin") || "";
  const method = req.method.toUpperCase();
  const allowedOrigin = allowedOrigins.some((candidate) => candidate === origin) || origin === "";

  if (method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        ...(allowedOrigin ? { "Access-Control-Allow-Origin": origin || "*" } : {}),
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
      },
    });
  }

  if (method !== "GET") {
    return withCors(new Response(JSON.stringify({ error: "Method not allowed." }), { status: 405, headers: { "Content-Type": "application/json" } }), origin);
  }

  const authHeader = req.headers.get("Authorization") || "";
  const bearerToken = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!bearerToken) {
    return withCors(new Response(JSON.stringify({ error: "Authenticated Supabase user required." }), { status: 401, headers: { "Content-Type": "application/json" } }), origin);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseAnonKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_ANON_KEY");
  if (!supabaseUrl || !supabaseAnonKey) {
    return withCors(new Response(JSON.stringify({ error: "Supabase Edge environment variables are missing." }), { status: 500, headers: { "Content-Type": "application/json" } }), origin);
  }

  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: `Bearer ${bearerToken}` } },
  });
  const { data: { user }, error } = await supabase.auth.getUser(bearerToken);
  if (error || !user) {
    return withCors(new Response(JSON.stringify({ error: "Your session is invalid or expired." }), { status: 401, headers: { "Content-Type": "application/json" } }), origin);
  }

  const cacheKey = "news-feed-cache";
  const cached = cache.get(cacheKey);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return withCors(new Response(JSON.stringify(cached.data), { headers: { "Content-Type": "application/json" } }), origin);
  }

  try {
    const items = await fetchFeedEntries();
    const payload = { items: items.slice(0, 60), generatedAt: new Date().toISOString() };
    cache.set(cacheKey, { expiresAt: now + CACHE_TTL_MS, data: payload });
    return withCors(new Response(JSON.stringify(payload), { headers: { "Content-Type": "application/json" } }), origin);
  } catch (error) {
    return withCors(new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Unable to load news right now." }), { status: 502, headers: { "Content-Type": "application/json" } }), origin);
  }
});
