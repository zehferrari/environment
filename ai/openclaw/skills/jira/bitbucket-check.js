const fs = require('fs');
const path = require('path');

function envValue(name) {
  return typeof process.env[name] === 'string' ? process.env[name].trim() : '';
}

function getConfig() {
  const required = [
    'BITBUCKET_WORKSPACE',
    'BITBUCKET_REPO_SLUG',
    'BITBUCKET_USERNAME',
  ];
  const missing = required.filter((name) => !envValue(name));

  if (missing.length > 0) {
    throw new Error(
      `Missing Bitbucket configuration: ${missing.join(', ')}. ` +
      'Set BITBUCKET_WORKSPACE, BITBUCKET_REPO_SLUG, and BITBUCKET_USERNAME before running this check.'
    );
  }

  const home = envValue('HOME');
  const tokenPath = envValue('BITBUCKET_TOKEN_PATH') ||
    (home ? path.join(home, '.ssh', 'bitbucketToken.txt') : '');

  if (!tokenPath) {
    throw new Error(
      'Bitbucket token path is not configured. Set BITBUCKET_TOKEN_PATH, or set HOME so the default ~/.ssh/bitbucketToken.txt path can be used.'
    );
  }

  return {
    workspace: envValue('BITBUCKET_WORKSPACE'),
    repoSlug: envValue('BITBUCKET_REPO_SLUG'),
    username: envValue('BITBUCKET_USERNAME'),
    tokenPath,
  };
}

function getToken(tokenPath) {
  if (!fs.existsSync(tokenPath)) {
    throw new Error(`Bitbucket token not found at ${tokenPath}`);
  }

  const token = fs.readFileSync(tokenPath, 'utf8').trim();
  if (!token) {
    throw new Error(`Bitbucket token at ${tokenPath} is empty`);
  }

  return token;
}

function getAuthHeader(config) {
  const token = getToken(config.tokenPath);
  // Bitbucket app passwords use Basic auth: base64(username:app-password)
  const basic = Buffer.from(`${config.username}:${token}`).toString('base64');
  return `Basic ${basic}`;
}

async function bitbucketRequest(config, endpoint) {
  const url = `https://api.bitbucket.org/2.0${endpoint}`;

  const response = await fetch(url, {
    headers: {
      'Authorization': getAuthHeader(config),
      'Accept': 'application/json'
    }
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Bitbucket API error: ${response.status} - ${error}`);
  }

  return response.json();
}

function repositoryEndpoint(config, suffix = '') {
  const workspace = encodeURIComponent(config.workspace);
  const repoSlug = encodeURIComponent(config.repoSlug);
  return `/repositories/${workspace}/${repoSlug}${suffix}`;
}

async function main() {
  try {
    const config = getConfig();
    console.log('Checking Bitbucket repository...');

    // Get repository info
    const repo = await bitbucketRequest(config, repositoryEndpoint(config));
    console.log(`✓ Repository: ${repo.name}`);
    console.log(`  Description: ${repo.description || 'None'}`);
    console.log(`  Private: ${repo.is_private}`);
    console.log(`  Created: ${repo.created_on}`);
    console.log(`  URL: ${repo.links.html.href}`);

    // Check my permissions
    console.log('\nChecking my access...');
    const user = await bitbucketRequest(config, '/user');
    console.log(`✓ Connected as: ${user.display_name} (${user.username})`);

    // List recent commits
    console.log('\nRecent commits:');
    const commits = await bitbucketRequest(config, repositoryEndpoint(config, '/commits'));
    if (commits.values && commits.values.length > 0) {
      commits.values.slice(0, 5).forEach(c => {
        console.log(`  - ${c.hash.substring(0, 8)}: ${c.message.split('\n')[0]}`);
      });
    } else {
      console.log('  No commits yet (empty repository)');
    }
    
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { getConfig, getToken, getAuthHeader, bitbucketRequest, repositoryEndpoint };
