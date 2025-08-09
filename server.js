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

// Получаем sku/barcode варианта из карточки товара
async function fetchVariantInfo(productId, variantId) {
  const { data } = await insales.get(`/admin/products/${productId}.json`);
  const product = data.product ? data.product : data;
  const v = (product.variants || []).find(x => String(x.id) === String(variantId));
  return { barcode: v?.barcode || null, sku: v?.sku || null };
}

/**
 * Преобразуем строки заказа → YooKassa articles[]
 * TRU берём из SKU (артикул). Если нет — variant.sku, затем barcode.
 */
async function buildArticlesFromOrder(order) {
  const lines = order.line_items || order.order_lines || [];
  const out = [];
  let idx = 1;

  for (const li of lines) {
    let tru = li.sku || li?.variant?.sku || null;

    if (!tru && li.product_id && li.variant_id) {
      try {
        const vi = await fetchVariantInfo(li.product_id, li.variant_id);
        tru = vi.sku || vi.barcode || null;
      } catch (_) {}
    }
    if (!tru) tru = li.barcode || li?.variant?.barcode || null;

    if (!tru) continue; // строку без TRU пропускаем

    const quantity = Number(li.quantity || 1);
    const unitPrice = money(li.sale_price ?? li.price ?? 0);

    out.push({
      article_number: idx++,
      tru_code: String(tru), // здесь должен быть реальный TRU/GTIN
      article_code: String(li.variant_id ?? li.product_id ?? li.sku ?? ''),
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

// Health-check переменных окружения (секреты не раскрываем)
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

// ТЕСТ: показать ключевые поля заказа (sku/barcode)
app.get('/test-order/:id', async (req, res) => {
  try {
    const order = await fetchOrder(req.params.id);
    res.json({
      order_id: order.id,
      number: order.number,
      lines: (order.line_items || order.order_lines || []).map(li => ({
        title: li.title,
        quantity: li.quantity,
        price: li.sale_price ?? li.price,
        sku_in_line: li.sku || null,
        variant_sku: li?.variant?.sku || null,
        barcode_in_line: li.barcode || null,
        variant_barcode: li?.variant?.barcode || null,
        product_id: li.product_id || null,
        variant_id: li.variant_id || null
      }))
    });
  } catch (e) {
    console.error('test-order error:', e?.response?.data || e.message);
    res.status(500).json({ error: 'Не удалось получить заказ. Проверь ID и доступы API.' });
  }
});

// Стартовая страница
app.get('/', (req, res) => {
  res.send('🚀 YooKassa ES: POST /insales/start | GET /pay-by-es?order_id=...&return_url=... | GET /test-order/:id | GET /env-check');
});

/**
 * ✅ Диагностический обработчик /insales/start:
 * - Принимает POST от InSales (order_json)
 * - Умеет ручной GET-тест: /insales/start?order_id=123&return_url=...
 * - Логирует ключевые шаги
 * - Шлёт в ЮKassa articles на ВЕРХНЕМ УРОВНЕ
 * - В случае ошибки показывает текст ответа ЮKassa (удобно для отладки)
 */
app.all('/insales/start', async (req, res) => {
  try {
    const method = req.method;
    console.log('[/insales/start] method=', method, 'ct=', req.headers['content-type']);

    // 1) Получаем заказ
    let orderObj = null;

    if (method === 'POST' && (req.body?.order_json)) {
      console.log('[/insales/start] body keys:', Object.keys(req.body));
      orderObj = typeof req.body.order_json === 'string'
        ? JSON.parse(req.body.order_json)
        : req.body.order_json;
    } else if (method === 'GET' && req.query.order_id) {
      console.log('[/insales/start] GET order_id=', req.query.order_id);
      orderObj = await fetchOrder(req.query.order_id);
    }

    if (!orderObj?.id) {
      console.error('[/insales/start] no order_json or no id');
      return res.status(400).send('Нет данных заказа: нужен POST с order_json (InSales) или GET c ?order_id=');
    }

    // 2) Собираем articles
    const articles = await buildArticlesFromOrder(orderObj);
    console.log('[/insales/start] articles count=', articles.length);
    if (!articles.length) {
      return res.status(400).send('В заказе нет позиций с TRU (проверь SKU/штрихкоды у вариантов)');
    }

    // 3) Сумма
    const amount = amountFromArticles(articles);
    console.log('[/insales/start] amount=', amount);

    // 4) Платёж в ЮKassa (articles — top-level!)
    const idempotenceKey = uuidv4();
    const { data: pay } = await axios.post(
      'https://api.yookassa.ru/v3/payments',
      {
        amount: { value: amount, currency: 'RUB' },
        payment_method_data: { type: 'electronic_certificate' },
        articles,
        confirmation: {
          type: 'redirect',
          return_url: req.query.return_url || `https://${INS_DOMAIN}/account/orders`
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
      console.error('[/insales/start] No confirmation_url. YooKassa resp:', pay);
      return res.status(502).send('ЮKassa не вернула confirmation_url');
    }

    console.log('[/insales/start] redirect to', confirmationUrl);
    return res.redirect(302, confirmationUrl);
  } catch (e) {
    const err = e?.response?.data || e.message;
    console.error('[/insales/start] ERROR:', err);
    return res
      .status(500)
      .send('Ошибка создания платежа из InSales: ' + (typeof err === 'string' ? err : JSON.stringify(err)));
  }
});

// Ручной сценарий (оставлен для отладки)
app.get('/pay-by-es', async (req, res) => {
  const { order_id, return_url } = req.query;
  if (!order_id || !return_url) {
    return res.status(400).send('Нужны query: order_id и return_url');
  }

  try {
    const order = await fetchOrder(order_id);
    const articles = await buildArticlesFromOrder(order);
    if (!articles.length) {
      return res.status(400).send('В заказе нет позиций с TRU (проверь SKU/штрихкоды у вариантов)');
    }

    const amount = amountFromArticles(articles);

    const idempotenceKey = uuidv4();
    const { data: pay } = await axios.post(
      'https://api.yookassa.ru/v3/payments',
      {
        amount: { value: amount, currency: 'RUB' },
        payment_method_data: { type: 'electronic_certificate' },
        articles,
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
