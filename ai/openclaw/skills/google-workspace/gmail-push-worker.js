const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { google } = require('googleapis');
const { PubSub } = require('@google-cloud/pubsub');
const { getAuth } = require('./lib');
const { sendTelegram, sendEmail, RACHAEL_EMAIL } = require('./notifier');

// Watches a Pub/Sub subscription for Gmail push notifications.
// UPDATED: Age check REMOVED due to server clock skew.

const STATE_PATH = path.join(__dirname, 'push-state.json');
const WATCH_STATE_PATH = path.join(__dirname, 'watch-state.json');
const HOME_DIR = process.env.HOME || '/home/asdrubal';
const AGENT_USER = path.basename(HOME_DIR);

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch { return {}; }
}
function saveState(s) { fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2)); }
function loadWatchLabelIds() {
  try {
    const state = JSON.parse(fs.readFileSync(WATCH_STATE_PATH, 'utf8'));
    return Array.isArray(state.labelIds) ? state.labelIds : ['INBOX'];
  } catch {
    return ['INBOX'];
  }
}

function headersToObj(headers) {
  return Object.fromEntries((headers || []).map(h => [String(h.name || '').toLowerCase(), h.value]));
}

// --- Jira failover helpers (avoid noisy/duplicate/pointless notifications) ---
const JIRA_BASE_URL = 'https://zeh-ferrari.atlassian.net';
const JIRA_USERNAME = AGENT_USER === 'barekbaal' ? 'b@zeh.me' : 'a@zeh.me';
const JIRA_TOKEN_PATH = path.join(HOME_DIR, '.ssh', 'jiraToken.txt');

function getJiraAuthHeader() {
  try {
    const token = fs.readFileSync(JIRA_TOKEN_PATH, 'utf8').trim();
    const basic = Buffer.from(`${JIRA_USERNAME}:${token}`).toString('base64');
    return `Basic ${basic}`;
  } catch {
    return null;
  }
}

function isTerminalJiraStatus(statusName) {
  const s = String(statusName || '').toLowerCase();
  return ['backlog', 'done', 'closed', 'cancelled', 'canceled', 'rejected'].includes(s);
}

function extractJiraIssueKey(subject) {
  const match = String(subject || '').match(/\b([A-Z][A-Z0-9]+-\d+)\b/);
  return match ? match[1] : null;
}

async function fetchJiraIssueStatus(issueKey) {
  const auth = getJiraAuthHeader();
  if (!auth) return null;
  try {
    const res = await fetch(
      `${JIRA_BASE_URL}/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=status,resolution`,
      { headers: { Authorization: auth, Accept: 'application/json' } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data?.fields?.status?.name || null;
  } catch {
    return null;
  }
}

function wakeAgent(homeDir, text) {
  const agentUser = path.basename(homeDir);
  try {
    execFileSync('sudo', [
      '-n',
      '/usr/local/sbin/openclaw-control',
      'wake-agent',
      agentUser,
      text,
    ], { stdio: 'ignore' });
    return true;
  } catch (controlErr) {
    try {
      execFileSync('openclaw', [
        'system', 'event',
        '--mode', 'now',
        '--text', text,
        '--timeout', '30000',
        '--json',
      ], { stdio: 'ignore' });
      console.error(`[Email] openclaw-control wake unavailable; used raw openclaw fallback for ${agentUser}: ${controlErr?.message || controlErr}`);
      return true;
    } catch (rawErr) {
      console.error(`[Email] Failed to wake ${agentUser}: openclaw-control=${controlErr?.message || controlErr}; raw=${rawErr?.message || rawErr}`);
      return false;
    }
  }
}

async function fetchNewFromHistory(gmail, startHistoryId) {
  const ids = new Set();
  let pageToken;
  try {
    do {
      const res = await gmail.users.history.list({
        userId: 'me',
        startHistoryId,
        historyTypes: ['messageAdded'],
        pageToken,
      });
      for (const h of res.data.history || []) {
        for (const added of h.messagesAdded || []) {
          if (added.message?.id) ids.add(added.message.id);
        }
      }
      pageToken = res.data.nextPageToken;
    } while (pageToken);
  } catch (e) {
    if (e?.response?.status === 404) return null; // History expired
    throw e;
  }
  return Array.from(ids);
}

async function main() {
  const subName = process.argv[2];
  if (!subName) {
    console.error('Usage: node gmail-push-worker.js <subscriptionName>');
    process.exit(1);
  }

  const auth = getAuth();
  const gmail = google.gmail({ version: 'v1', auth });
  
  const pubsubOptions = { projectId: 'asdrubal-projects' };
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    pubsubOptions.authClient = auth;
  }
  const pubsub = new PubSub(pubsubOptions);
  const subscription = pubsub.subscription(subName);

  const state = loadState();
  const watchedLabelIds = loadWatchLabelIds();

  // Establish a safe baseline to avoid replaying old emails on restart.
  // If we don't have state, or it looks stale, jump to current profile.historyId.
  const profile = await gmail.users.getProfile({ userId: 'me' });
  const profileEmail = String(profile.data.emailAddress || '').toLowerCase();
  const currentHistoryId = Number(profile.data.historyId);
  const last = Number(state.lastHistoryId || 0);

  // If missing or far behind, reset baseline to now (prevents reprocessing old mail).
  if (!last || last < currentHistoryId - 50) {
    state.lastHistoryId = String(currentHistoryId);
    saveState(state);
  }


  console.error(`Gmail push worker listening on: ${subName}`);

  subscription.on('message', async (message) => {
    try {
      const data = JSON.parse(message.data ? message.data.toString('utf8') : '{}');
      if (!data.historyId) {
        message.ack();
        return;
      }

      const pushedEmail = String(data.emailAddress || '').toLowerCase();
      if (pushedEmail && profileEmail && pushedEmail !== profileEmail) {
        console.log(`[Email] Ignoring Gmail push for ${pushedEmail}; this worker owns ${profileEmail}.`);
        message.ack();
        return;
      }

      let newIds = await fetchNewFromHistory(gmail, state.lastHistoryId);
      
      if (newIds === null) {
        console.error('History expired, resetting baseline...');
        const profile = await gmail.users.getProfile({ userId: 'me' });
        state.lastHistoryId = profile.data.historyId;
        saveState(state);
        message.ack();
        return;
      }

      state.lastHistoryId = data.historyId;
      saveState(state);

      for (const id of newIds) {
        try {
          const msg = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
          const msgLabelIds = msg.data.labelIds || [];
          if (watchedLabelIds.length && !watchedLabelIds.some(labelId => msgLabelIds.includes(labelId))) {
            continue;
          }
          const headers = headersToObj(msg.data.payload.headers);
          
          // --- FILTERS ---
          // AGE CHECK REMOVED

          // 2. Automated/Spam Filter
          const from = headers.from || '';
          const subject = headers.subject || '(no subject)';
          const snippet = msg.data.snippet || '';
          
          const isAutomated = 
            (headers['list-unsubscribe'] && !from.includes('zeh.me')) ||
            headers['precedence'] === 'bulk' || 
            headers['x-autoreply'] ||
            from.toLowerCase().includes('no-reply') || 
            from.toLowerCase().includes('noreply') ||
            from.toLowerCase().includes('notifications@') ||
            from.toLowerCase().includes('bounce');

          // Actionable senders (Jira as backup when webhooks fail)
          const homeDir = HOME_DIR;
          const agentUser = path.basename(homeDir);
          const selfEmail = agentUser === 'barekbaal' ? 'b@zeh.me' : 'a@zeh.me';
          const isZeh = from.includes('e@zeh.me');
          const isRachael = from.includes('contact@rachaelsmith.net.au');
          const isJira = from.includes('jira@zeh-ferrari.atlassian.net');
          const isSiblingAgent =
            (from.includes('a@zeh.me') || from.includes('b@zeh.me')) &&
            !from.includes(selfEmail);

          const isActionableSender = isZeh || isRachael || isJira || isSiblingAgent;

          const notifMsg = `From: ${from}\nSubject: ${subject}\nSnippet: ${snippet}`;

          // Every email that reaches this worker is marked read before the action/no-action decision.
          await gmail.users.messages.modify({
            userId: 'me', id,
            requestBody: { removeLabelIds: ['UNREAD'] }
          });

          // For bulk/automated emails from non-actionable senders: mark read and stop.
          if (isAutomated && !isActionableSender) {
            console.log(`Marked automated/bulk email as read from: ${from}`);
            continue;
          }

          // For actionable senders: queue task + announce we are working.
          if (isActionableSender) {
            const tasksDir = path.join(homeDir, 'tasks');
            try { fs.mkdirSync(tasksDir, { recursive: true }); } catch {}

            const currentPath = path.join(tasksDir, 'current.md');
            const logPath = path.join(tasksDir, 'log.md');
            const now = new Date();
            const nowIso = now.toISOString();
            const nowLocal = now.toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' });

            // Single source of truth: current.md gets a structured section with Next steps + Progress log.
            const entry = [
              `\n---\n`,
              `## ${subject}\n`,
              `Source: ${from}\n`,
              `Received: ${nowLocal}\n`,
              `Gmail messageId: ${id}\n`,
              `Status: QUEUED\n`,
              `\n### Next steps\n`,
              `- [ ] (fill in)\n`,
              `\n### Progress log\n`,
              `- ${nowLocal} — queued from email\n`,
              `\n### Snippet\n`,
              `> ${String(snippet).replace(/\n/g, '\n> ')}\n`,
              ``
            ].join('');

            // De-dupe by Gmail messageId (push history can sometimes deliver duplicates).
            // IMPORTANT: do NOT send Telegram/wake the agent if there's nothing actionable.
            let didAppend = false;
            let shouldWakeAgent = false;
            let shouldTelegram = false;

            let jiraIssueKey = null;
            if (isJira) {
              jiraIssueKey = extractJiraIssueKey(subject);
              if (jiraIssueKey) {
                const jiraStatus = await fetchJiraIssueStatus(jiraIssueKey);
                if (isTerminalJiraStatus(jiraStatus)) {
                  console.log(`[Email] Jira issue ${jiraIssueKey} is ${jiraStatus}; ignoring email (no-op).`);
                  continue;
                }
              }
            }

            try {
              const existing = fs.existsSync(currentPath) ? fs.readFileSync(currentPath, 'utf8') : '';
              const isDuplicateByMessageId = existing.includes(`Gmail messageId: ${id}`);
              if (isDuplicateByMessageId) {
                console.log(`[Email] Duplicate messageId ${id}; skipping silently.`);
                continue;
              }

              const isAlreadyTrackedIssue = Boolean(isJira && jiraIssueKey && existing.includes(jiraIssueKey));

              // If this Jira issue is already tracked, don't create a new task section.
              // Still wake the agent (silently) so it can pick up new comments/changes.
              if (!isAlreadyTrackedIssue) {
                fs.appendFileSync(currentPath, entry);
                didAppend = true;
                const logLine = `${nowIso} — queued email task: "${subject}" from ${from} (id=${id})\n`;
                fs.appendFileSync(logPath, logLine);
              } else {
                const logLine = `${nowIso} — jira email update: ${jiraIssueKey} — "${subject}" (id=${id})\n`;
                fs.appendFileSync(logPath, logLine);
              }

              // Wake agent rules:
              // - Jira: wake on updates (unless Done/Closed, handled above)
              // - Non-Jira actionable senders: wake only when we appended a new task
              shouldWakeAgent = isJira ? true : didAppend;

              // Telegram rule: the dispatcher never announces task start.
              // The awakened agent owns that message to avoid duplicate starts.
              shouldTelegram = false;

              // Do not send Telegram from the dispatcher.
              // The agent sends exactly one start notice after it wakes and accepts the task.

              if (shouldWakeAgent) {
                const wakeText = isSiblingAgent
                  ? `Sibling agent email update received: ${subject} (from ${from}).\n\nProcess ${homeDir}/tasks/current.md now. This is an ongoing email-thread update: do not send Telegram progress, completion, blocker, or start messages. Keep all task communication in the email thread. If the update contains a plan, review or act on it as requested by the original email. Sign every outbound email with the current runtime model using the TEAM_WORKFLOW.md Outbound Signature Rule. Update ${homeDir}/tasks/log.md.`
                  : didAppend
                  ? `New actionable email queued: ${subject} (from ${from}).\n\nProcess ${homeDir}/tasks/current.md now. Send exactly one concise Telegram start notice to zeh, then keep all task communication in the email thread. Do not send Telegram progress, completion, or blocker messages for this email task unless zeh explicitly redirects the conversation. Reply to the email promptly when the request asks for a response or acknowledgement. Sign every outbound email with the current runtime model using the TEAM_WORKFLOW.md Outbound Signature Rule. Fill Next steps, execute immediately per SOUL.md and TEAM_WORKFLOW.md, and update ${homeDir}/tasks/log.md.`
                  : `Jira email update received${jiraIssueKey ? ` for ${jiraIssueKey}` : ''}: ${subject}.\n\nSend exactly one concise Telegram start notice only if this creates actionable work, then keep all task communication in Jira. Do not send Telegram progress, completion, or blocker messages for this Jira task unless zeh explicitly redirects the conversation. Check Jira live for new comments/status changes, transition workflow state according to TEAM_WORKFLOW.md, sign every outbound Jira comment/update with the current runtime model, avoid duplicating tasks in ${homeDir}/tasks/current.md, and act immediately.`;
                wakeAgent(homeDir, wakeText);
              }
            } catch (e) {
              // If de-dupe logic fails, fall back to append (but still don't Telegram unless we actually appended).
              try {
                fs.appendFileSync(currentPath, entry);
                didAppend = true;
                const logLine = `${nowIso} — queued email task: "${subject}" from ${from} (id=${id})\n`;
                fs.appendFileSync(logPath, logLine);
              } catch (_) {}

              try {
                wakeAgent(homeDir, `New actionable email queued: ${subject} (from ${from}).\n\nProcess ${homeDir}/tasks/current.md now. Send exactly one concise Telegram start notice to zeh, then keep all task communication in the email thread. Do not send Telegram progress, completion, or blocker messages for this email task unless zeh explicitly redirects the conversation. Reply to the email promptly when the request asks for a response or acknowledgement. Sign every outbound email with the current runtime model using the TEAM_WORKFLOW.md Outbound Signature Rule. Fill Next steps, execute immediately per SOUL.md and TEAM_WORKFLOW.md, and update ${homeDir}/tasks/log.md.`);
              } catch (_) {}
            }

            console.log(`[Email] ${didAppend ? 'Action queued' : 'Update received'} for ${from}: ${subject}`);
            continue;
          }

          // Non-actionable but not automated: just notify quietly (optional).
          console.log(`[Email] Non-actionable email marked read from ${from}: ${subject}`);
          // No Telegram ping to avoid noise.
          

        } catch (err) {
          console.error(`Error processing msg ${id}:`, err);
        }
      }

      message.ack();
    } catch (e) {
      console.error('Error handling push message:', e);
      message.nack();
    }
  });
}

main().catch(console.error);
