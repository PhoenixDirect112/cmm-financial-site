// netlify/functions/square-payment.js
// Uses Square Payments API directly via fetch (no SDK needed)

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

  const {
    sourceId,
    amountCents,
    currency = 'USD',
    note,
    buyerEmail,
    service,
    date,
    time,
  } = body;

  if (!sourceId)    return { statusCode: 400, body: JSON.stringify({ error: 'Missing sourceId' }) };
  if (!amountCents) return { statusCode: 400, body: JSON.stringify({ error: 'Missing amountCents' }) };

  const accessToken = process.env.SQUARE_ACCESS_TOKEN;
  const locationId  = process.env.SQUARE_LOCATION_ID;
  const environment = process.env.SQUARE_ENVIRONMENT || 'sandbox';

  // Debug: log what we have (token partially masked)
  console.log('[square-payment] environment:', environment);
  console.log('[square-payment] locationId:', locationId);
  console.log('[square-payment] token prefix:', accessToken ? accessToken.substring(0, 10) + '...' : 'MISSING');
  console.log('[square-payment] amountCents:', amountCents);
  console.log('[square-payment] sourceId prefix:', sourceId ? sourceId.substring(0, 10) + '...' : 'MISSING');

  const baseUrl = environment === 'production'
    ? 'https://connect.squareup.com'
    : 'https://connect.squareupsandbox.com';

  const payload = {
    source_id: sourceId,
    idempotency_key: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    amount_money: {
      amount: amountCents,
      currency,
    },
    location_id: locationId,
    note: note || `CM&M Booking: ${service}`,
  };

  if (buyerEmail) payload.buyer_email_address = buyerEmail;

  console.log('[square-payment] sending payload:', JSON.stringify(payload));

  try {
    const response = await fetch(`${baseUrl}/v2/payments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
        'Square-Version': '2024-01-18',
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json();
    console.log('[square-payment] Square response status:', response.status);
    console.log('[square-payment] Square response body:', JSON.stringify(data));

    if (!response.ok || data.errors) {
      const message = data.errors?.[0]?.detail || 'Payment failed.';
      return { statusCode: 400, body: JSON.stringify({ error: message }) };
    }

    const payment = data.payment;

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        paymentId: payment.id,
        status: payment.status,
        receiptUrl: payment.receipt_url,
        amountCents: payment.amount_money?.amount,
        service,
        date,
        time,
      }),
    };

  } catch (err) {
    console.error('[square-payment] Fetch error:', err.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Payment processing failed. Please try again.' }),
    };
  }
};
