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

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  const { MS_CLIENT_ID, MS_TENANT_ID, MS_CLIENT_SECRET } = process.env;

  if (!MS_CLIENT_ID || !MS_TENANT_ID || !MS_CLIENT_SECRET) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Microsoft credentials not configured.' }) };
  }

  try {
    // ─── GET ACCESS TOKEN ───
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
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Failed to authenticate with Microsoft.' }) };
    }
    const accessToken = tokenData.access_token;
    const graphHeaders = {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    };

    const COACH_EMAIL = 'matecha@cmandmconsulting.com';

    const TIME_SLOTS = [
      '9:00 AM','9:30 AM','10:00 AM','10:30 AM',
      '11:00 AM','11:30 AM','12:00 PM','12:30 PM',
      '1:00 PM','1:30 PM','2:00 PM','2:30 PM',
      '3:00 PM','3:30 PM','4:00 PM','4:30 PM'
    ];

    // Helper: parse "9:00 AM" → { hours, minutes } in 24hr
    function parseSlot(slot) {
      const [time, period] = slot.split(' ');
      let [hours, minutes] = time.split(':').map(Number);
      if (period === 'PM' && hours !== 12) hours += 12;
      if (period === 'AM' && hours === 12) hours = 0;
      return { hours, minutes };
    }

    // Helper: pad number to 2 digits
    const pad = n => String(n).padStart(2, '0');

    // ─── GET AVAILABILITY ───
    if (event.httpMethod === 'GET') {
      const params = event.queryStringParameters || {};
      const date = params.date;
      if (!date) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing date parameter.' }) };
      }

      const startUtc = `${date}T00:00:00Z`;
      const endUtc   = `${date}T23:59:59Z`;

      const eventsRes = await fetch(
        `https://graph.microsoft.com/v1.0/users/${COACH_EMAIL}/calendarView` +
        `?startDateTime=${startUtc}&endDateTime=${endUtc}&$select=subject,start,end`,
        { headers: graphHeaders }
      );
      const eventsData = await eventsRes.json();

      if (eventsData.error) {
        console.error('Graph API error:', eventsData.error);
        return { statusCode: 500, headers, body: JSON.stringify({ error: eventsData.error.message }) };
      }

      const events = eventsData.value || [];
      console.log(`Found ${events.length} events on ${date}`);

      // Detect CDT vs CST for correct UTC offset
      const slotDate = new Date(date + 'T12:00:00Z');
      const month = slotDate.getUTCMonth();
      const day   = slotDate.getUTCDate();
      const isCDT = (month > 2 && month < 10) || (month === 2 && day >= 8) || (month === 10 && day < 1);
      const offsetHours = isCDT ? 5 : 6;

      const busySlots = [];

      TIME_SLOTS.forEach(slot => {
        const { hours, minutes } = parseSlot(slot);

        // Convert slot local time to UTC for comparison
        const slotStartUTC = new Date(Date.UTC(
          slotDate.getUTCFullYear(), slotDate.getUTCMonth(), slotDate.getUTCDate(),
          hours + offsetHours, minutes, 0
        ));
        // FIX: end = start + exactly 1hr in milliseconds — no timezone math
        const slotEndUTC = new Date(slotStartUTC.getTime() + 60 * 60 * 1000);

        const isBusy = events.some(ev => {
          let evStartStr = ev.start.dateTime;
          let evEndStr   = ev.end.dateTime;
          if (ev.start.timeZone === 'UTC' && !evStartStr.endsWith('Z')) evStartStr += 'Z';
          if (ev.end.timeZone   === 'UTC' && !evEndStr.endsWith('Z'))   evEndStr   += 'Z';
          const evStart = new Date(evStartStr);
          const evEnd   = new Date(evEndStr);
          return evStart < slotEndUTC && evEnd > slotStartUTC;
        });

        if (isBusy) busySlots.push(slot);
      });

      console.log('Busy slots:', busySlots);
      return { statusCode: 200, headers, body: JSON.stringify({ date, busySlots }) };
    }

    // ─── CREATE BOOKING ───
    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const { clientName, clientEmail, service, date, time, durationMinutes = 60 } = body;

      if (!clientName || !clientEmail || !service || !date || !time) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing booking fields.' }) };
      }

      const { hours, minutes } = parseSlot(time);

      // FIX: Build start/end as plain local time strings — let timeZone field handle offset
      const startISO = `${date}T${pad(hours)}:${pad(minutes)}:00`;

      // FIX: Pure arithmetic for end time — no Date object timezone confusion
      const endTotalMins = hours * 60 + minutes + durationMinutes;
      const endISO = `${date}T${pad(Math.floor(endTotalMins / 60))}:${pad(endTotalMins % 60)}:00`;

      console.log(`Creating event: ${startISO} → ${endISO} America/Chicago`);

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
        // FIX: Pass clean local datetime + named timezone — Graph converts to UTC correctly
        start: { dateTime: startISO, timeZone: 'America/Chicago' },
        end:   { dateTime: endISO,   timeZone: 'America/Chicago' },
        attendees: [
          { emailAddress: { address: clientEmail, name: clientName }, type: 'required' }
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
        return { statusCode: 500, headers, body: JSON.stringify({ error: createData.error.message }) };
      }

      console.log('Event created:', createData.id);
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, eventId: createData.id }) };
    }

    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed.' }) };

  } catch (err) {
    console.error('Function error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message || 'Internal server error.' }) };
  }
};
