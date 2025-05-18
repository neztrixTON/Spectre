// index.js
const fs = require('fs');
const path = require('path');
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const cheerio = require('cheerio');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');

// Конфигурация через окружение
const BOT_TOKEN = process.env.BOT_TOKEN;
const apiId = Number(process.env.API_ID);
const apiHash = process.env.API_HASH;
const SESSION_FILE = path.resolve(__dirname, 'session.txt');

let sessionString = fs.existsSync(SESSION_FILE)
  ? fs.readFileSync(SESSION_FILE, 'utf-8').trim()
  : '';
const mtClient = new TelegramClient(new StringSession(sessionString), apiId, apiHash, { connectionRetries: 5 });

(async ()=>{
  await mtClient.start({ botAuthToken: BOT_TOKEN });
  fs.writeFileSync(SESSION_FILE, mtClient.session.save());
  console.log('MTProto client ready');
})();

const app = express();
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

const giftStore = new Map();

// Init MiniApp: верификация и выдача баланса+ID
app.post('/api/init', (req, res) => {
  const { initData } = req.body;
  // TODO: верифицировать initData через BOT_TOKEN
  const user = req.body.initDataUnsafe.user;
  const uniqueId = `U${user.id}`;
  console.log(`Init user ${user.id}`);
  res.json({ balance: 0, unique_id: uniqueId });
});

// Проверка подарка и парсинг метаданных
app.post('/api/check-gift', async (req, res) => {
  const { url, userId } = req.body;
  try {
    const slug = url.split('/').pop();
    if (!giftStore.has(slug)) {
      const { data: html } = await axios.get(url);
      const $ = cheerio.load(html);
      const table = $('table.tgme_gift_table');
      function parseRow(name) {
        const row = table.find(`tr:has(th:contains("${name}"))`);
        return {
          text: row.find('td').text().replace(/\s*\d+(\.\d+)?%/, '').trim(),
          rarity: parseFloat(row.find('mark').text()) || 0
        };
      }
      const title = slug.split('-')[0];
      const imgUrl  = `https://nft.fragment.com/gift/${slug}.webp`;
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

    // Проверяем владельца
    const { data: ownerHtml } = await axios.get(url);
    const $o = cheerio.load(ownerHtml);
    const ownerLink = $o('tr:has(th:contains("Owner")) td a').attr('href');
    const username = ownerLink.split('/').pop();
    const entity = await mtClient.getEntity(username);
    if (Number(entity.id) !== userId) {
      return res.status(403).json({ error: 'Not owner' });
    }

    res.json({ owned: true, gift });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=>console.log(`Server on ${PORT}`));
