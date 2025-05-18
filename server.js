// index.js
// Node.js Express backend: Telegram MiniApp init, gift verification & marketplace

const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');

// Конфигурация через окружение
const BOT_TOKEN      = process.env.BOT_TOKEN;
const apiId          = Number(process.env.API_ID);
const apiHash        = process.env.API_HASH;
const SESSION_STRING = process.env.SESSION_STRING || '';

if (!BOT_TOKEN || !apiId || !apiHash) {
  console.error('Environment variables BOT_TOKEN, API_ID or API_HASH are missing');
  process.exit(1);
}

// Инициализация MTProto клиента из SESSION_STRING
const stringSession = new StringSession(SESSION_STRING);
const mtClient = new TelegramClient(stringSession, apiId, apiHash, {
  connectionRetries: 5
});

(async () => {
  try {
    await mtClient.start({ botAuthToken: BOT_TOKEN });
    const newSession = mtClient.session.save();
    console.log('=== NEW SESSION STRING ===');
    console.log(newSession);
    console.log('==========================');
    console.log('MTProto client is ready');
  } catch (err) {
    console.error('Error initializing MTProto client:', err);
    process.exit(1);
  }
})();

const app = express();
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// In-memory stores
const giftStore = new Map();            // slug -> metadata
const sellList  = [];                   // array of { gift, sellerId, price }

// Helpers
function normalizeUrl(url) {
  return /^https?:\/\//i.test(url) ? url : 'https://' + url;
}

// POST /api/init
app.post('/api/init', (req, res) => {
  const { initData, initDataUnsafe } = req.body;
  if (!initData || !initDataUnsafe?.user) {
    return res.status(400).json({ error: 'Invalid init payload' });
  }
  const user = initDataUnsafe.user;
  const uniqueId = `U${user.id}`;
  console.log(`Init for user ${user.id}`);
  // TODO: fetch real balance from DB
  res.json({ balance: 0, unique_id: uniqueId });
});

// POST /api/check-gift
app.post('/api/check-gift', async (req, res) => {
  let { url, userId } = req.body;
  if (!url || !userId) {
    return res.status(400).json({ error: 'Missing url or userId' });
  }
  url = normalizeUrl(url);

  try {
    const slug = url.split('/').pop();
    if (!slug) throw { status: 400, error: 'Invalid URL format' };

    // parse metadata if not cached
    if (!giftStore.has(slug)) {
      const { data: html } = await axios.get(url);
      const $ = cheerio.load(html);
      const table = $('table.tgme_gift_table');
      if (!table.length) throw { status: 404, error: 'Gift not found' };

      const parseRow = name => {
        const row = table.find(`tr:has(th:contains("${name}"))`);
        const text = row.find('td').text().replace(/\s*\d+(\.\d+)?%/, '').trim();
        const rarity = parseFloat(row.find('mark').text()) || 0;
        return { text, rarity };
      };
      const title   = slug.split('-')[0];
      const imgUrl  = `https://nft.fragment.com/gift/${slug}.webp`;
      const animUrl = `https://nft.fragment.com/gift/${slug}.lottie.json`;
      const m = parseRow('Model');
      const b = parseRow('Backdrop');
      const s = parseRow('Symbol');

      giftStore.set(slug, {
        slug,
        title,
        model: m.text,
        model_rarity: m.rarity,
        backdrop: b.text,
        backdrop_rarity: b.rarity,
        symbol: s.text,
        symbol_rarity: s.rarity,
        imgUrl,
        animUrl
      });
    }
    const gift = giftStore.get(slug);

    // owner check via MTProto
    const { data: ownerHtml } = await axios.get(url);
    const $o = cheerio.load(ownerHtml);
    const ownerLink = $o('tr:has(th:contains("Owner")) td a').attr('href');
    if (!ownerLink) throw { status: 403, error: 'Gift is hidden' };
    const username = ownerLink.split('/').pop();
    const entity = await mtClient.getEntity(username);
    if (Number(entity.id) !== userId) throw { status: 403, error: 'Not owner' };

    res.json({ owned: true, gift });
  } catch (err) {
    console.error('Error /api/check-gift:', err);
    const status = err.status || 500;
    res.status(status).json({ error: err.error || err.message });
  }
});

// GET /api/sell-list
app.get('/api/sell-list', (req, res) => {
  res.json({ list: sellList });
});

// POST /api/sell
app.post('/api/sell', (req, res) => {
  const { gift, sellerId, price } = req.body;
  if (!gift || !sellerId || typeof price !== 'number') {
    return res.status(400).json({ error: 'Missing fields' });
  }
  sellList.push({ gift, sellerId, price });
  res.json({ success: true });
});

// POST /api/sell-remove
app.post('/api/sell-remove', (req, res) => {
  const { slug, sellerId } = req.body;
  const idx = sellList.findIndex(item => item.gift.slug === slug && item.sellerId === sellerId);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  sellList.splice(idx, 1);
  res.json({ success: true });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on ${PORT}`));
