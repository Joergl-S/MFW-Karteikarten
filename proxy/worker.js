/**
 * Cloudflare Worker: minimaler CORS-Proxy für die Brickognize-API.
 *
 * Nur nötig, falls der Browser direkte Anfragen an api.brickognize.com blockiert (CORS).
 * Leitet ausschließlich POST /predict/… an https://api.brickognize.com weiter und
 * erlaubt nur die eigene App-Adresse (ALLOWED_ORIGIN) als Aufrufer.
 *
 * Einrichtung: siehe proxy/README.md
 */

const UPSTREAM = 'https://api.brickognize.com';

export default {
  async fetch(request, env) {
    const allowed = (env.ALLOWED_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
    const origin = request.headers.get('Origin') || '';
    const okOrigin = allowed.length === 0 || allowed.includes(origin);
    const cors = {
      'Access-Control-Allow-Origin': okOrigin ? (origin || '*') : 'null',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Accept',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin',
    };

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (!okOrigin) return new Response('Origin nicht erlaubt', { status: 403, headers: cors });

    const url = new URL(request.url);
    if (request.method !== 'POST' || !url.pathname.startsWith('/predict/')) {
      return new Response('Nur POST /predict/… erlaubt', { status: 404, headers: cors });
    }

    const upstream = await fetch(UPSTREAM + url.pathname + url.search, {
      method: 'POST',
      headers: { 'Content-Type': request.headers.get('Content-Type') || '', Accept: 'application/json' },
      body: request.body,
    });
    const headers = new Headers(cors);
    headers.set('Content-Type', upstream.headers.get('Content-Type') || 'application/json');
    const ra = upstream.headers.get('Retry-After');
    if (ra) { headers.set('Retry-After', ra); headers.set('Access-Control-Expose-Headers', 'Retry-After'); }
    return new Response(upstream.body, { status: upstream.status, headers });
  },
};
