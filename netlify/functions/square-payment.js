// CM&M Financial Education — Square Payment Function
// netlify/functions/square-payment.js

const { Client, Environment, ApiError } = require('square');
const crypto = require('crypto');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  const { sourceId, amountCents, currency = 'USD', note, buyerEmail, service, date, time } = body;

  if (!sourceId || !amountCents) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing sourceId or amount' }) };
  }

  const client = new Client({
    accessToken: process.env.SQUARE_ACCESS_TOKEN,
    environment: process.env.SQUARE_ENVIRONMENT === 'production'
      ? Environment.Production
      : Environment.Sandbox,
  });

  try {
    const { result } = await client.paymentsApi.createPayment({
      sourceId,
      idempotencyKey: crypto.randomUUID(),
      amountMoney: {
        amount: BigInt(amountCents),
        currency,
      },
      locationId: process.env.SQUARE_LOCATION_ID,
      note: note || 'CM&M Session Booking',
      buyerEmailAddress: buyerEmail || undefined,
      referenceId: `CMM-${Date.now()}`,
    });

    const payment = result.payment;

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: true,
        paymentId: payment.id,
        status: payment.status,
        receiptUrl: payment.receiptUrl,
      }),
    };

  } catch (error) {
    if (error instanceof ApiError) {
      const msg = error.errors?.[0]?.detail || 'Payment failed';
      console.error('Square ApiError:', error.errors);
      return { statusCode: 402, body: JSON.stringify({ error: msg }) };
    }
    console.error('Unexpected error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: 'Server error. Please try again.' }) };
  }
};
