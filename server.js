require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

const SHOP_ID = process.env.SHOP_ID;
const SECRET_KEY = process.env.SECRET_KEY;

// Генерируем заголовок авторизации в формате Basic
const basicAuth = Buffer.from(`${SHOP_ID}:${SECRET_KEY}`).toString('base64');

// Главная страница (проверка работы сервера)
app.get('/', (req, res) => {
  res.send('🚀 Сервер YoоKassa работает. Используй POST /create-payment и GET /check-payment/:id');
});

// Создание платежа
app.post('/create-payment', async (req, res) => {
  try {
    const { amount, items, return_url } = req.body;

    const idempotenceKey = uuidv4();
    const response = await axios.post(
      'https://api.yookassa.ru/v3/payments',
      {
        amount: {
          value: amount,
          currency: 'RUB',
        },
        payment_method_data: {
          type: 'electronic_certificate',
        },
        confirmation: {
          type: 'redirect',
          return_url: return_url,
        },
        receipt: {
          items: items,
          customer: {
            full_name: "Имя Фамилия",
          }
        },
        description: 'Оплата через электронный сертификат',
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Idempotence-Key': idempotenceKey,
          Authorization: `Basic ${basicAuth}`,
        },
      }
    );

    res.json({
      confirmation_url: response.data.confirmation.confirmation_url,
      payment_id: response.data.id,
    });
  } catch (error) {
    console.error(error?.response?.data || error.message);
    res.status(500).json({ error: 'Ошибка создания платежа' });
  }
});

// Проверка статуса платежа
app.get('/check-payment/:id', async (req, res) => {
  try {
    const paymentId = req.params.id;

    const response = await axios.get(`https://api.yookassa.ru/v3/payments/${paymentId}`, {
      headers: {
        Authorization: `Basic ${basicAuth}`,
      },
    });

    res.json({ status: response.data.status });
  } catch (error) {
    console.error(error?.response?.data || error.message);
    res.status(500).json({ error: 'Ошибка проверки статуса' });
  }
});

// Запуск сервера
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Сервер запущен на порту ${PORT}`);
});
