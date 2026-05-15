const { jiraRequest } = require('./lib');

// Epics and tasks based on roadmap in DECISIONS.md
const projectKey = 'WDT';

const epics = [
  {
    name: 'Phase 1: Foundation',
    summary: 'Phase 1: Foundation - Project Setup',
    description: 'Initial project setup and configuration:\n- Agree on default visual theme (fonts, colors, spacing)\n- Develop technology plan & environment setup\n- Set up repository structure (Bitbucket)\n- Create Jira tasks for each step',
  },
  {
    name: 'Phase 2: Core Platform',
    summary: 'Phase 2: Core Platform - Homepage & Auth',
    description: 'Build homepage with Whitsundays imagery:\n- Hero section with navigation\n- Discrete login/signup button\n- User management (signup, login, forgot password)\n- Authentication system',
  },
  {
    name: 'Phase 3: Content Editor',
    summary: 'Phase 3: Content Editor - Chapter Management',
    description: 'Build content editor interface:\n- Grid display of all chapters\n- Content creation & editing\n- Slide management (create, reorder, edit)\n- Text frames (bubble, drop, rectangle shapes)\n- Author-only editing permissions\n- Admin delete capabilities\n- Author disable capabilities',
  },
  {
    name: 'Phase 4: Preview & Optimization',
    summary: 'Phase 4: Preview & Optimization',
    description: 'Implement preview and optimization:\n- Optimized preview renderer\n- JSON schema validation\n- Asset caching strategy\n- Scroll animations (parallax, float, fade)\n- Transition effects',
  },
  {
    name: 'Phase 5: PWA & Deployment',
    summary: 'Phase 5: PWA & Deployment',
    description: 'Progressive Web App features:\n- Service worker implementation\n- Offline support\n- Mobile optimization\n- Test suite\n- CI/CD Pipeline (Bitbucket Pipelines)\n- Production deployment to wdt.vixi.au',
  },
];

async function createIssue(summary, description, issuetype = 'Task', parent = null) {
  const issueData = {
    fields: {
      project: { key: projectKey },
      summary: summary,
      description: {
        type: 'doc',
        version: 1,
        content: [{
          type: 'paragraph',
          content: [{ type: 'text', text: description }]
        }]
      },
      issuetype: { name: issuetype },
    }
  };
  
  if (parent) {
    issueData.fields.parent = { key: parent };
  }
  
  return await jiraRequest('/issue', {
    method: 'POST',
    body: JSON.stringify(issueData)
  });
}

async function main() {
  try {
    console.log('Creating Jira tickets for Whitsunday Discovery Trail...\n');
    
    for (const epic of epics) {
      console.log(`Creating Epic: ${epic.name}`);
      const createdEpic = await createIssue(
        epic.summary,
        epic.description,
        'Epic'
      );
      console.log(`  ✓ Created: ${createdEpic.key} - ${epic.summary}`);
    }
    
    console.log('\n✅ All Jira tickets created successfully!');
  } catch (err) {
    console.error('Error creating Jira tickets:', err.message);
    process.exit(1);
  }
}

main();
