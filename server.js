require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const app = express();
app.use(express.json());

const SHOP_ID = process.env.SHOP_ID;
const SECRET_KEY = process.env.SECRET_KEY;
const auth = {
  username: SHOP_ID,
  password: SECRET_KEY,
};

app.get('/', (req, res) => {
  res.send('🚀 Сервер YooKassa работает. Используй POST /create-payment и GET /check-payment/:id');
});

app.post('/create-payment', async (req, res) => {
  const idempotenceKey = uuidv4();

  // В InSales включена передача подробной информации — данные приходят в req.body
  const { order_id, amount, description, articles, return_url } = req.body;

  if (!amount || !articles || !return_url) {
    return res.status(400).json({ error: 'Недостаточно данных в теле запроса' });
  }

  try {
    const response = await axios.post(
      'https://api.yookassa.ru/v3/payments',
      {
        amount: {
          value: amount,
          currency: 'RUB',
        },
        payment_method_data: {
          type: 'electronic_certificate',
          articles: articles,
        },
        confirmation: {
          type: 'redirect',
          return_url: return_url,
        },
        capture: true,
        metadata: {
          order_id: order_id || `ORD-${uuidv4()}`,
        },
        description: description || `Оплата заказа`,
      },
      {
        auth,
        headers: {
          'Content-Type': 'application/json',
          'Idempotence-Key': idempotenceKey,
        },
      }
    );

    res.json({
      confirmation_url: response.data.confirmation.confirmation_url,
      payment_id: response.data.id,
      status: response.data.status,
    });
  } catch (error) {
    console.error('Ошибка при создании платежа:', error?.response?.data || error.message);
    res.status(500).json({ error: 'Ошибка создания платежа' });
  }
});

app.get('/check-payment/:id', async (req, res) => {
  try {
    const response = await axios.get(`https://api.yookassa.ru/v3/payments/${req.params.id}`, {
      auth,
    });

    res.json({
      status: response.data.status,
      payment_id: response.data.id,
      amount: response.data.amount?.value,
    });
  } catch (error) {
    console.error('Ошибка при проверке статуса:', error?.response?.data || error.message);
    res.status(500).json({ error: 'Ошибка проверки статуса' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Сервер запущен на порту ${PORT}`);
});
