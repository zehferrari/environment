const { jiraRequest, jiraSearch } = require('./lib');

async function main() {
  try {
    console.log('=== JIRA CONNECTION TEST ===\n');
    
    // Test 1: My account
    const myself = await jiraRequest('/myself');
    console.log(`✓ Connected as: ${myself.displayName} (${myself.emailAddress})`);
    
    // Test 2: Projects
    console.log('\n✓ Projects I have access to:');
    const projects = await jiraRequest('/project?expand=description');
    projects.forEach(p => {
      console.log(`  - ${p.key}: ${p.name}`);
    });
    
    // Test 3: Issues in WDT project
    console.log('\n✓ Issues in Whitsunday Discovery Trail:');
    const result = await jiraSearch('project = WDT ORDER BY updated DESC', 20);
    if (result.issues && result.issues.length > 0) {
      result.issues.forEach(i => {
        const assignee = i.fields.assignee ? i.fields.assignee.displayName : 'Unassigned';
        console.log(`  - ${i.key}: ${i.fields.summary}`);
        console.log(`    Status: ${i.fields.status.name} | Assignee: ${assignee} | Priority: ${i.fields.priority?.name || 'None'}`);
      });
    } else {
      console.log('  No issues found in WDT project');
    }
    
    // Test 4: Issues assigned to me
    console.log('\n✓ Issues assigned to me:');
    const myIssues = await jiraSearch('assignee = currentUser() ORDER BY updated DESC', 20);
    if (myIssues.issues && myIssues.issues.length > 0) {
      myIssues.issues.forEach(i => {
        console.log(`  - ${i.key}: ${i.fields.summary} (${i.fields.status.name})`);
      });
    } else {
      console.log('  No issues currently assigned to you');
    }
    
    console.log('\n=== ACCESS CONFIRMED ===');
    console.log('I can read the WDT project. Ready to work with issues, comments, and transitions.');
    
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

main();
