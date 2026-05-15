const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const SECRETS_DIR = path.join(__dirname, 'secrets');
const CLIENT_PATH = path.join(SECRETS_DIR, 'oauth-client.json');
const TOKEN_PATH = path.join(SECRETS_DIR, 'token.json');

function loadClient() {
  const raw = fs.readFileSync(CLIENT_PATH, 'utf8');
  const json = JSON.parse(raw);
  const c = json.installed || json.web;
  if (!c) throw new Error('oauth-client.json must have "installed" or "web" section');
  const redirectUris = c.redirect_uris || [];
  const redirectUri = redirectUris.find(u => u.includes('urn:ietf:wg:oauth:2.0:oob')) || redirectUris[0];
  return { client_id: c.client_id, client_secret: c.client_secret, redirect_uri: redirectUri };
}

function getAuth() {
  if (!fs.existsSync(CLIENT_PATH)) {
    throw new Error(`Missing OAuth client secrets at ${CLIENT_PATH}. Copy your JSON there.`);
  }
  if (!fs.existsSync(TOKEN_PATH)) {
    throw new Error(`Missing token at ${TOKEN_PATH}. Run: node auth.js`);
  }
  const { client_id, client_secret, redirect_uri } = loadClient();
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uri);
  const tokens = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
  oAuth2Client.setCredentials(tokens);
  return oAuth2Client;
}

module.exports = { getAuth };
