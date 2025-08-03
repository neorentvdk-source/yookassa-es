require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

const SHOP_ID = process.env.SHOP_ID;
const SECRET_KEY = process.env.SECRET_KEY;
const basicAuth = Buffer.from(`${SHOP_ID}:${SECRET_KEY}`).toString('base64');

app.post('/create-payment', async (req, res) => {
  try {
    const { amount, articles, return_url, description = 'Оплата через сертификат', metadata = {} } = req.body;

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
          articles: articles,
        },
        confirmation: {
          type: 'redirect',
          return_url: return_url,
        },
        capture: true,
        description: description,
        metadata: metadata
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
