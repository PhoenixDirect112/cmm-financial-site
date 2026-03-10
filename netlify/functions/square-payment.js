// ─────────────────────────────────────────────────────────────
// CM&M Financial Education — Square Payment Function
// Netlify Serverless Function: netlify/functions/square-payment.js
//
// This runs securely on the server — your Square Access Token
// is NEVER exposed to the browser.
//
// Setup:
//  1. In Netlify Dashboard → Site Configuration → Environment Variables
//     Add: SQUARE_ACCESS_TOKEN  = your Square sandbox/production access token
//          SQUARE_LOCATION_ID   = your Square location ID
//  2. Deploy — Netlify auto-detects files in /netlify/functions/
// ─────────────────────────────────────────────────────────────

const { ApiError, Client, Environment } = require('squareup');
const crypto = require('crypto');

exports.handler = async (event) => {
  // Only allow POST
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
    sourceId,       // Square payment token from the browser
    amountCents,    // e.g. 39000 for $390.00
    currency = 'USD',
    note,
    buyerName,
    buyerEmail,
    service,
    date,
    time
  } = body;

  if (!sourceId || !amountCents) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing sourceId or amount' }) };
  }

  // Square client — uses env vars set in Netlify dashboard
  const client = new Client({
    accessToken: process.env.SQUARE_ACCESS_TOKEN,
    environment: process.env.SQUARE_ENVIRONMENT === 'production'
      ? Environment.Production
      : Environment.Sandbox,
  });

  try {
    const { result } = await client.paymentsApi.createPayment({
      sourceId,
      idempotencyKey: crypto.randomUUID(), // prevents duplicate charges on retries
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

    // ── Optional: Send a confirmation email here via SendGrid / Mailgun ──
    // await sendConfirmationEmail({ buyerEmail, buyerName, service, date, time, amount: amountCents / 100 });

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
    // Square ApiError contains helpful details
    if (error instanceof ApiError) {
      const msg = error.errors?.[0]?.detail || 'Payment failed';
      console.error('Square ApiError:', error.errors);
      return { statusCode: 402, body: JSON.stringify({ error: msg }) };
    }
    console.error('Unexpected error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: 'Server error. Please try again.' }) };
  }
};
