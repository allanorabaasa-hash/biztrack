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
  "http://localhost:8000",
  "http://localhost:8080",
  "http://127.0.0.1:8000",
  "http://127.0.0.1:8080",
];

const withCors = (response: Response) => {
  const origin = response.headers.get("Access-Control-Allow-Origin");
  if (!origin) {
    response.headers.set("Access-Control-Allow-Origin", "*");
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

const isValidFeedUrl = async (url: string) => {
  try {
    const response = await fetch(url, { headers: { "User-Agent": "BizTrackNews/1.0" }, redirect: "follow" });
    if (!response.ok) return false;
    const text = await response.text();
    return /<\s*(rss|feed|rdf)[\s>]/i.test(text) || /<\s*entry[\s>]/i.test(text);
  } catch {
    return false;
  }
};

const fetchFeedEntries = async () => {
  const validFeeds = [] as Array<{ name: string; url: string }>;
  for (const feed of FEEDS) {
    const ok = await isValidFeedUrl(feed.url);
    if (ok) validFeeds.push(feed);
  }
  if (!validFeeds.length) {
    throw new Error("No valid feed URLs were reachable.");
  }
  const items: Array<{ title: string; link: string; source: string; published: string; summary: string }> = [];
  for (const feed of validFeeds) {
    try {
      const response = await fetch(feed.url, { headers: { "User-Agent": "BizTrackNews/1.0" }, redirect: "follow" });
      if (!response.ok) continue;
      const xml = await response.text();
      const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", parseTagValue: true, trimValues: true, parseNodeValue: true });
      const doc = parser.parse(xml);
      const channels = [doc?.rss?.channel, doc?.feed, doc?.rdf?.channel].filter(Boolean);
      const entries = [] as any[];
      for (const channel of channels) {
        const list = channel?.item ?? channel?.entry ?? [];
        if (Array.isArray(list)) entries.push(...list);
        else if (list) entries.push(list);
      }
      for (const item of entries) {
        const title = item.title ?? item?."media:title" ?? "Untitled";
        const link = item.link?.['@_href'] ?? item.link ?? item.guid ?? item.id ?? "";
        const pub = item.pubDate || item.published || item.updated || item['dc:date'] || new Date().toISOString();
        const description = item.description ?? item.summary ?? item.content ?? item['content:encoded'] ?? "";
        const cleanedLink = Array.isArray(link) ? link[0] : (typeof link === "object" ? link?.['@_href'] ?? link?.href ?? "" : link);
        if (!cleanedLink) continue;
        items.push({
          title: String(title).trim(),
          link: String(cleanedLink).trim(),
          source: feed.name,
          published: new Date(pub).toISOString(),
          summary: normalizeSummary(String(description || title)),
        });
      }
    } catch {
      continue;
    }
  }

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
        "Access-Control-Allow-Origin": allowedOrigin ? origin || "*" : "*",
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
      },
    });
  }

  if (method !== "GET") {
    return withCors(new Response(JSON.stringify({ error: "Method not allowed." }), { status: 405, headers: { "Content-Type": "application/json" } }));
  }

  const authHeader = req.headers.get("Authorization") || "";
  const bearerToken = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!bearerToken) {
    return withCors(new Response(JSON.stringify({ error: "Authenticated Supabase user required." }), { status: 401, headers: { "Content-Type": "application/json" } }));
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseAnonKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_ANON_KEY");
  if (!supabaseUrl || !supabaseAnonKey) {
    return withCors(new Response(JSON.stringify({ error: "Supabase Edge environment variables are missing." }), { status: 500, headers: { "Content-Type": "application/json" } }));
  }

  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: `Bearer ${bearerToken}` } },
  });
  const { data: { user }, error } = await supabase.auth.getUser(bearerToken);
  if (error || !user) {
    return withCors(new Response(JSON.stringify({ error: "Your session is invalid or expired." }), { status: 401, headers: { "Content-Type": "application/json" } }));
  }

  const cacheKey = "news-feed-cache";
  const cached = cache.get(cacheKey);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return withCors(new Response(JSON.stringify(cached.data), { headers: { "Content-Type": "application/json" } }));
  }

  try {
    const items = await fetchFeedEntries();
    const payload = { items: items.slice(0, 60), generatedAt: new Date().toISOString() };
    cache.set(cacheKey, { expiresAt: now + CACHE_TTL_MS, data: payload });
    return withCors(new Response(JSON.stringify(payload), { headers: { "Content-Type": "application/json" } }));
  } catch (error) {
    return withCors(new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Unable to load news right now." }), { status: 502, headers: { "Content-Type": "application/json" } }));
  }
});
