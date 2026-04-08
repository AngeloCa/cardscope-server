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

const app = Fastify({ logger: true });

// ─── Anthropic request queue ───────────────────────────────────────────────────
// Serialises calls to Claude to avoid 429 rate-limit bursts.
// Max 1 concurrent request; extras wait in line (FIFO).
let anthropicBusy = false;
const anthropicQueue = [];

function enqueueAnthropicCall(fn) {
    return new Promise((resolve, reject) => {
        anthropicQueue.push({ fn, resolve, reject });
        drainAnthropicQueue();
    });
}

function drainAnthropicQueue() {
    if (anthropicBusy || anthropicQueue.length === 0) return;
    anthropicBusy = true;
    const { fn, resolve, reject } = anthropicQueue.shift();
    fn()
        .then(resolve)
        .catch(reject)
        .finally(() => {
            anthropicBusy = false;
            drainAnthropicQueue();
        });
}

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

// ─── Claude Vision: shared identify helper ────────────────────────────────────
const CLAUDE_PROMPT = `Tu es un expert en cartes à collectionner (Pokemon, MTG, Yu-Gi-Oh, sports, etc.).
Analyse cette image. Si une carte de collection à l'unité (single) est visible — même tenue à la main, sur le côté, ou partiellement visible — retourne UNIQUEMENT ce JSON :
{"detected":true,"cardName":"nom officiel anglais","game":"Pokemon|MTG|YuGiOh|Sports|other","set":"nom du set ou null","cardNumber":"numéro ou null","language":"EN|JP|FR|DE|IT|ES|PT|KR|ZH"}
Pour la langue : détecte la langue d'édition de la carte (JP=japonais, EN=anglais, FR=français, etc.).
Pour le set et le numéro : lis attentivement le bas de la carte où ils sont imprimés.
Retourne {"detected":false} UNIQUEMENT si :
- Booster pack, display, coffret, bundle ou produit scellé
- Deck préconstruit, tin box, ETB (Elite Trainer Box)
- Aucun élément de carte lisible (trop flou, trop petit, hors cadre)
Ne retourne que le JSON brut, sans markdown ni explication.`;

async function identifyFromBase64(apiKey, base64, mediaType = 'image/jpeg') {
    const claudeResponse = await enqueueAnthropicCall(() => fetch(ANTHROPIC_API_URL, {
        method: 'POST',
        headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
        },
        body: JSON.stringify({
            model: ANTHROPIC_MODEL,
            max_tokens: 256,
            messages: [{
                role: 'user',
                content: [
                    { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
                    { type: 'text', text: CLAUDE_PROMPT },
                ],
            }],
        }),
    }));

    if (!claudeResponse.ok) {
        const err = await claudeResponse.text().catch(() => '');
        console.log(`[identify] Claude HTTP ${claudeResponse.status}:`, err);
        throw new Error(`Claude API error ${claudeResponse.status}`);
    }

    const data = await claudeResponse.json();
    const text = data?.content?.[0]?.text ?? '';
    console.log('[identify] Claude raw:', text);

    let parsed;
    try {
        parsed = JSON.parse(text.replace(/```[a-z]*\n?/gi, '').trim());
    } catch {
        return { detected: false };
    }

    if (!parsed.detected) return { detected: false };
    return {
        detected: true,
        cardName: parsed.cardName ?? null,
        game: parsed.game ?? 'other',
        set: parsed.set ?? null,
        cardNumber: parsed.cardNumber ?? null,
        language: parsed.language ?? 'EN',
    };
}

// ─── POST /identify ───────────────────────────────────────────────────────────
app.post('/identify', async (request, reply) => {
    if (!checkSecret(request, reply)) return;

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return reply.code(500).send({ error: 'ANTHROPIC_API_KEY not configured' });

    const { image } = request.body ?? {};
    if (!image) return reply.code(400).send({ error: 'Missing image field' });

    try {
        const result = await identifyFromBase64(apiKey, image);
        return reply.send(result);
    } catch (e) {
        return reply.code(502).send({ error: e.message });
    }
});

// ─── POST /telegram (webhook) ─────────────────────────────────────────────────
app.post('/telegram', async (request, reply) => {
    // Respond immediately — Telegram requires fast ACK
    reply.code(200).send('ok');

    const token = process.env.TELEGRAM_BOT_TOKEN;
    const apiKey = process.env.ANTHROPIC_API_KEY;
    const justtcgKey = process.env.JUSTTCG_API_KEY;
    if (!token) return;

    const message = request.body?.message;
    if (!message) return;

    const chatId = message.chat.id;
    const photo = message.photo;

    if (!photo) {
        await tgSend(token, chatId,
            '📸 Envoie-moi une photo d\'une carte TCG et je te donne sa cote !\n\n' +
            'Tu peux aussi envoyer une photo depuis un live Voggt, Whatnot, Twitch…'
        );
        return;
    }

    await tgAction(token, chatId, 'typing');

    // Use largest available photo for best OCR accuracy
    const chosen = photo[photo.length - 1];

    // Download from Telegram
    let base64;
    try {
        const fileRes = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${chosen.file_id}`);
        const fileData = await fileRes.json();
        const filePath = fileData.result?.file_path;
        if (!filePath) throw new Error('No file path');
        const imgRes = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`);
        const buf = await imgRes.arrayBuffer();
        base64 = Buffer.from(buf).toString('base64');
    } catch (e) {
        await tgSend(token, chatId, '❌ Impossible de télécharger la photo.');
        return;
    }

    // Identify card
    let identified;
    try {
        identified = await identifyFromBase64(apiKey, base64, 'image/jpeg');
    } catch {
        await tgSend(token, chatId, '❌ Erreur lors de l\'analyse (serveur IA indisponible).');
        return;
    }

    if (!identified.detected) {
        await tgSend(token, chatId,
            '🔍 Carte non identifiée.\n\n' +
            'Conseils pour un meilleur résultat :\n' +
            '• Envoie un screenshot zoomé sur la carte\n' +
            '• Le nom et le numéro en bas de la carte doivent être lisibles\n' +
            '• Évite le mouvement (freeze frame si possible)'
        );
        return;
    }

    const { cardName, game, set, cardNumber, language } = identified;

    // Fetch price
    const priceData = await fetchJustTCGPrice(justtcgKey, cardName, game, set, cardNumber, 'NM', language ?? 'EN');

    // Build reply
    const langStr = language && language !== 'EN' ? ` 🌐 ${language}` : '';
    const meta = [set, cardNumber ? `#${cardNumber}` : null].filter(Boolean).join(' • ');
    const psaUrl = `https://www.ebay.fr/sch/i.html?_nkw=${encodeURIComponent('PSA 10 ' + cardName)}&LH_Complete=1&LH_Sold=1&_sop=13`;

    let text = `🃏 *${escTg(cardName)}*${langStr}\n`;
    if (meta) text += `📦 ${escTg(meta)}\n`;
    text += '\n';

    if (priceData.trendPrice != null) {
        text += `💰 Tendance: *${priceData.trendPrice.toFixed(2)} €*\n`;
        text += `📉 Prix bas: ${priceData.lowPrice?.toFixed(2) ?? '—'} €\n`;
    } else {
        text += `❓ Prix non disponible sur JustTCG\n`;
    }

    text += `\n[📊 Prix PSA 10 sur eBay](${psaUrl})`;
    if (priceData.justtcgUrl) text += ` | [🔗 JustTCG](${priceData.justtcgUrl})`;

    await tgSend(token, chatId, text, 'Markdown');
});

function escTg(str) {
    return String(str ?? '').replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

async function tgSend(token, chatId, text, parseMode) {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: parseMode, disable_web_page_preview: true }),
    }).catch(() => {});
}

async function tgAction(token, chatId, action) {
    await fetch(`https://api.telegram.org/bot${token}/sendChatAction`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, action }),
    }).catch(() => {});
}

// ─── GET /price ───────────────────────────────────────────────────────────────
app.get('/price', async (request, reply) => {
    if (!checkSecret(request, reply)) return;

    const { name, game = 'Pokemon', set, cardNumber, condition = 'NM', language = 'EN' } = request.query ?? {};
    console.log(`[price] name=${name} game=${game} set=${set} cardNumber=${cardNumber} condition=${condition} language=${language}`);
    if (!name) return reply.code(400).send({ error: 'Missing name param' });

    const justtcgKey = process.env.JUSTTCG_API_KEY;
    if (!justtcgKey) return reply.code(500).send({ error: 'JUSTTCG_API_KEY not configured' });

    const cacheKey = `justtcg:${game}:${name}:${cardNumber ?? ''}:${condition}:${language}`.toLowerCase();
    const cached = priceCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
        console.log('[price] cache hit');
        return reply.send(cached.data);
    }

    const priceData = await fetchJustTCGPrice(justtcgKey, name, game, set, cardNumber, condition, language);
    console.log('[price] result:', JSON.stringify(priceData));

    priceCache.set(cacheKey, { data: priceData, expiresAt: Date.now() + CACHE_TTL_MS });
    return reply.send(priceData);
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/', async (request, reply) => {
    reply.send({ ok: true, service: 'CardScope Server' });
});

// ─── JustTCG helpers ──────────────────────────────────────────────────────────

async function fetchJustTCGPrice(apiKey, name, game, set, cardNumber, condition, language = 'EN') {
    const gameId = JUSTTCG_GAME_MAP[game] ?? 'pokemon';
    const targetCondition = CONDITION_MAP[condition] ?? 'Near Mint';
    const justtcgUrl = `https://www.justtcg.com/search?q=${encodeURIComponent(name)}`;

    try {
        // Step 1: Resolve set name → JustTCG set slug (fuzzy match, cached 24h)
        let setId = null;
        if (set && gameId) {
            setId = await resolveSetId(apiKey, gameId, set, language);
        }

        // Step 2: Search by name + set (if resolved)
        const params = new URLSearchParams({ name, game: gameId, limit: '20' });
        if (setId) params.set('set', setId);

        const res = await fetch(`${JUSTTCG_API_URL}/cards?${params}`, {
            headers: { 'x-api-key': apiKey, 'Accept': 'application/json' },
        });

        if (!res.ok) return nullResult(condition, justtcgUrl, language);

        const data = await res.json();
        const cards = data?.data ?? [];

        // Step 3: Filter to singles only (sealed products have number = 'N/A')
        const singles = cards.filter(c => c.number && c.number !== 'N/A');
        if (!singles.length) return nullResult(condition, justtcgUrl, language);

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

        if (!targetVariant) return nullResult(condition, justtcgUrl, language);

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
            language,
            justtcgUrl,
            source: 'justtcg',
        };
    } catch {
        return nullResult(condition, justtcgUrl, language);
    }
}

/**
 * Resolves a human-readable set name (from Claude Vision) to a JustTCG set slug.
 * Fetches all sets for the game once per 24h and does fuzzy string matching.
 */
async function resolveSetId(apiKey, gameId, setName, language = 'EN') {
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

    // Language-aware filtering: JP cards → prefer japanese sets, others → exclude japanese sets
    const isJapanese = language === 'JP';
    const filteredSets = sets.filter(s => {
        const nameLC = (s.name ?? '').toLowerCase();
        const idLC = (s.id ?? '').toLowerCase();
        const isJpSet = nameLC.includes('japanese') || idLC.includes('japanese') || nameLC.includes('japan');
        return isJapanese ? isJpSet : !isJpSet;
    });

    // Use filtered list; fall back to all sets if no match in filtered
    const candidateSets = filteredSets.length > 0 ? filteredSets : sets;

    // Fuzzy match: normalize both strings and find best overlap
    const normalizedInput = normStr(setName);
    const scored = candidateSets.map(s => ({
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

function nullResult(condition, justtcgUrl, language = 'EN') {
    return {
        trendPrice: null,
        lowPrice: null,
        condition,
        currency: 'EUR',
        language,
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

// Register Telegram webhook after server is up
const tgToken = process.env.TELEGRAM_BOT_TOKEN;
const publicUrl = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : null;

if (tgToken && publicUrl) {
    const webhookUrl = `${publicUrl}/telegram`;
    const res = await fetch(`https://api.telegram.org/bot${tgToken}/setWebhook?url=${encodeURIComponent(webhookUrl)}`);
    const data = await res.json();
    console.log('[telegram] webhook set:', webhookUrl, '→', data.description ?? data.ok);
}
console.log(`CardScope Server running on http://0.0.0.0:${port}`);
