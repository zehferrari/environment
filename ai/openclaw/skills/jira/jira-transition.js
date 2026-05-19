const { jiraRequest } = require('./lib');
const self = require('../agent-self');

async function main() {
  const issueKey = process.argv[2];
  const newStatus = process.argv[3]; // e.g., "In Progress", "In Review", "Done"
  
  if (!issueKey || !newStatus) {
    console.error('Usage: node jira-transition.js <ISSUE-KEY> "Status Name"');
    console.error('Example: node jira-transition.js WDT-1 "In Progress"');
    process.exit(1);
  }

  if (self.agent?.role === 'manager' && /^in progress$/i.test(newStatus)) {
    console.error(JSON.stringify({
      error: 'Policy guard: manager-role agents do not move Jira tickets to In Progress. Assign implementation to the developer or ask zeh for an explicit handoff.'
    }, null, 2));
    process.exit(1);
  }
  
  try {
    // First get available transitions
    const transitionsResult = await jiraRequest(`/issue/${issueKey}/transitions`);
    
    const transition = transitionsResult.transitions.find(t => 
      t.name.toLowerCase() === newStatus.toLowerCase() ||
      t.to.name.toLowerCase() === newStatus.toLowerCase()
    );
    
    if (!transition) {
      console.error(JSON.stringify({
        error: `Transition to "${newStatus}" not found`,
        availableTransitions: transitionsResult.transitions.map(t => ({
          id: t.id,
          name: t.name,
          to: t.to.name
        }))
      }, null, 2));
      process.exit(1);
    }
    
    // Perform the transition
    await jiraRequest(`/issue/${issueKey}/transitions`, {
      method: 'POST',
      body: JSON.stringify({
        transition: { id: transition.id }
      })
    });
    
    console.log(JSON.stringify({
      success: true,
      issueKey,
      newStatus: transition.to.name,
      url: `https://zeh-ferrari.atlassian.net/browse/${issueKey}`
    }, null, 2));
  } catch (err) {
    console.error(JSON.stringify({ error: err.message }, null, 2));
    process.exit(1);
  }
}

main();
