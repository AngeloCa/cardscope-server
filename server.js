/**
 * CardScope Server
 * Minimal standalone backend for the CardScope Chrome extension.
 *
 * Endpoints:
 *   POST /identify  — Claude Vision: detect trading card from a video frame
 *   GET  /price     — Cardmarket scraping: fetch trend + low price for a card
 *
 * Environment variables:
 *   ANTHROPIC_API_KEY   — Anthropic API key (required)
 *   CARDSCOPE_SECRET    — Shared secret with the extension (required in production)
 *   PORT                — HTTP port (default: 3000)
 */

import Fastify from 'fastify';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_MODEL = 'claude-sonnet-4-6';
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 min

const CONDITION_MULTIPLIERS = { NM: 1.0, EX: 0.80, GD: 0.60, PO: 0.40 };
const CARDMARKET_GAME_PATHS = {
    Pokemon: 'Pokemon',
    MTG: 'Magic',
    YuGiOh: 'YuGiOh',
    Sports: 'Pokemon',
    other: 'Pokemon',
};

// In-memory price cache: key → { data, expiresAt }
const priceCache = new Map();

const app = Fastify({ logger: false });

// ─── CORS (extension can call from any origin) ────────────────────────────────
app.addHook('onRequest', (request, reply, done) => {
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Access-Control-Allow-Headers', 'content-type, x-cardscope-secret');
    reply.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (request.method === 'OPTIONS') {
        reply.code(204).send();
        return;
    }
    done();
});

// ─── Secret check ─────────────────────────────────────────────────────────────
function checkSecret(request, reply) {
    const secret = process.env.CARDSCOPE_SECRET;
    if (!secret) return true; // dev mode: no secret configured
    if (request.headers['x-cardscope-secret'] !== secret) {
        reply.code(401).send({ error: 'Unauthorized' });
        return false;
    }
    return true;
}

// ─── POST /identify ───────────────────────────────────────────────────────────
app.post('/identify', async (request, reply) => {
    if (!checkSecret(request, reply)) return;

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
        return reply.code(500).send({ error: 'ANTHROPIC_API_KEY not configured' });
    }

    const { image } = request.body ?? {};
    if (!image) return reply.code(400).send({ error: 'Missing image field' });

    const response = await fetch(ANTHROPIC_API_URL, {
        method: 'POST',
        headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
        },
        body: JSON.stringify({
            model: ANTHROPIC_MODEL,
            max_tokens: 256,
            messages: [
                {
                    role: 'user',
                    content: [
                        {
                            type: 'image',
                            source: { type: 'base64', media_type: 'image/jpeg', data: image },
                        },
                        {
                            type: 'text',
                            text: `Tu es un expert en cartes à collectionner (Pokemon, MTG, Yu-Gi-Oh, sports, etc.).
Analyse cette image. Si une carte de collection est clairement visible, retourne UNIQUEMENT ce JSON :
{"detected":true,"cardName":"nom officiel anglais","game":"Pokemon|MTG|YuGiOh|Sports|other","set":"nom du set ou null","cardNumber":"numéro ou null"}
Si aucune carte n'est clairement identifiable, retourne : {"detected":false}
Ne retourne que le JSON brut, sans markdown ni explication.`,
                        },
                    ],
                },
            ],
        }),
    });

    if (!response.ok) {
        const err = await response.text().catch(() => '');
        return reply.code(502).send({ error: `Claude API error: ${err.slice(0, 120)}` });
    }

    const data = await response.json();
    const text = data?.content?.[0]?.text ?? '';

    let parsed;
    try {
        parsed = JSON.parse(text.replace(/```[a-z]*\n?/gi, '').trim());
    } catch {
        return reply.send({ detected: false });
    }

    if (!parsed.detected) return reply.send({ detected: false });

    return reply.send({
        detected: true,
        cardName: parsed.cardName ?? null,
        game: parsed.game ?? 'other',
        set: parsed.set ?? null,
        cardNumber: parsed.cardNumber ?? null,
    });
});

// ─── GET /price ───────────────────────────────────────────────────────────────
app.get('/price', async (request, reply) => {
    if (!checkSecret(request, reply)) return;

    const { name, game = 'Pokemon', condition = 'NM' } = request.query ?? {};
    if (!name) return reply.code(400).send({ error: 'Missing name param' });

    const cacheKey = `${game}:${name}:${condition}`.toLowerCase();
    const cached = priceCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
        return reply.send(cached.data);
    }

    const gamePath = CARDMARKET_GAME_PATHS[game] ?? 'Pokemon';
    const cardmarketUrl = `https://www.cardmarket.com/fr/${gamePath}/Products/Singles?searchString=${encodeURIComponent(name)}`;

    const html = await fetchHtml(cardmarketUrl);
    const multiplier = CONDITION_MULTIPLIERS[condition] ?? 1.0;

    let trendPrice = null;
    let lowPrice = null;

    if (html) {
        const nmTrend = extractPrice(html, 'trendPrice') ?? extractPrice(html, 'trend-price');
        const nmLow = extractPrice(html, 'lowPrice') ?? extractPrice(html, 'low-price');
        if (nmTrend !== null) trendPrice = round2(nmTrend * multiplier);
        if (nmLow !== null) lowPrice = round2(nmLow * multiplier);
    }

    const result = { trendPrice, lowPrice, condition, currency: 'EUR', cardmarketUrl };
    priceCache.set(cacheKey, { data: result, expiresAt: Date.now() + CACHE_TTL_MS });

    return reply.send(result);
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/', async (request, reply) => {
    reply.send({ ok: true, service: 'CardScope Server' });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
async function fetchHtml(url) {
    try {
        const res = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml',
                'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
            },
        });
        if (!res.ok) return null;
        return res.text();
    } catch {
        return null;
    }
}

function extractPrice(html, key) {
    const jsonPattern = new RegExp(`"${key}"\\s*:\\s*([\\d]+(?:\\.[\\d]+)?)`, 'i');
    const jsonMatch = html.match(jsonPattern);
    if (jsonMatch) return parseFloat(jsonMatch[1]);

    const attrKey = key.replace(/([A-Z])/g, '-$1').toLowerCase();
    const attrPattern = new RegExp(`data-${attrKey}=["']([\\d]+(?:[.,][\\d]+)?)["']`, 'i');
    const attrMatch = html.match(attrPattern);
    if (attrMatch) return parseFloat(attrMatch[1].replace(',', '.'));

    return null;
}

function round2(n) {
    return Math.round(n * 100) / 100;
}

// ─── Start ────────────────────────────────────────────────────────────────────
const port = parseInt(process.env.PORT ?? '3000', 10);
await app.listen({ port, host: '0.0.0.0' });
console.log(`CardScope Server running on http://0.0.0.0:${port}`);
