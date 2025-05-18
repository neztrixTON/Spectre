// index.js
// Node.js Express backend: Telegram MiniApp init, gift verification, marketplace

const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');

// ENV vars
const BOT_TOKEN      = process.env.BOT_TOKEN;
const apiId          = Number(process.env.API_ID);
const apiHash        = process.env.API_HASH;
const SESSION_STRING = process.env.SESSION_STRING || '';

if (!BOT_TOKEN || !apiId || !apiHash) {
  console.error('Missing BOT_TOKEN, API_ID or API_HASH');
  process.exit(1);
}

// MTProto client
const stringSession = new StringSession(SESSION_STRING);
const mtClient = new TelegramClient(stringSession, apiId, apiHash, { connectionRetries: 5 });

(async()=>{
  await mtClient.start({ botAuthToken: BOT_TOKEN });
  console.log('MTProto ready, new session:', mtClient.session.save());
})();

const app = express();
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// In-memory stores
const giftStore = new Map();      // slug -> metadata
const sellList  = [];             // array of { gift, price, sellerId }

// Helpers
function normalizeUrl(u) {
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  return u;
}

// --- Init endpoint ---
app.post('/api/init', (req, res) => {
  const { initData, initDataUnsafe } = req.body;
  if (!initData || !initDataUnsafe?.user) {
    return res.status(400).json({ error: 'Invalid init payload' });
  }
  const user = initDataUnsafe.user;
  const uniqueId = `U${user.id}`;
  res.json({ balance: 0, unique_id: uniqueId });
});

// --- Check gift endpoint ---
app.post('/api/check-gift', async (req, res) => {
  try {
    let { url, userId } = req.body;
    if (!url || !userId) throw { code:400, msg:'Missing url or userId' };
    url = normalizeUrl(url);
    const slug = url.split('/').pop();
    if (!slug) throw { code:400, msg:'Invalid URL' };

    // Fetch & cache metadata
    if (!giftStore.has(slug)) {
      const html = (await axios.get(url)).data;
      const $ = cheerio.load(html);
      const table = $('table.tgme_gift_table');
      if (!table.length) throw { code:404, msg:'Gift not found' };
      const parseRow = name => {
        const row = table.find(`tr:has(th:contains("${name}"))`);
        return {
          text: row.find('td').text().replace(/\s*\d+(\.\d+)?%/,'').trim(),
          rarity: parseFloat(row.find('mark').text())||0
        };
      };
      const m = parseRow('Model'), b = parseRow('Backdrop'), s = parseRow('Symbol');
      const meta = {
        slug,
        title: slug.split('-')[0],
        model: m.text, model_rarity: m.rarity,
        backdrop: b.text, backdrop_rarity: b.rarity,
        symbol: s.text, symbol_rarity: s.rarity,
        imgUrl:  `https://nft.fragment.com/gift/${slug}.webp`,
        animUrl: `https://nft.fragment.com/gift/${slug}.lottie.json`
      };
      giftStore.set(slug, meta);
    }
    const gift = giftStore.get(slug);

    // Owner check
    const ownerHtml = (await axios.get(url)).data;
    const $o = cheerio.load(ownerHtml);
    const ownerLink = $o('tr:has(th:contains("Owner")) td a').attr('href');
    if (!ownerLink) throw { code:403, msg:'Gift is hidden', type:'hidden' };
    const username = ownerLink.split('/').pop();
    const entity = await mtClient.getEntity(username);
    if (Number(entity.id) !== userId) {
      throw { code:403, msg:'You are not owner', type:'not_owner' };
    }

    res.json({ owned:true, gift });
  } catch(err) {
    console.error(err);
    const code = err.code||500;
    res.status(code).json({ error: err.msg||err.message, errorType: err.type||'server_error' });
  }
});

// --- Sell list endpoints ---
// Publish a gift for sale
app.post('/api/sell', (req, res) => {
  const { gift, price, sellerId } = req.body;
  if (!gift || !price || !sellerId) return res.status(400).json({ error:'Missing params' });
  sellList.push({ gift, price, sellerId, listedAt: Date.now() });
  res.json({ success:true });
});
// Get all for-sale gifts
app.get('/api/sell-list', (req, res) => {
  res.json({ list: sellList });
});

// Static and start
const PORT = process.env.PORT||3000;
app.listen(PORT, ()=>console.log(`Server on ${PORT}`));
