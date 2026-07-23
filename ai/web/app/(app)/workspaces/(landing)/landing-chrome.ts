// Chrome-slot scope shared by the landing layout (which renders the slot
// elements) and the landing page board (which portals its summary/controls
// into them). Kept out of layout.tsx because route files may only export
// their default component plus Next.js config fields.
export const LANDING_CHROME_SCOPE = "workspaces-all";
