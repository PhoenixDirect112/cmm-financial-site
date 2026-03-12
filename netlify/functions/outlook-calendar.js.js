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
      '3:00 PM','3:30 PM','4:00 PM','4:30 PM',
      '5:00 PM','5:30 PM'
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

      // Wide UTC window — slots up to 7:30 PM CDT = 00:30 UTC next day,
      // plus buffer for CST (UTC-6). Use 06:00 UTC next day to be safe.
      const startUtc = `${date}T00:00:00Z`;
      const nextDate = new Date(date + 'T12:00:00Z');
      nextDate.setUTCDate(nextDate.getUTCDate() + 1);
      const nd = nextDate.toISOString().slice(0, 10);
      const endUtc = `${nd}T06:00:00Z`;

      const eventsRes = await fetch(
        `https://graph.microsoft.com/v1.0/users/${COACH_EMAIL}/calendarView` +
        `?startDateTime=${startUtc}&endDateTime=${endUtc}` +
        `&$select=subject,start,end,isAllDay,showAs,isCancelled`,
        { headers: { ...graphHeaders, 'Prefer': 'outlook.timezone="UTC"' } }
      );
      const eventsData = await eventsRes.json();

      if (eventsData.error) {
        console.error('Graph API error:', eventsData.error);
        return { statusCode: 500, headers, body: JSON.stringify({ error: eventsData.error.message }) };
      }

      // Filter out events that should NOT block time slots:
      //   - All-day events (holidays, birthdays, DST reminders, OOO markers)
      //   - Cancelled events
      //   - Events marked as "free" or "tentative" (only "busy"/"oof"/"workingElsewhere" block)
      const rawEvents = eventsData.value || [];
      const events = rawEvents.filter(ev => {
        if (ev.isAllDay) return false;
        if (ev.isCancelled) return false;
        if (ev.showAs === 'free' || ev.showAs === 'tentative') return false;
        return true;
      });
      console.log(`Found ${rawEvents.length} total events, ${events.length} blocking events on ${date}`);

      // Detect CDT vs CST using proper US DST rules:
      //   CDT starts: 2nd Sunday of March at 2:00 AM local (08:00 UTC)
      //   CST starts: 1st Sunday of November at 2:00 AM local (07:00 UTC)
      const slotDate = new Date(date + 'T12:00:00Z');
      const year = slotDate.getUTCFullYear();

      function getNthSunday(yr, month, n) {
        // month is 0-indexed; returns the day-of-month of the nth Sunday
        const first = new Date(Date.UTC(yr, month, 1));
        const firstDow = first.getUTCDay(); // 0=Sun
        const firstSunday = firstDow === 0 ? 1 : 8 - firstDow;
        return firstSunday + (n - 1) * 7;
      }

      const dstStartDay = getNthSunday(year, 2, 2);  // 2nd Sunday of March
      const dstEndDay   = getNthSunday(year, 10, 1);  // 1st Sunday of November
      // DST transition moments in UTC
      const dstStartUTC = new Date(Date.UTC(year, 2, dstStartDay, 8, 0, 0));  // 2 AM CST = 08:00 UTC
      const dstEndUTC   = new Date(Date.UTC(year, 10, dstEndDay, 7, 0, 0));   // 2 AM CDT = 07:00 UTC

      const isCDT = slotDate >= dstStartUTC && slotDate < dstEndUTC;
      const offsetHours = isCDT ? 5 : 6;

      // Pre-parse all Outlook events into UTC start/end once
      // The Prefer: outlook.timezone="UTC" header ensures all times come back in UTC.
      // Graph returns datetimes without a Z suffix, so we append it for correct JS parsing.
      const parsedEvents = events.map(ev => {
        let evStartStr = ev.start.dateTime;
        let evEndStr   = ev.end.dateTime;
        console.log(`  Raw event: "${ev.subject}" | start: ${evStartStr} (tz: ${ev.start.timeZone}) | end: ${evEndStr} (tz: ${ev.end.timeZone}) | showAs: ${ev.showAs}`);
        if (!evStartStr.endsWith('Z')) evStartStr += 'Z';
        if (!evEndStr.endsWith('Z'))   evEndStr   += 'Z';
        const parsed = { start: new Date(evStartStr), end: new Date(evEndStr) };
        console.log(`  Parsed UTC: ${parsed.start.toISOString()} → ${parsed.end.toISOString()}`);
        return parsed;
      });

      const busySlots = [];

      console.log(`Offset: CDT=${isCDT}, offsetHours=${offsetHours}`);

      // Check every 30-min slot — mark busy if ANY overlap with an Outlook event
      TIME_SLOTS.forEach(slot => {
        const { hours, minutes } = parseSlot(slot);
        const slotStartUTC = new Date(Date.UTC(
          slotDate.getUTCFullYear(), slotDate.getUTCMonth(), slotDate.getUTCDate(),
          hours + offsetHours, minutes, 0
        ));
        // 30-min window so partial overlaps are detected
        const slotEndUTC = new Date(slotStartUTC.getTime() + 30 * 60 * 1000);

        const isBusy = parsedEvents.some(ev => ev.start < slotEndUTC && ev.end > slotStartUTC);
        if (isBusy) {
          console.log(`  BUSY: ${slot} (${slotStartUTC.toISOString()} – ${slotEndUTC.toISOString()})`);
          busySlots.push(slot);
        }
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

      // Guard: reject bookings that would overflow past midnight
      if (endTotalMins >= 24 * 60) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Session would extend past midnight. Please choose an earlier time.' }) };
      }

      const endISO = `${date}T${pad(Math.floor(endTotalMins / 60))}:${pad(endTotalMins % 60)}:00`;

      console.log(`Creating event: ${startISO} → ${endISO} America/Chicago`);

      // ─── DOUBLE-BOOKING GUARD: re-check availability before creating ───
      // Compute the same DST offset used by the GET handler
      const bookDate = new Date(date + 'T12:00:00Z');
      const bookYear = bookDate.getUTCFullYear();

      function getNthSundayBook(yr, mo, n) {
        const first = new Date(Date.UTC(yr, mo, 1));
        const firstDow = first.getUTCDay();
        const firstSun = firstDow === 0 ? 1 : 8 - firstDow;
        return firstSun + (n - 1) * 7;
      }
      const dstStartDayB = getNthSundayBook(bookYear, 2, 2);
      const dstEndDayB   = getNthSundayBook(bookYear, 10, 1);
      const dstStartUTCB = new Date(Date.UTC(bookYear, 2, dstStartDayB, 8, 0, 0));
      const dstEndUTCB   = new Date(Date.UTC(bookYear, 10, dstEndDayB, 7, 0, 0));
      const isCDTBook = bookDate >= dstStartUTCB && bookDate < dstEndUTCB;
      const offsetBook = isCDTBook ? 5 : 6;

      // Build UTC window for the slot's full duration
      const slotStartUTC = new Date(Date.UTC(
        bookDate.getUTCFullYear(), bookDate.getUTCMonth(), bookDate.getUTCDate(),
        hours + offsetBook, minutes, 0
      ));
      const slotEndUTC = new Date(slotStartUTC.getTime() + durationMinutes * 60 * 1000);

      // Query Outlook for conflicting events
      const checkStart = slotStartUTC.toISOString();
      const checkEnd   = slotEndUTC.toISOString();
      const conflictRes = await fetch(
        `https://graph.microsoft.com/v1.0/users/${COACH_EMAIL}/calendarView` +
        `?startDateTime=${checkStart}&endDateTime=${checkEnd}&$select=id,start,end,isAllDay,showAs,isCancelled`,
        { headers: { ...graphHeaders, 'Prefer': 'outlook.timezone="UTC"' } }
      );
      const conflictData = await conflictRes.json();
      const conflicts = (conflictData.value || []).filter(ev => {
        // Skip all-day, cancelled, free/tentative — same logic as availability check
        if (ev.isAllDay || ev.isCancelled) return false;
        if (ev.showAs === 'free' || ev.showAs === 'tentative') return false;
        let evS = ev.start.dateTime;
        let evE = ev.end.dateTime;
        if (!evS.endsWith('Z')) evS += 'Z';
        if (!evE.endsWith('Z')) evE += 'Z';
        return new Date(evS) < slotEndUTC && new Date(evE) > slotStartUTC;
      });

      if (conflicts.length > 0) {
        console.warn(`Double-booking prevented: ${conflicts.length} conflict(s) for ${date} ${time}`);
        return {
          statusCode: 409, headers,
          body: JSON.stringify({ error: 'This time slot was just booked by someone else. Please choose another time.' })
        };
      }
      // ─── END DOUBLE-BOOKING GUARD ───

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
