// server.js
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());

// ====== ENV ======
const SHOP_ID = process.env.SHOP_ID;                  // ЮKassa: 1003537
const SECRET_KEY = process.env.SECRET_KEY;            // ЮKassa: test_*...
const INS_DOMAIN = process.env.INS_DOMAIN;            // myshop-cud280.myinsales.ru
const INS_API_KEY = process.env.INS_API_KEY;          // 924cc3...
const INS_API_PASSWORD = process.env.INS_API_PASSWORD;// 95f620...
const PORT = process.env.PORT || 3000;

if (!SHOP_ID || !SECRET_KEY || !INS_DOMAIN || !INS_API_KEY || !INS_API_PASSWORD) {
  console.warn('⚠️ Проверь .env — не хватает переменных окружения.');
}

const ykAuthHeader = 'Basic ' + Buffer.from(`${SHOP_ID}:${SECRET_KEY}`).toString('base64');

// ====== InSales клиент ======
const insales = axios.create({
  baseURL: `https://${INS_DOMAIN}`,
  auth: { username: INS_API_KEY, password: INS_API_PASSWORD },
  timeout: 15000,
});

// ====== helpers ======
const money = (v) => Number(v || 0).toFixed(2);

// Получаем заказ из InSales по ID (разные магазины отдают немного разную обёртку)
async function fetchOrder(orderId) {
  const { data } = await insales.get(`/admin/orders/${orderId}.json`);
  // Иногда приходит { order: {...} }, иногда сразу {...}
  return data.order ? data.order : data;
}

// Получаем штрихкод варианта из карточки товара, если нет в строке заказа
async function fetchVariantBarcode(productId, variantId) {
  const { data } = await insales.get(`/admin/products/${productId}.json`);
  const product = data.product ? data.product : data;
  const v = (product.variants || []).find(x => String(x.id) === String(variantId));
  return v?.barcode || null;
}

// Преобразуем строки заказа → YooKassa articles[]
async function buildArticlesFromOrder(order) {
  // В одних магазинах: order.line_items, в других: order.order_lines — поддержим оба
  const lines = order.line_items || order.order_lines || [];
  const out = [];
  let idx = 1;

  for (const li of lines) {
    // Пытаемся достать TRU-код (штрихкод)
    // Часто бывает в li.barcode, реже — в li.variant.barcode
    let tru = li.barcode || li?.variant?.barcode || null;

    // Если нет — пробуем добрать из карточки товара по product_id + variant_id
    if (!tru && li.product_id && li.variant_id) {
      try {
        tru = await fetchVariantBarcode(li.product_id, li.variant_id);
      } catch (_) {
        // молча продолжаем — если нет, пропустим позицию
      }
    }

    if (!tru) {
      // Эту строку пропускаем: без TRU-кода (штрихкода) ЮKassa не одобрит корзину СФР
      continue;
    }

    const quantity = Number(li.quantity || 1);
    const unitPrice = money(li.sale_price ?? li.price ?? 0); // берём sale_price, иначе price

    out.push({
      article_number: idx++,
      tru_code: String(tru),
      article_code: String(li.sku ?? li.variant_id ?? ''),      // артикул/sku на твой вкус
      article_name: String(li.title || 'Товар'),                // имя позиции
      quantity,
      price: { value: unitPrice, currency: 'RUB' },
    });
  }

  return out;
}

function amountFromArticles(articles) {
  const sum = articles.reduce((acc, a) => acc + Number(a.price.value) * Number(a.quantity), 0);
  return money(sum);
}

// ====== РОУТЫ ======

// Проверка живости
app.get('/', (req, res) => {
  res.send('🚀 YooKassa ES готов. Используй GET /pay-by-es?order_id=XXX&return_url=...');
});

// ВАЖНО: основной маршрут для InSales (GET → создаём платёж → редиректим на ЮKassa)
app.get('/pay-by-es', async (req, res) => {
  const { order_id, return_url } = req.query;
  if (!order_id || !return_url) {
    return res.status(400).send('Нужны query: order_id и return_url');
  }

  try {
    // 1) Забираем заказ из InSales
    const order = await fetchOrder(order_id);

    // 2) Собираем articles (TRU из штрихкодов)
    const articles = await buildArticlesFromOrder(order);
    if (!articles.length) {
      return res
        .status(400)
        .send('В заказе нет ни одной позиции с TRU-кодом (штрихкодом). Проверь штрихкоды у вариантов.');
    }

    // 3) Сумма (считаем из articles, чтобы не было расхождений)
    const amount = amountFromArticles(articles);

    // 4) Создаём платёж в ЮKassa
    const idempotenceKey = uuidv4();
    const { data: pay } = await axios.post(
      'https://api.yookassa.ru/v3/payments',
      {
        amount: { value: amount, currency: 'RUB' },
        payment_method_data: { type: 'electronic_certificate', articles },
        confirmation: { type: 'redirect', return_url },
        capture: true,
        description: `Заказ №${order.number || order.id}`,
        metadata: { order_id: String(order.id) }
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Idempotence-Key': idempotenceKey,
          Authorization: ykAuthHeader,
        },
        timeout: 20000,
      }
    );

    const confirmationUrl = pay?.confirmation?.confirmation_url;
    if (!confirmationUrl) {
      return res.status(502).send('ЮKassa не вернула confirmation_url');
    }

    // 5) Отправляем покупателя на форму ЮKassa
    return res.redirect(302, confirmationUrl);
  } catch (e) {
    console.error('pay-by-es error:', e?.response?.data || e.message);
    return res.status(500).send('Ошибка создания платежа');
  }
});

// (опционально) Ручной сценарий: прямой POST /create-payment
app.post('/create-payment', async (req, res) => {
  const { amount, articles, return_url, description = 'Оплата по ЭС', metadata = {} } = req.body;
  if (!amount || !articles || !return_url) {
    return res.status(400).json({ error: 'amount, articles, return_url обязательны' });
  }
  try {
    const idempotenceKey = uuidv4();
    const { data } = await axios.post(
      'https://api.yookassa.ru/v3/payments',
      {
        amount: { value: money(amount), currency: 'RUB' },
        payment_method_data: { type: 'electronic_certificate', articles },
        confirmation: { type: 'redirect', return_url },
        capture: true,
        description,
        metadata,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Idempotence-Key': idempotenceKey,
          Authorization: ykAuthHeader,
        },
      }
    );
    res.json({ confirmation_url: data.confirmation?.confirmation_url, payment_id: data.id, status: data.status });
  } catch (e) {
    console.error('create-payment error:', e?.response?.data || e.message);
    res.status(500).json({ error: 'Ошибка создания платежа' });
  }
});

// Проверка статуса платежа
app.get('/check-payment/:id', async (req, res) => {
  try {
    const { data } = await axios.get(`https://api.yookassa.ru/v3/payments/${req.params.id}`, {
      headers: { Authorization: ykAuthHeader },
    });
    res.json({ status: data.status, payment_id: data.id, amount: data.amount?.value });
  } catch (e) {
    console.error('check-payment error:', e?.response?.data || e.message);
    res.status(500).json({ error: 'Ошибка проверки статуса' });
  }
});

// ====== START ======
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server listening on ${PORT}`);
});
