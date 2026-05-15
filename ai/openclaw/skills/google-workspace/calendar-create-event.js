const { google } = require('googleapis');
const { getAuth } = require('./lib');

function usage() {
  console.error('Usage: node calendar-create-event.js "Title" "2026-02-14T10:00:00+10:00" "2026-02-14T10:30:00+10:00" [description]');
  process.exit(1);
}

async function main() {
  const [summary, start, end, ...rest] = process.argv.slice(2);
  const description = rest.join(' ').trim();
  if (!summary || !start || !end) usage();

  const auth = getAuth();
  const calendar = google.calendar({ version: 'v3', auth });

  const res = await calendar.events.insert({
    calendarId: 'primary',
    requestBody: {
      summary,
      description: description || undefined,
      start: { dateTime: start },
      end: { dateTime: end }
    }
  });

  console.log(JSON.stringify({
    id: res.data.id,
    htmlLink: res.data.htmlLink,
    summary: res.data.summary,
    start: res.data.start,
    end: res.data.end,
  }, null, 2));
}

main().catch(err => {
  console.error(err?.response?.data || err);
  process.exit(1);
});
