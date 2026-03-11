// netlify/functions/outlook-calendar.js
// Handles two actions:
//   GET  ?action=availability&date=2026-03-15  → returns busy time slots for that day
//   POST { action:"book", ... }                → creates an Outlook calendar event

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  const { MS_CLIENT_ID, MS_TENANT_ID, MS_CLIENT_SECRET } = process.env;

  if (!MS_CLIENT_ID || !MS_TENANT_ID || !MS_CLIENT_SECRET) {
    return {
      statusCode: 500, headers,
      body: JSON.stringify({ error: 'Microsoft credentials not configured.' })
    };
  }

  try {
    // ─── STEP 1: Get an access token from Microsoft ───
    const tokenRes = await fetch(
      `https://login.microsoftonline.com/${MS_TENANT_ID}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: MS_CLIENT_ID,
          client_secret: MS_CLIENT_SECRET,
          scope: 'https://graph.microsoft.com/.default',
          grant_type: 'client_credentials'
        })
      }
    );
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      console.error('Token error:', tokenData);
      return {
        statusCode: 401, headers,
        body: JSON.stringify({ error: 'Failed to authenticate with Microsoft.' })
      };
    }
    const accessToken = tokenData.access_token;
    const graphHeaders = {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    };

    // Coach Mo's email — used to query her specific calendar
    const COACH_EMAIL = 'matecha@cmandmconsulting.com';

    // ─── GET AVAILABILITY ───
    if (event.httpMethod === 'GET') {
      const params = event.queryStringParameters || {};
      const date = params.date; // e.g. "2026-03-15"
      if (!date) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing date parameter.' }) };
      }

      // Fetch calendar events for that full day (Central Time, UTC-6)
      const startUtc = new Date(`${date}T00:00:00-06:00`).toISOString();
      const endUtc   = new Date(`${date}T23:59:59-06:00`).toISOString();

      const eventsRes = await fetch(
        `https://graph.microsoft.com/v1.0/users/${COACH_EMAIL}/calendarView` +
        `?startDateTime=${startUtc}&endDateTime=${endUtc}` +
        `&$select=subject,start,end`,
        { headers: graphHeaders }
      );
      const eventsData = await eventsRes.json();

      if (eventsData.error) {
        console.error('Graph API error:', eventsData.error);
        return {
          statusCode: 500, headers,
          body: JSON.stringify({ error: eventsData.error.message })
        };
      }

      // Convert events to busy time slots matching the site's TIME_SLOTS format
      const TIME_SLOTS = [
        '9:00 AM','9:30 AM','10:00 AM','10:30 AM',
        '11:00 AM','11:30 AM','12:00 PM','12:30 PM',
        '1:00 PM','1:30 PM','2:00 PM','2:30 PM',
        '3:00 PM','3:30 PM','4:00 PM','4:30 PM'
      ];

      const busySlots = [];
      const events = eventsData.value || [];

      TIME_SLOTS.forEach(slot => {
        // Parse slot into a Date for comparison
        const [time, period] = slot.split(' ');
        let [hours, minutes] = time.split(':').map(Number);
        if (period === 'PM' && hours !== 12) hours += 12;
        if (period === 'AM' && hours === 12) hours = 0;
        const slotStart = new Date(`${date}T${String(hours).padStart(2,'0')}:${String(minutes).padStart(2,'0')}:00-06:00`);
        const slotEnd   = new Date(slotStart.getTime() + 60 * 60 * 1000); // 1hr slots

        // Check if any event overlaps this slot
        const isBusy = events.some(ev => {
          const evStart = new Date(ev.start.dateTime + (ev.start.timeZone === 'UTC' ? 'Z' : ''));
          const evEnd   = new Date(ev.end.dateTime   + (ev.end.timeZone   === 'UTC' ? 'Z' : ''));
          return evStart < slotEnd && evEnd > slotStart;
        });

        if (isBusy) busySlots.push(slot);
      });

      return {
        statusCode: 200, headers,
        body: JSON.stringify({ date, busySlots })
      };
    }

    // ─── CREATE BOOKING ───
    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const { clientName, clientEmail, service, date, time, durationMinutes = 60 } = body;

      if (!clientName || !clientEmail || !service || !date || !time) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing booking fields.' }) };
      }

      // Parse the time slot into a start datetime
      const [t, period] = time.split(' ');
      let [hours, minutes] = t.split(':').map(Number);
      if (period === 'PM' && hours !== 12) hours += 12;
      if (period === 'AM' && hours === 12) hours = 0;

      const startISO = `${date}T${String(hours).padStart(2,'0')}:${String(minutes).padStart(2,'0')}:00`;
      const endDate  = new Date(`${startISO}-06:00`);
      endDate.setMinutes(endDate.getMinutes() + durationMinutes);
      const endISO = endDate.toISOString().replace('Z','');

      // Create the calendar event on Coach Mo's Outlook
      const eventPayload = {
        subject: `CM&M Booking: ${service} — ${clientName}`,
        body: {
          contentType: 'HTML',
          content: `
            <p><strong>Service:</strong> ${service}</p>
            <p><strong>Client:</strong> ${clientName}</p>
            <p><strong>Client Email:</strong> ${clientEmail}</p>
            <p><strong>Date:</strong> ${date} at ${time}</p>
            <br/>
            <p><em>Booked via CM&M Financial website</em></p>
          `
        },
        start: { dateTime: startISO, timeZone: 'America/Chicago' },
        end:   { dateTime: endISO.split('-06')[0] || endISO, timeZone: 'America/Chicago' },
        attendees: [
          {
            emailAddress: { address: clientEmail, name: clientName },
            type: 'required'
          }
        ],
        isReminderOn: true,
        reminderMinutesBeforeStart: 60
      };

      const createRes = await fetch(
        `https://graph.microsoft.com/v1.0/users/${COACH_EMAIL}/events`,
        { method: 'POST', headers: graphHeaders, body: JSON.stringify(eventPayload) }
      );
      const createData = await createRes.json();

      if (createData.error) {
        console.error('Create event error:', createData.error);
        return {
          statusCode: 500, headers,
          body: JSON.stringify({ error: createData.error.message })
        };
      }

      return {
        statusCode: 200, headers,
        body: JSON.stringify({ success: true, eventId: createData.id })
      };
    }

    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed.' }) };

  } catch (err) {
    console.error('Function error:', err);
    return {
      statusCode: 500, headers,
      body: JSON.stringify({ error: err.message || 'Internal server error.' })
    };
  }
};
