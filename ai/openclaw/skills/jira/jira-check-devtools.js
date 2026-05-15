const { jiraRequest } = require('./lib');

async function main() {
  try {
    // Check development info for WDT project
    console.log('Checking Jira project development tools...');
    const devInfo = await jiraRequest('/project/WDT/developmentinfo');
    console.log(JSON.stringify(devInfo, null, 2));
  } catch (err) {
    // Try alternative approach - check issue with dev info
    try {
      console.log('Checking for repositories connected to Jira...');
      // Get an issue and see if it has development info
      const result = await jiraRequest('/search?jql=project=WDT&maxResults=1');
      if (result.issues && result.issues.length > 0) {
        const issueKey = result.issues[0].key;
        const devStatus = await jiraRequest(`/issue/${issueKey}/devstatus`);
        console.log(JSON.stringify(devStatus, null, 2));
      } else {
        console.log('No issues in project to check dev status');
      }
    } catch (err2) {
      console.log('Could not check development info:', err2.message);
    }
  }
}

main();
