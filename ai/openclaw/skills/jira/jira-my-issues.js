const { jiraBrowseUrl, jiraSearch } = require('./lib');

async function main() {
  try {
    // Get my assigned issues
    const jql = 'assignee = currentUser() AND status NOT IN (Done, Closed) ORDER BY updated DESC';
    const result = await jiraSearch(jql, 20);
    
    console.log(JSON.stringify({
      total: result.total,
      issues: result.issues.map(i => ({
        key: i.key,
        summary: i.fields.summary,
        status: i.fields.status.name,
        priority: i.fields.priority?.name || 'None',
        updated: i.fields.updated,
        url: jiraBrowseUrl(i.key)
      }))
    }, null, 2));
  } catch (err) {
    console.error(JSON.stringify({ error: err.message }, null, 2));
    process.exit(1);
  }
}

main();
