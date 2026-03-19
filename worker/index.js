/**
 * Cloudflare Worker — Yahoo Finance CORS Proxy
 *
 * Accepts requests like:
 *   GET /?ticker=CL%3DF&range=1y&interval=1d
 *
 * Forwards them to Yahoo Finance's chart API, returns the JSON response
 * with proper CORS headers so the browser doesn't block it.
 */

// Which origins are allowed to call this worker.
// Set to "*" to allow any origin (fine for public read-only market data),
// or lock it down to your GitHub Pages domain for safety.
const ALLOWED_ORIGINS = [
  "https://airplaneian.github.io",
  "http://localhost:5500",        // VS Code Live Server
  "http://127.0.0.1:5500",
  "http://localhost:3000",
  "http://localhost:8080",
];

function corsHeaders(request) {
  const origin = request.headers.get("Origin") || "";
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];

  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

export default {
  async fetch(request, env) {
    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    if (request.method !== "GET") {
      return new Response("Method not allowed", { status: 405, headers: corsHeaders(request) });
    }

    const url = new URL(request.url);
    const ticker = url.searchParams.get("ticker");
    const range = url.searchParams.get("range") || "1y";
    const interval = url.searchParams.get("interval") || "1d";

    if (!ticker) {
      return new Response(
        JSON.stringify({ error: "Missing required 'ticker' query parameter" }),
        { status: 400, headers: { ...corsHeaders(request), "Content-Type": "application/json" } }
      );
    }

    const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=${range}&interval=${interval}`;

    try {
      const yahooResponse = await fetch(yahooUrl, {
        headers: {
          // Mimic a normal browser request so Yahoo doesn't reject us
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        },
      });

      const data = await yahooResponse.text();

      return new Response(data, {
        status: yahooResponse.status,
        headers: {
          ...corsHeaders(request),
          "Content-Type": "application/json",
          // Cache market data for 5 minutes at the edge to reduce Yahoo hits
          "Cache-Control": "public, max-age=300, s-maxage=300",
        },
      });
    } catch (err) {
      return new Response(
        JSON.stringify({ error: "Failed to fetch from Yahoo Finance", details: err.message }),
        { status: 502, headers: { ...corsHeaders(request), "Content-Type": "application/json" } }
      );
    }
  },
};
