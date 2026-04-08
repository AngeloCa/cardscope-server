/**
 * CardScope Server
 * Minimal standalone backend for the CardScope Chrome extension.
 *
 * Endpoints:
 *   POST /identify  — Claude Vision: detect trading card from a video frame
 *   GET  /price     — JustTCG API: fetch condition-based market price for a card
 *
 * Environment variables:
 *   ANTHROPIC_API_KEY   — Anthropic API key (required)
 *   JUSTTCG_API_KEY     — JustTCG API key (required)
 *   CARDSCOPE_SECRET    — Shared secret with the extension (required in production)
 *   PORT                — HTTP port (default: 3000)
 */

import Fastify from 'fastify';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_MODEL = 'claude-sonnet-4-6';
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 min

const JUSTTCG_API_URL = 'https://api.justtcg.com/v1';

// JustTCG game IDs
const JUSTTCG_GAME_MAP = {
    Pokemon: 'pokemon',
    MTG: 'magic-the-gathering',
    YuGiOh: 'yugioh',
    Sports: null, // not supported by JustTCG
    other: null,
};

// CardScope condition → JustTCG condition label
const CONDITION_MAP = {
    NM: 'Near Mint',
    EX: 'Lightly Played',
    GD: 'Moderately Played',
    PO: 'Damaged',
};

// Approximate USD → EUR conversion rate (update periodically)
const USD_TO_EUR = 0.92;

// In-memory price cache: key → { data, expiresAt }
const priceCache = new Map();

// Set catalog cache per game: gameId → { sets: [{id, name}], expiresAt }
const setsCache = new Map();
const SETS_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

const app = Fastify({ logger: false });

// ─── CORS ─────────────────────────────────────────────────────────────────────
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
    if (!secret) return true;
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
    if (!apiKey) return reply.code(500).send({ error: 'ANTHROPIC_API_KEY not configured' });

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
Analyse cette image. Si UNE carte de collection à l'unité (single) est clairement visible, retourne UNIQUEMENT ce JSON :
{"detected":true,"cardName":"nom officiel anglais","game":"Pokemon|MTG|YuGiOh|Sports|other","set":"nom du set ou null","cardNumber":"numéro ou null"}
IMPORTANT : retourne {"detected":false} dans tous ces cas :
- Booster pack, display, coffret, bundle, produit scellé (même si une carte est imprimée dessus)
- Deck préconstruit, tin box, ETB (Elite Trainer Box)
- Aucune carte individuelle clairement identifiable
- Image floue ou carte pas en centre de l'image
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

    const { name, game = 'Pokemon', set, cardNumber, condition = 'NM' } = request.query ?? {};
    if (!name) return reply.code(400).send({ error: 'Missing name param' });

    const justtcgKey = process.env.JUSTTCG_API_KEY;
    if (!justtcgKey) return reply.code(500).send({ error: 'JUSTTCG_API_KEY not configured' });

    const cacheKey = `justtcg:${game}:${name}:${cardNumber ?? ''}:${condition}`.toLowerCase();
    const cached = priceCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
        return reply.send(cached.data);
    }

    const priceData = await fetchJustTCGPrice(justtcgKey, name, game, set, cardNumber, condition);

    priceCache.set(cacheKey, { data: priceData, expiresAt: Date.now() + CACHE_TTL_MS });
    return reply.send(priceData);
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/', async (request, reply) => {
    reply.send({ ok: true, service: 'CardScope Server' });
});

// ─── JustTCG helpers ──────────────────────────────────────────────────────────

async function fetchJustTCGPrice(apiKey, name, game, set, cardNumber, condition) {
    const gameId = JUSTTCG_GAME_MAP[game] ?? 'pokemon';
    const targetCondition = CONDITION_MAP[condition] ?? 'Near Mint';
    const justtcgUrl = `https://www.justtcg.com/search?q=${encodeURIComponent(name)}`;

    try {
        // Step 1: Resolve set name → JustTCG set slug (fuzzy match, cached 24h)
        let setId = null;
        if (set && gameId) {
            setId = await resolveSetId(apiKey, gameId, set);
        }

        // Step 2: Search by name + set (if resolved)
        const params = new URLSearchParams({ name, game: gameId, limit: '20' });
        if (setId) params.set('set', setId);

        const res = await fetch(`${JUSTTCG_API_URL}/cards?${params}`, {
            headers: { 'x-api-key': apiKey, 'Accept': 'application/json' },
        });

        if (!res.ok) return nullResult(condition, justtcgUrl);

        const data = await res.json();
        const cards = data?.data ?? [];

        // Step 3: Filter to singles only (sealed products have number = 'N/A')
        const singles = cards.filter(c => c.number && c.number !== 'N/A');
        if (!singles.length) return nullResult(condition, justtcgUrl);

        // Step 4: Match by card number (exact) if Claude Vision provided it
        let bestMatch = null;
        if (cardNumber) {
            // Normalize: "006/165" vs "6/165" — strip leading zeros in first part
            const normalizeNumber = n => n.replace(/^0+(\d)/, '$1');
            const targetNum = normalizeNumber(cardNumber);
            bestMatch = singles.find(c => normalizeNumber(c.number) === targetNum);
        }

        // Fallback: best name match
        if (!bestMatch) {
            const normalizedSearch = normStr(name);
            bestMatch = singles.find(c => normStr(c.name).includes(normalizedSearch))
                ?? singles.find(c => normalizedSearch.includes(normStr(c.name)))
                ?? singles[0];
        }

        // Step 5: Find variant for requested condition
        const variants = bestMatch.variants ?? [];
        const targetVariant = variants.find(v => v.condition === targetCondition)
            ?? variants.find(v => v.condition === 'Near Mint')
            ?? variants[0];

        if (!targetVariant) return nullResult(condition, justtcgUrl);

        // Step 6: Convert USD cents → EUR
        const currentPriceUSD = (targetVariant.price ?? 0) / 100;
        const avg30dUSD = (targetVariant.avgPrice30d ?? targetVariant.avgPrice ?? targetVariant.price ?? 0) / 100;
        const trendPrice = round2(avg30dUSD * USD_TO_EUR);
        const lowPrice = round2(currentPriceUSD * USD_TO_EUR);

        return {
            trendPrice: trendPrice > 0 ? trendPrice : null,
            lowPrice: lowPrice > 0 ? lowPrice : null,
            condition: targetVariant.condition,
            currency: 'EUR',
            cardName: bestMatch.name,
            setName: bestMatch.set_name,
            cardNumber: bestMatch.number,
            justtcgUrl,
            source: 'justtcg',
        };
    } catch {
        return nullResult(condition, justtcgUrl);
    }
}

/**
 * Resolves a human-readable set name (from Claude Vision) to a JustTCG set slug.
 * Fetches all sets for the game once per 24h and does fuzzy string matching.
 */
async function resolveSetId(apiKey, gameId, setName) {
    // Check cache
    const cacheEntry = setsCache.get(gameId);
    let sets;
    if (cacheEntry && cacheEntry.expiresAt > Date.now()) {
        sets = cacheEntry.sets;
    } else {
        // Fetch all sets for this game (paginate up to 200)
        try {
            const res = await fetch(`${JUSTTCG_API_URL}/sets?game=${gameId}&limit=200`, {
                headers: { 'x-api-key': apiKey, 'Accept': 'application/json' },
            });
            if (!res.ok) return null;
            const data = await res.json();
            sets = data?.data ?? [];
            setsCache.set(gameId, { sets, expiresAt: Date.now() + SETS_CACHE_TTL_MS });
        } catch {
            return null;
        }
    }

    // Fuzzy match: normalize both strings and find best overlap
    const normalizedInput = normStr(setName);
    const scored = sets.map(s => ({
        id: s.id,
        score: overlapScore(normStr(s.name), normalizedInput),
    }));
    scored.sort((a, b) => b.score - a.score);
    const best = scored[0];
    return best && best.score > 0 ? best.id : null;
}

/** Normalize string: lowercase, remove special chars, keep digits */
function normStr(s) {
    return (s ?? '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

/** Overlap score: count shared words between two normalized strings */
function overlapScore(a, b) {
    const wordsA = new Set(a.split(' '));
    const wordsB = new Set(b.split(' '));
    let count = 0;
    for (const w of wordsA) {
        if (w.length > 1 && wordsB.has(w)) count++;
    }
    return count;
}

function nullResult(condition, justtcgUrl) {
    return {
        trendPrice: null,
        lowPrice: null,
        condition,
        currency: 'EUR',
        justtcgUrl,
        source: 'justtcg',
    };
}

function round2(n) {
    return Math.round(n * 100) / 100;
}

// ─── Start ────────────────────────────────────────────────────────────────────
const port = parseInt(process.env.PORT ?? '3000', 10);
await app.listen({ port, host: '0.0.0.0' });
console.log(`CardScope Server running on http://0.0.0.0:${port}`);
