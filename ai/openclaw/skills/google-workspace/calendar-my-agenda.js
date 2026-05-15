const { google } = require('googleapis');
const { getAuth } = require('./lib');

// Lists upcoming events (default next 10)
async function main() {
  const maxResults = Number(process.argv[2] || 10);
  const auth = getAuth();
  const calendar = google.calendar({ version: 'v3', auth });

  const res = await calendar.events.list({
    calendarId: 'primary',
    timeMin: new Date().toISOString(),
    maxResults,
    singleEvents: true,
    orderBy: 'startTime'
  });

  const items = (res.data.items || []).map(e => ({
    id: e.id,
    summary: e.summary,
    start: e.start?.dateTime || e.start?.date,
    end: e.end?.dateTime || e.end?.date,
    htmlLink: e.htmlLink
  }));

  console.log(JSON.stringify(items, null, 2));
}

main().catch(err => {
  console.error(err?.response?.data || err);
  process.exit(1);
});
