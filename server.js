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
const SHOP_ID = process.env.SHOP_ID;                  // ЮKassa shopId, например 1003537
const SECRET_KEY = process.env.SECRET_KEY;            // test_... или live_...
const INS_DOMAIN = process.env.INS_DOMAIN;            // myshop-xxxx.myinsales.ru
const INS_API_KEY = process.env.INS_API_KEY;          // InSales API key
const INS_API_PASSWORD = process.env.INS_API_PASSWORD;// InSales API password
const PORT = process.env.PORT || 3000;

// Доп. настройки чека (можно править в Render → Environment)
const RECEIPT_VAT_CODE = Number(process.env.RECEIPT_VAT_CODE || 4); // 1=20%,2=10%,3=0%,4=без НДС,5=20/120,6=10/110
const RECEIPT_TAX_SYSTEM = Number(process.env.RECEIPT_TAX_SYSTEM || 0); // 0=не передавать; 1..6 по НК РФ

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

/**
 * Формируем чек (receipt) по 54-ФЗ.
 * items[].amount.value — ЦЕНА ЗА ЕДИНИЦУ, quantity — количество.
 * vat_code — по умолчанию берём из RECEIPT_VAT_CODE (4 = без НДС).
 */
function buildReceiptFromOrder(order) {
  const lines = order.line_items || order.order_lines || [];
  const items = [];

  for (const li of lines) {
    const qty = Number(li.quantity || 1);
    const unitPrice = money(li.sale_price ?? li.price ?? 0);
    const name = String(li.title || 'Товар').slice(0, 128); // ограничим длину на всякий
    items.push({
      description: name,
      quantity: qty,
      amount: { value: unitPrice, currency: 'RUB' },
      vat_code: RECEIPT_VAT_CODE,
      // можно дополнить:
      // payment_mode: 'full_payment',
      // payment_subject: 'commodity',
    });
  }

  const receipt = {
    customer: {},
    items,
  };

  // контакт покупателя — берём из заказа (что есть)
  if (order.email) receipt.customer.email = String(order.email);
  if (order.phone) receipt.customer.phone = String(order.phone);

  // при необходимости можно указать СНО
  if (RECEIPT_TAX_SYSTEM >= 1 && RECEIPT_TAX_SYSTEM <= 6) {
    receipt.tax_system_code = RECEIPT_TAX_SYSTEM;
  }

  return receipt;
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
    PORT: process.env.PORT || 3000,
    RECEIPT_VAT_CODE,
    RECEIPT_TAX_SYSTEM
  });
});

// ТЕСТ: показать ключевые поля заказа (sku/barcode)
app.get('/test-order/:id', async (req, res) => {
  try {
    const order = await fetchOrder(req.params.id);
    res.json({
      order_id: order.id,
      number: order.number,
      email: order.email || null,
      phone: order.phone || null,
      lines: (order.line_items || order.order_lines || []).map(li => ({
        title: li.title,
        quantity: li.quantity,
        price: li.sale_price ?? li.price,
        sku_in_line: li.sku || null,
        variant_sku: li?.variant?.sku || null,
        barcode_in_line: li.barcode || null,
        variant_barcode: li?.variant?.bar_
