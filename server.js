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
const SHOP_ID = process.env.SHOP_ID;                  // ЮKassa shopId, напр. 1003537
const SECRET_KEY = process.env.SECRET_KEY;            // test_* или live_*
const INS_DOMAIN = process.env.INS_DOMAIN;            // myshop-xxxx.myinsales.ru
const INS_API_KEY = process.env.INS_API_KEY;          // InSales API key
const INS_API_PASSWORD = process.env.INS_API_PASSWORD;// InSales API password
const PORT = process.env.PORT || 3000;

// чек: НДС и СНО (можно задать в Render → Environment)
const RECEIPT_VAT_CODE = Number(process.env.RECEIPT_VAT_CODE || 4);     // 1=20%,2=10%,3=0%,4=без НДС,5=20/120,6=10/110
const RECEIPT_TAX_SYSTEM = Number(process.env.RECEIPT_TAX_SYSTEM || 0); // 0=не передавать; 1..6 — СНО

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

// Нормализация телефона под форматы, которые принимает ЮKassa
function normalizePhone(raw) {
  if (!raw) return null;
  const digitsPlus = String(raw).replace(/[^\d+]/g, '');
  if (!digitsPlus) return null;

  if (digitsPlus.startsWith('+')) {
    const only = digitsPlus.replace(/[^\d]/g, '');
    if (only.length >= 11) return digitsPlus;
  }
  const only = digitsPlus.replace(/[^\d]/g, '');
  if (only.length === 11 && only.startsWith('8')) return '+7' + only.slice(1);
  if (only.length === 11 && only.startsWith('7')) return '+' + only;
  if (only.length === 10) return '+7' + only;
  return null;
}

// Универсальный сбор контактов из всех типичных мест InSales
function pickCustomer(order) {
  const emails = [
    order?.email,
    order?.notification_email,          // из твоего примера
    order?.client?.email,
    order?.customer?.email,
    order?.user?.email,
    order?.contact_email,
    order?.shipping_address?.email,
    order?.delivery_address?.email,
    order?.billing_address?.email
  ].filter(Boolean);

  const phonesRaw = [
    order?.phone,
    order?.contact_phone,               // из твоего примера
    order?.client?.phone,
    order?.customer?.phone,
    order?.user?.phone,
    order?.shipping_address?.phone,
    order?.delivery_address?.phone,
    order?.billing_address?.phone
  ].filter(Boolean);

  const email = emails.find(e => String(e).includes('@')) || null;

  let phone = null;
  for (const p of phonesRaw) {
    const norm = normalizePhone(p);
    if (norm) { phone = norm; break; }
  }

  return { email, phone };
}

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

/** Преобразуем строки заказа → YooKassa articles[] */
async function buildArticlesFromOrder(order) {
  const lines = order.line_items || order.order_lines || [];
  const out = [];
  let idx = 1;

  for (const li of lines) {
    // TRU: сначала SKU, потом variant.sku, потом barcode (fallback)
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
      tru_code: String(tru), // должен быть реальный TRU/GTIN
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

/** Формируем чек (receipt) по 54-ФЗ */
function buildReceiptFromOrder(order) {
  const { email, phone } = pickCustomer(order);
  if (!email && !phone) {
    console.warn('No customer contacts in order');
    return null;
  }

  const lines = order.line_items || order.order_lines || [];
  const items = lines.map(li => {
    const qty = Number(li.quantity || 1);
    const unitPrice = money(li.sale_price ?? li.price ?? 0);
    const name = String(li.title || 'Товар').slice(0, 128);
    return {
      description: name,
      quantity: qty,
      amount: { value: unitPrice, currency: 'RUB' },
      vat_code: RECEIPT_VAT_CODE,
      // при необходимости можно раскомментировать:
      // payment_mode: 'full_payment',
      // payment_subject: 'commodity',
    };
  });

  const receipt = { customer: {}, items };
  if (email) receipt.customer.email = email;
  if (phone) receipt.customer.phone = phone;

  if (RECEIPT_TAX_SYSTEM >= 1 && RECEIPT_TAX_SYSTEM <= 6) {
    receipt.tax_system_code = RECEIPT_TAX_SYSTEM;
  }

  return receipt;
}

// ====== ROUTES ======

// Проверка ENV
app.get('/env-check', (req, res) => {
  res.json({
    SHOP_ID: !!process.env.SHOP_ID,
    SECRET_KEY: !!process.env.SECRET_KEY,
    INS_DOMAIN: process.env.INS_DOMAIN || null,
    INS_API_KEY: !!process.env.INS_API_KEY,
    INS_API_PASSWORD: !!process.env.INS_API_PASSWORD,
    PORT: process.env.PORT || 3000,
    RECEIPT_VAT_CODE,
    RECEIPT_TAX_SYSTEM
  });
});

// ТЕСТ: показать ключевые поля заказа + найденные контакты
app.get('/test-order/:id', async (req, res) => {
  try {
    const order = await fetchOrder(req.params.id);
    const contact = pickCustomer(order);
    res.json({
      order_id: order.id,
      number: order.number,
      customer_detected: { email: contact.email || null, phone: contact.phone || null },
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

app.get('/', (req, res) => {
  res.send('🚀 YooKassa ES: POST /insales/start | GET /pay-by-es?order_id=...&return_url=... | GET /test-order/:id | GET /env-check');
});

// InSales POST или ручной GET ?order_id=
app.all('/insales/start', async (req, res) => {
  try {
    const method = req.method;
    console.log('[/insales/start] method=', method, 'ct=', req.headers['content-type']);

    // 1) заказ
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
      return res.status(400).send('Нет данных заказа: нужен POST с order_json (InSales) или GET c ?order_id=');
    }

    // 2) articles
    const articles = await buildArticlesFromOrder(orderObj);
    if (!articles.length) {
      return res.status(400).send('В заказе нет позиций с TRU (проверь SKU/штрихкоды у вариантов)');
    }

    // 3) сумма + чек
    const amount = amountFromArticles(articles);
    const receipt = buildReceiptFromOrder(orderObj);
    if (!receipt) {
      return res.status(400).send('В заказе не найден телефон или e-mail (для чека). Включи обязательное поле в оформлении заказа.');
    }

    // 4) YooKassa (articles — top-level, receipt обязателен)
    const idempotenceKey = uuidv4();
    const { data: pay } = await axios.post(
      'https://api.yookassa.ru/v3/payments',
      {
        amount: { value: amount, currency: 'RUB' },
        payment_method_data: { type: 'electronic_certificate' },
        articles,
        receipt,
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

// Ручной сценарий
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
    const receipt = buildReceiptFromOrder(order);
    if (!receipt) {
      return res.status(400).send('В заказе не найден телефон или e-mail (для чека).');
    }

    const idempotenceKey = uuidv4();
    const { data: pay } = await axios.post(
      'https://api.yookassa.ru/v3/payments',
      {
        amount: { value: amount, currency: 'RUB' },
        payment_method_data: { type: 'electronic_certificate' },
        articles,
        receipt,
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
