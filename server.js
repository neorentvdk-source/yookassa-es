// server.js
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');

const app = express();

// ====== PARSERS ======
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // InSales шлёт form-urlencoded

// ====== ENV ======
const SHOP_ID = process.env.SHOP_ID;                  // ЮKassa: 1003537
const SECRET_KEY = process.env.SECRET_KEY;            // ЮKassa: test_* или live_*
const INS_DOMAIN = process.env.INS_DOMAIN;            // myshop-xxxx.myinsales.ru
const INS_API_KEY = process.env.INS_API_KEY;          // API key InSales
const INS_API_PASSWORD = process.env.INS_API_PASSWORD;// API password InSales
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

// Получаем заказ из InSales по ID
async function fetchOrder(orderId) {
  const { data } = await insales.get(`/admin/orders/${orderId}.json`);
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
  const lines = order.line_items || order.order_lines || [];
  const out = [];
  let idx = 1;

  for (const li of lines) {
    // TRU-код (штрихкод)
    let tru = li.barcode || li?.variant?.barcode || null;

    if (!tru && li.product_id && li.variant_id) {
      try {
        tru = await fetchVariantBarcode(li.product_id, li.variant_id);
      } catch (_) { /* пропускаем ошибку */ }
    }

    if (!tru) {
      // Без штрихкода строку пропускаем (ЭС не примет)
      continue;
    }

    const quantity = Number(li.quantity || 1);
    const unitPrice = money(li.sale_price ?? li.price ?? 0);

    out.push({
      article_number: idx++,
      tru_code: String(tru),
      article_code: String(li.sku ?? li.variant_id ?? ''), // артикул/sku
      article_name: String(li.title || 'Товар'),
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

// ====== ROUTES ======

// Health-check переменных окружения (НЕ показывает секреты)
app.get('/env-check', (req, res) => {
  res.json({
    SHOP_ID: !!process.env.SHOP_ID,
    SECRET_KEY: !!process.env.SECRET_KEY,
    INS_DOMAIN: process.env.INS_DOMAIN || null,
    INS_API_KEY: !!process.env.INS_API_KEY,
    INS_API_PASSWORD: !!process.env.INS_API_PASSWORD,
    PORT: process.env.PORT || 3000
  });
});

// ✅ ТЕСТ: Посмотреть сырой заказ из InSales и глазами увидеть штрихкоды
app.get('/test-order/:id', async (req, res) => {
  try {
    const order = await fetchOrder(req.params.id);
    res.json({
      order_id: order.id,
      number: order.number,
      // Покажем ключевые поля по позициям
      lines: (order.line_items || order.order_lines || []).map(li => ({
        title: li.title,
        quantity: li.quantity,
        price: li.sale_price ?? li.price,
        barcode_in_line: li.barcode || null,
        variant_barcode: li?.variant?.barcode || null,
        product_id: li.product_id || null,
        variant_id: li.variant_id || null,
        sku: li.sku || null
      }))
    });
  } catch (e) {
    console.error('test-order error:', e?.response?.data || e.message);
    res.status(500).json({ error: 'Не удалось получить заказ. Проверь ID и доступы API.' });
  }
});

// Проверка живости
app.get('/', (req, res) => {
  res.send('🚀 YooKassa ES готов. Используй: POST /insales/start, GET /pay-by-es?order_id=XXX&return_url=..., GET /test-order/:id');
});

/**
 * Основной маршрут для InSales: создаём платёж по ЭС и редиректим клиента на ЮKassa
 * (Подпись InSales добавим на следующем шаге.)
 */
app.post('/insales/start', async (req, res) => {
  try {
    const { order_json } = req.body;

    const orderObj = typeof order_json === 'string' ? JSON.parse(order_json) : order_json;
    if (!orderObj?.id) {
      return res.status(400).send('Нет order_json или order_json.id');
    }

    const articles = await buildArticlesFromOrder(orderObj);
    if (!articles.length) {
      return res.status(400).send('В заказе нет позиций с TRU-кодом (штрихкодом)');
    }

    const amount = amountFromArticles(articles);

    const idempotenceKey = uuidv4();
    const { data: pay } = await axios.post(
      'https://api.yookassa.ru/v3/payments',
      {
        amount: { value: amount, currency: 'RUB' },
        payment_method_data: { type: 'electronic_certificate', articles },
        confirmation: {
          type: 'redirect',
          return_url: `https://${INS_DOMAIN}/account/orders`
        },
        capture: true,
        description: `Заказ №${orderObj.number || orderObj.id} (ЭС)`,
        metadata: { order_id: String(orderObj.id) }
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

    return res.redirect(302, confirmationUrl);
  } catch (e) {
    console.error('insales/start error:', e?.response?.data || e.message);
    return res.status(500).send('Ошибка создания платежа из InSales');
  }
});

// Ручной сценарий — оставить для отладки
app.get('/pay-by-es', async (req, res) => {
  const { order_id, return_url } = req.query;
  if (!order_id || !return_url) {
    return res.status(400).send('Нужны query: order_id и return_url');
  }

  try {
    const order = await fetchOrder(order_id);
    const articles = await buildArticlesFromOrder(order);
    if (!articles.length) {
      return res
        .status(400)
        .send('В заказе нет ни одной позиции с TRU-кодом (штрихкодом). Проверь штрихкоды у вариантов.');
    }

    const amount = amountFromArticles(articles);

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

    return res.redirect(302, confirmationUrl);
  } catch (e) {
    console.error('pay-by-es error:', e?.response?.data || e.message);
    return res.status(500).send('Ошибка создания платежа');
  }
});

// ====== START ======
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server listening on ${PORT}`);
});
