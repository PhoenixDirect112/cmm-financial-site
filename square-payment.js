// netlify/functions/square-payment.js
// Handles Square card payments for CM&M Financial bookings.
//
// Required Netlify environment variables (set in Netlify UI → Site Settings → Environment Variables):
//   SQUARE_ACCESS_TOKEN  — your Square production (or sandbox) access token
//   SQUARE_LOCATION_ID   — your Square location ID

const { Client, Environment } = require('square');

const client = new Client({
  accessToken: process.env.SQUARE_ACCESS_TOKEN,
  environment: process.env.SQUARE_ENVIRONMENT === 'production'
    ? Environment.Production
    : Environment.Sandbox,
});

exports.handler = async (event) => {
  // Only accept POST
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  const {
    sourceId,       // card nonce from Square Web Payments SDK
    amountCents,    // e.g. 39000 for $390
    currency = 'USD',
    note,           // e.g. "CM&M Booking: Foundation Plan"
    buyerName,
    buyerEmail,
    service,
    date,
    time,
  } = body;

  // Basic validation
  if (!sourceId)    return { statusCode: 400, body: JSON.stringify({ error: 'Missing sourceId' }) };
  if (!amountCents) return { statusCode: 400, body: JSON.stringify({ error: 'Missing amountCents' }) };

  try {
    const { result } = await client.paymentsApi.createPayment({
      sourceId,
      idempotencyKey: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      amountMoney: {
        amount: BigInt(amountCents),
        currency,
      },
      locationId: process.env.SQUARE_LOCATION_ID,
      note: note || `CM&M Booking: ${service}`,
      buyerEmailAddress: buyerEmail || undefined,
      billingAddress: buyerName ? { firstName: buyerName.split(' ')[0], lastName: buyerName.split(' ').slice(1).join(' ') } : undefined,
    });

    const payment = result.payment;

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        paymentId: payment.id,
        status: payment.status,
        receiptUrl: payment.receiptUrl,
        amountCents: Number(payment.amountMoney?.amount),
        service,
        date,
        time,
      }),
    };

  } catch (err) {
    // Square SDK errors have an `errors` array
    const squareErrors = err?.errors;
    const message = squareErrors?.[0]?.detail || err.message || 'Payment processing failed.';
    console.error('[square-payment] Error:', squareErrors || err.message);

    return {
      statusCode: 400,
      body: JSON.stringify({ error: message }),
    };
  }
};
