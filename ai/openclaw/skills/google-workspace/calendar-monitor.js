#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { getAuth } = require('./lib');
const { sendTelegram, sendEmail, RACHAEL_EMAIL } = require('./notifier');

const STATE_PATH = path.join(__dirname, 'calendar-monitor-state.json');

function readJson(p, def) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return def; }
}
function writeJson(p, data) {
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

async function main() {
  const state = readJson(STATE_PATH, { knownEventIds: [] });
  // Keep last 500 IDs to avoid indefinite growth
  const knownIds = new Set(state.knownEventIds);

  const auth = getAuth();
  const calendar = google.calendar({ version: 'v3', auth });

  // List upcoming events (next 30 days?) or just recently updated?
  // updatedMin is better for catching *newly created* events even if they are in the future.
  // But updatedMin requires syncToken logic which is complex.
  // Let's stick to polling upcoming for simplicity, or check 'updated' field.
  
  const res = await calendar.events.list({
    calendarId: 'primary',
    timeMin: new Date().toISOString(),
    maxResults: 50,
    singleEvents: true,
    orderBy: 'startTime',
  });

  const events = res.data.items || [];
  const currentIds = [];
  let newEventsFound = false;

  for (const event of events) {
    currentIds.push(event.id);
    
    if (knownIds.has(event.id)) continue;
    
    // NEW EVENT FOUND
    newEventsFound = true;
    const summary = event.summary || '(No Title)';
    const start = event.start.dateTime || event.start.date;
    const creator = event.creator?.email || '';
    const organizer = event.organizer?.email || '';
    
    const isZeh = creator.includes('zeh.me') || organizer.includes('zeh.me');
    const isRachael = creator.includes('rachaelsmith') || organizer.includes('rachaelsmith');
    
    const notifMsg = `📅 *New Calendar Event*\nEvent: ${summary}\nTime: ${start}\nOrganizer: ${organizer}`;

    if (isZeh || isRachael) {
       if (isZeh) {
         sendTelegram(`🚀 *Immediate Action* (Calendar)\n${notifMsg}\n\n_I'm on it!_`);
       } else {
         // Notify via email to Rachael? Or Telegram to you about Rachael?
         // User said: "Notify via Email when is Rachael"
         sendEmail(RACHAEL_EMAIL, `Re: Calendar Event "${summary}"`, "I see the new calendar event and I'm prepared.");
         // Also notify you on Telegram so you know
         sendTelegram(`🚀 *Immediate Action* (Calendar - Rachael)\n${notifMsg}`);
       }
    } else {
       sendTelegram(`📝 *Pending Request* (Calendar)\n${notifMsg}\n\n_Waiting for confirmation._`);
    }
  }

  // Update state with current IDs (to detect *new* ones next time)
  // Merging known + current is safer to avoid re-alerting if an event drops off list
  // But standard practice for polling "new" is comparing sets.
  // We'll just append new ones to state.
  if (newEventsFound) {
    // Add all current IDs to known list
    currentIds.forEach(id => knownIds.add(id));
    state.knownEventIds = Array.from(knownIds);
    writeJson(STATE_PATH, state);
  }
}

main().catch(console.error);
