// api/claude-proxy.js
// Deploy target: Vercel Edge Function (works basically unchanged on Cloudflare Workers too)
//
// This is the ONLY place that should ever hold the real Anthropic API key.
// Your frontend calls THIS endpoint instead of api.anthropic.com directly.

export const config = { runtime: 'edge' };

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY; // set in Vercel/Cloudflare project settings — never shipped to the client
const MODEL = 'claude-sonnet-4-6';

// --- Naive in-memory rate limit -------------------------------------------
// Fine for a first deploy / low traffic. Edge functions can spin up multiple
// isolated instances, so this map isn't shared globally — for real scale,
// swap this block for Upstash Redis (a few lines, same idea, works across
// every instance) or your database's rate-limit table.
const requestLog = new Map();
const RATE_LIMIT = 30;      // max requests...
const WINDOW_MS = 60_000;   // ...per rolling 60 seconds, per user

function isRateLimited(userId) {
  const now = Date.now();
  const entry = requestLog.get(userId) || { count: 0, windowStart: now };
  if (now - entry.windowStart > WINDOW_MS) {
    entry.count = 0;
    entry.windowStart = now;
  }
  entry.count += 1;
  requestLog.set(userId, entry);
  return entry.count > RATE_LIMIT;
}

// --- Auth check -------------------------------------------------------------
// Verifies the Supabase access token the frontend sends, so only logged-in
// users can spend your API budget. Requires SUPABASE_URL and
// SUPABASE_ANON_KEY as env vars too.
async function getVerifiedUserId(token) {
  if (!token) return null;
  try {
    const res = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: process.env.SUPABASE_ANON_KEY,
      },
    });
    if (!res.ok) return null;
    const user = await res.json();
    return user?.id || null;
  } catch {
    return null;
  }
}

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const authHeader = req.headers.get('authorization') || '';
  const token = authHeader.replace('Bearer ', '');
  const userId = await getVerifiedUserId(token);
  if (!userId) {
    return new Response(JSON.stringify({ error: 'Not authenticated' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (isRateLimited(userId)) {
    return new Response(JSON.stringify({ error: 'Rate limit exceeded, try again shortly' }), {
      status: 429,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { system, messages, max_tokens = 1000 } = body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return new Response(JSON.stringify({ error: 'Missing "messages" array' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Hard cap so one request can't ask for an absurd amount of output.
  const cappedMaxTokens = Math.min(max_tokens, 2000);

  const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: cappedMaxTokens,
      system,
      messages,
    }),
  });

  const data = await anthropicRes.json();
  return new Response(JSON.stringify(data), {
    status: anthropicRes.status,
    headers: { 'Content-Type': 'application/json' },
  });
}
