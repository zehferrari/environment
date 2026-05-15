const fs = require('fs');
const path = require('path');

const BITBUCKET_WORKSPACE = 'zehferrari';
const REPO_SLUG = 'whitsunday-discovery-trail';
const TOKEN_PATH = path.join(process.env.HOME, '.ssh', 'bitbucketToken.txt');
const BITBUCKET_USERNAME = 'a@zeh.me'; // Atlassian account email

function getToken() {
  if (!fs.existsSync(TOKEN_PATH)) {
    throw new Error(`Token not found at ${TOKEN_PATH}`);
  }
  return fs.readFileSync(TOKEN_PATH, 'utf8').trim();
}

function getAuthHeader() {
  const token = getToken();
  // Bitbucket app passwords use Basic auth: base64(username:app-password)
  const basic = Buffer.from(`${BITBUCKET_USERNAME}:${token}`).toString('base64');
  return `Basic ${basic}`;
}

async function bitbucketRequest(endpoint) {
  const url = `https://api.bitbucket.org/2.0${endpoint}`;
  
  const response = await fetch(url, {
    headers: {
      'Authorization': getAuthHeader(),
      'Accept': 'application/json'
    }
  });
  
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Bitbucket API error: ${response.status} - ${error}`);
  }
  
  return response.json();
}

async function main() {
  try {
    console.log('Checking Bitbucket repository...');
    
    // Get repository info
    const repo = await bitbucketRequest(`/repositories/${BITBUCKET_WORKSPACE}/${REPO_SLUG}`);
    console.log(`✓ Repository: ${repo.name}`);
    console.log(`  Description: ${repo.description || 'None'}`);
    console.log(`  Private: ${repo.is_private}`);
    console.log(`  Created: ${repo.created_on}`);
    console.log(`  URL: ${repo.links.html.href}`);
    
    // Check my permissions
    console.log('\nChecking my access...');
    const user = await bitbucketRequest('/user');
    console.log(`✓ Connected as: ${user.display_name} (${user.username})`);
    
    // List recent commits
    console.log('\nRecent commits:');
    const commits = await bitbucketRequest(`/repositories/${BITBUCKET_WORKSPACE}/${REPO_SLUG}/commits`);
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

main();
