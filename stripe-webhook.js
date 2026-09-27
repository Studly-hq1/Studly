// backend/api/stripe-webhook.js
// Deploy target: Vercel Edge Function (or Cloudflare Worker with minor tweaks)
//
// Point your Stripe webhook endpoint at this URL. It verifies the request
// really came from Stripe, then writes to Supabase using the service-role
// key (server-only — this is the one key allowed to bypass Row Level
// Security, which is exactly why only this trusted server code holds it).

export const config = { runtime: 'edge' };

const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// --- Verify the "Stripe-Signature" header without pulling in the Stripe SDK ---
// (keeps this dependency-free; the SDK's async webhook verification works
// fine on Edge runtimes too, if you'd rather use `stripe.webhooks.constructEventAsync`)
async function verifyStripeSignature(payload, sigHeader, secret) {
  if (!sigHeader) return false;
  const parts = Object.fromEntries(sigHeader.split(',').map((p) => p.split('=')));
  const signedPayload = `${parts.t}.${payload}`;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sigBuffer = await crypto.subtle.sign('HMAC', key, enc.encode(signedPayload));
  const expected = Array.from(new Uint8Array(sigBuffer)).map((b) => b.toString(16).padStart(2, '0')).join('');
  return expected === parts.v1;
}

async function supabaseRequest(path, method, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) console.error('Supabase request failed:', path, await res.text());
  return res.json().catch(() => null);
}

export default async function handler(req) {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const payload = await req.text();
  const sig = req.headers.get('stripe-signature');
  const valid = await verifyStripeSignature(payload, sig, STRIPE_WEBHOOK_SECRET);
  if (!valid) return new Response('Invalid signature', { status: 400 });

  const event = JSON.parse(payload);

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      const userId = session.metadata?.user_id || session.client_reference_id;
      const kind = session.metadata?.kind; // 'premium' | 'exam_pass'
      const examId = session.metadata?.exam_id || null;
      if (!userId || !kind) break;

      await supabaseRequest('purchases', 'POST', {
        user_id: userId,
        type: kind,
        exam_id: examId,
        stripe_customer_id: session.customer,
        stripe_subscription_id: session.subscription || null,
        status: 'active',
      });

      if (kind === 'premium') {
        await supabaseRequest(`app_state?user_id=eq.${userId}`, 'PATCH', { is_premium: true });
      } else if (kind === 'exam_pass') {
        await supabaseRequest(`app_state?user_id=eq.${userId}`, 'PATCH', { exam_pass: examId });
      }
      break;
    }

    case 'customer.subscription.deleted': {
      const sub = event.data.object;
      // Find which user this subscription belonged to via our own purchases
      // record (Stripe's event doesn't carry our user_id directly here).
      const rows = await supabaseRequest(
        `purchases?stripe_subscription_id=eq.${sub.id}&select=user_id&limit=1`,
        'GET'
      );
      const userId = rows?.[0]?.user_id;
      if (userId) {
        await supabaseRequest(`app_state?user_id=eq.${userId}`, 'PATCH', { is_premium: false });
        await supabaseRequest(`purchases?stripe_subscription_id=eq.${sub.id}`, 'PATCH', { status: 'cancelled' });
      }
      break;
    }

    default:
      // Ignore other event types — add cases as you need them
      // (e.g. invoice.payment_failed to warn a user their card was declined).
      break;
  }

  return new Response(JSON.stringify({ received: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
