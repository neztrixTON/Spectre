// index.js
// Node.js Express backend: Telegram MiniApp init & gift verification

const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');

// Конфигурация через окружение
const BOT_TOKEN = process.env.BOT_TOKEN;
const apiId = Number(process.env.API_ID);
const apiHash = process.env.API_HASH;
const SESSION_STRING = process.env.SESSION_STRING || '';

if (!BOT_TOKEN || !apiId || !apiHash) {
  console.error('Не заданы BOT_TOKEN, API_ID или API_HASH в окружении');
  process.exit(1);
}

// Инициализация MTProto клиента из env SESSION_STRING
const stringSession = new StringSession(SESSION_STRING);
const mtClient = new TelegramClient(stringSession, apiId, apiHash, { connectionRetries: 5 });

(async () => {
  try {
    await mtClient.start({ botAuthToken: BOT_TOKEN });
    const newSession = mtClient.session.save();
    console.log('=== NEW SESSION STRING ===');
    console.log(newSession);
    console.log('==========================');
    console.log('MTProto client is ready');
  } catch (err) {
    console.error('Ошибка при инициализации MTProto клиента:', err);
    process.exit(1);
  }
})();

const app = express();
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// Кэш метаданных подарков
const giftStore = new Map();
const sellList = [];

// Инициализация
app.post('/api/init', (req, res) => {
  const { initData, initDataUnsafe } = req.body;
  if (!initData || !initDataUnsafe || !initDataUnsafe.user) {
    return res.status(400).json({ error: 'Invalid init payload', errorType: 'invalid_init' });
  }
  const user = initDataUnsafe.user;
  const uniqueId = `U${user.id}`;
  console.log(`Init for user ${user.id}`);
  res.json({ balance: 0, unique_id: uniqueId });
});

// Проверка подарка
app.post('/api/check-gift', async (req, res) => {
  let { url, userId } = req.body;
  if (!url || !userId) {
    return res.status(400).json({ error: 'Missing url or userId', errorType: 'missing_params' });
  }

  if (!/^https?:\/\//i.test(url)) {
    url = 'https://' + url;
  }

  try {
    const slug = url.split('/').pop();
    if (!slug) {
      return res.status(400).json({ error: 'Invalid URL format', errorType: 'invalid_url' });
    }

    if (!giftStore.has(slug)) {
      const { data: html } = await axios.get(url);
      const $ = cheerio.load(html);
      const table = $('table.tgme_gift_table');
      if (!table.length) {
        return res.status(404).json({ error: 'Gift not found', errorType: 'not_found' });
      }

      const parseRow = name => {
        const row = table.find(`tr:has(th:contains("${name}"))`);
        const text = row.find('td').text().replace(/\s*\d+(\.\d+)?%/, '').trim();
        const rarity = parseFloat(row.find('mark').text()) || 0;
        return { text, rarity };
      };

      const title = slug.split('-')[0];
      const imgUrl = `https://nft.fragment.com/gift/${slug}.webp`;
      const animUrl = `https://nft.fragment.com/gift/${slug}.lottie.json`;
      const m = parseRow('Model');
      const b = parseRow('Backdrop');
      const s = parseRow('Symbol');

      giftStore.set(slug, {
        slug, title,
        model: m.text, model_rarity: m.rarity,
        backdrop: b.text, backdrop_rarity: b.rarity,
        symbol: s.text, symbol_rarity: s.rarity,
        imgUrl, animUrl
      });
    }

    const gift = giftStore.get(slug);
    const { data: ownerHtml } = await axios.get(url);
    const $o = cheerio.load(ownerHtml);
    const ownerLink = $o('tr:has(th:contains("Owner")) td a').attr('href');
    if (!ownerLink) {
      return res.status(403).json({ error: 'Gift is hidden in profile', errorType: 'hidden' });
    }
    const username = ownerLink.split('/').pop();
    const entity = await mtClient.getEntity(username);
    if (Number(entity.id) !== userId) {
      return res.status(403).json({ error: 'You are not the owner', errorType: 'not_owner' });
    }

    res.json({ owned: true, gift });
  } catch (err) {
    console.error('Error in /api/check-gift:', err);
    res.status(500).json({ error: err.message, errorType: 'server_error' });
  }
});

// Список лотов
app.get('/api/sell-list', (req, res) => {
  res.json({ list: sellList });
});

// Добавить в продажу
app.post('/api/sell', (req, res) => {
  const { gift, sellerId, price } = req.body;
  if (!gift || !sellerId || typeof price !== 'number') {
    return res.status(400).json({ error: 'Missing fields' });
  }
  sellList.push({ gift, sellerId, price });
  res.json({ success: true });
});

// Удалить из продажи
app.post('/api/sell-remove', (req, res) => {
  const { slug, sellerId } = req.body;
  const idx = sellList.findIndex(item => item.gift.slug === slug && item.sellerId === sellerId);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  sellList.splice(idx, 1);
  res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on ${PORT}`));
