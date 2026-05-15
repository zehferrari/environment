const { google } = require('googleapis');
const fs = require('fs');

async function updateDoc() {
  const oauth = JSON.parse(fs.readFileSync('./secrets/oauth-client.json'));
  const token = JSON.parse(fs.readFileSync('./secrets/token.json'));
  
  const auth = new google.auth.OAuth2(oauth.installed.client_id, oauth.installed.client_secret, oauth.installed.redirect_uris[0]);
  auth.setCredentials(token);
  
  const docs = google.docs({ version: 'v1', auth });
  
  const docId = '1wPtnQs2kLZMluv0wh6eijiN0XIMqg_jn9oy0hHjjQVw';
  
  const newContent = `Whitsunday Discovery Trail – WebApp Timeline Editor

Project: Whitsunday Heart of the Reef Discovery Trail
Owner: Whitsunday Conservation Council
Partners: University of the Sunshine Coast, Whitsunday Regional Council

Related Documents:
• Project Plan – business context, stakeholders, goals
• Content Development Proposal – editorial direction, narrative structure

═══════════════════════════════════════════════════════════════════════════════

TECHNICAL SPECIFICATION

═══════════════════════════════════════════════════════════════════════════════

Overview

Build a web-based editor for creating story-driven chapter experiences (parallax/scrollytelling format). Editors create timeline content (slide deck of scenes) with consistent style, motion, and preview.
Reference: https://eurekafiles.com/seagrass-chapter

Target Users
• Primary: Non-technical content editors (WCC staff, partners)
• Secondary: Advanced users (developers/designers)

───────────────────────────────────────────────────────────────────────────────

CORE FEATURES

───────────────────────────────────────────────────────────────────────────────

1. Timeline / Slide Deck Editor

• Create, reorder, edit, delete slides (scenes)
• Each slide = one scrollable section of the story
• Deck-level defaults (backgrounds, transitions, effects)
• Advanced mode: JSON editor textarea for direct schema editing

2. Per-Slide Configuration

Background:
• Per-slide background image (with deck-level fallback)
• Optimized for mobile outdoor viewing (bright sunlight)

Text Frames (overlay blocks):
• Multiple text frames per slide
• Shapes: bubble, drop, rectangle (extensible)
• Styling: background color/gradient, transparency, border, shadow

Motion Effects:
• Scroll effects per slide (e.g., floating bubbles)
• Slide transitions: parallax, zoom, pan, fade
• Inheritable defaults for new slides

3. Media Management

Videos:
• ~10-12 short videos per chapter, up to 2 minutes each
• Must support: with audio AND silent/captioned playback
• Turtle journey intros: 30-60 seconds each (6 chapters)
• Community voices: 45-60 seconds each (interview clips)

Images:
• High-quality photos optimized for mobile
• Infographics and educational illustrations
• Interactive maps (ecosystem connectivity – "Blue Highway")

Audio:
• Narration tracks (accessibility)
• Nature sound installations (optional)

Animation/AR:
• Animated turtle guide (recurring character)
• Augmented reality features (Phase 2)

4. Preview

• One-click preview renders chapter as visitors will see it
• Mobile viewport simulation (primary target)
• Outdoor/bright mode preview

5. Content Structure

Chapter model (based on "The Turtle's Tale" narrative):
• 6 ecosystem themes: Beaches → Rivers/Mangroves → Seagrass → Islands → Coral Reef → Ocean
• Each chapter follows: Introduction → Facts → Pressures → Heroes → Action

Per-location content:
• 6-10 minutes reading time per location
• 12+ years reading level
• Links to partner organizations and citizen science programs

6. User Features (Visitor-Facing)

• Digital "passport" – track progress through trail locations
• QR code scanning – unlock location-specific content
• Geo-positioning – auto-detect nearby trail locations
• Feedback surveys – post-visit evaluation integrated
• Social sharing – share progress, favorite locations
• Offline support – PWA, content cached for offline use
• Installable – add to home screen

7. Analytics & Monitoring

• QR code scan counts per location
• Web app usage (sessions, duration, pages)
• Survey responses (satisfaction, learning outcomes)
• Social media metrics
• Device/platform breakdown

───────────────────────────────────────────────────────────────────────────────

TECHNICAL REQUIREMENTS

───────────────────────────────────────────────────────────────────────────────

Performance
• Mobile-first design
• Optimized for outdoor viewing (high contrast, bright sunlight)
• Fast load times (cached assets, CDN)
• Offline-capable (service worker, PWA)

Accessibility
• Works with and without audio
• Captions on all video content
• Screen reader compatible
• Audio narration option

Integrations
• QR code generation per location
• Geolocation API for nearby content detection
• Analytics (GA4 or similar)
• Social sharing APIs
• Links to external partner sites (WCC, conservation groups)

Multi-language (Phase 2)
• Content localization support
• Language switcher

Seasonal Content
• Schedule content variations (whale migration, coral spawning, wet/dry seasons)
• Date-based content switching

───────────────────────────────────────────────────────────────────────────────

USER MANAGEMENT

───────────────────────────────────────────────────────────────────────────────

Roles
• Admin: manage users, delete any content, full access
• Editor: create/edit own content, disable (not delete) own content
• Viewer (public): read-only access to published content

Auth
• Sign up, login, password reset
• Email verification

───────────────────────────────────────────────────────────────────────────────

FRONTEND (Visitor Experience)

───────────────────────────────────────────────────────────────────────────────

• Parallax/scrollytelling rendering engine
• JSON schema-driven content
• Pre-cached assets for performance
• PWA manifest for installability
• Responsive design (mobile primary, tablet, desktop)

───────────────────────────────────────────────────────────────────────────────

IMPLEMENTATION ROADMAP

───────────────────────────────────────────────────────────────────────────────

Phase 1: Foundation
1. Setup environment (dev/live), Bitbucket repo, CI/CD pipeline
2. Agree on default visual theme (fonts, colors, spacing)
3. Build homepage with Whitsundays imagery + discrete login
4. User management (sign up, login, password reset, roles)

Phase 2: Editor Core
5. Content editor – grid view of all chapters
6. Slide deck editor with defaults
7. Media upload/management
8. Preview functionality

Phase 3: Visitor Experience
9. Parallax/scrollytelling frontend renderer
10. PWA + offline support
11. QR code integration
12. Geo-location features

Phase 4: Engagement
13. Passport/progress tracking
14. Feedback surveys
15. Social sharing
16. Analytics dashboard

Phase 5: Advanced
17. Augmented reality features
18. Multi-language support
19. Seasonal content scheduling

───────────────────────────────────────────────────────────────────────────────

TECHNOLOGY STACK (Suggested)

───────────────────────────────────────────────────────────────────────────────

Frontend:
• Framework: React or Vue (SPA)
• Scrollytelling: Scrollama, GSAP ScrollTrigger, or custom
• PWA: Vite PWA plugin, workbox

Backend:
• Node.js + Express or Fastify
• Database: PostgreSQL or MongoDB
• Storage: S3-compatible or local with CDN

Auth:
• JWT or OAuth2

Deployment:
• CI/CD: Bitbucket Pipelines
• Hosting: moonlight.zeh.me or cloud (Vercel, Netlify, AWS)

───────────────────────────────────────────────────────────────────────────────

OPEN QUESTIONS

───────────────────────────────────────────────────────────────────────────────

• Where to host? (moonlight server vs cloud)
• Multi-tenant or single-project?
• Video hosting strategy (self-host vs YouTube/Vimeo embed)
• AR framework choice (if pursuing AR features)
• Traditional Owner content – separate workflow?`;

  // Get current doc to find end
  const currentDoc = await docs.documents.get({ documentId: docId });
  const endIndex = currentDoc.data.body.content[currentDoc.data.body.content.length - 1].endIndex - 1;
  
  // Delete all then insert new
  await docs.documents.batchUpdate({
    documentId: docId,
    requestBody: {
      requests: [
        {
          deleteContentRange: {
            range: { startIndex: 1, endIndex: endIndex }
          }
        },
        {
          insertText: {
            location: { index: 1 },
            text: newContent
          }
        }
      ]
    }
  });
  
  console.log('Document updated successfully');
}

updateDoc().catch(console.error);
