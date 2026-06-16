"use client";

import React, { useState, useEffect } from "react";

interface ChatLayoutClientProps {
  chatSection: React.ReactNode;
  asideSection: React.ReactNode;
}

export default function ChatLayoutClient({
  chatSection,
  asideSection,
}: ChatLayoutClientProps) {
  const [showSidebar, setShowSidebar] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    const saved = localStorage.getItem("pm-chat-sidebar-visible");
    if (saved !== null) {
      setShowSidebar(saved === "true");
    }
  }, []);

  const toggleSidebar = () => {
    const next = !showSidebar;
    setShowSidebar(next);
    localStorage.setItem("pm-chat-sidebar-visible", String(next));
  };

  return (
    <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(0,1fr)_auto]">
      <div className="flex min-h-0 flex-1 flex-col relative">
        {chatSection}
        
        {/* Toggle Button placed inside the header section region */}
        {mounted && (
          <button
            onClick={toggleSidebar}
            className="absolute right-4 top-[14px] z-20 rounded-lg border border-line bg-panel p-1.5 text-text-muted hover:border-accent hover:text-accent transition-colors cursor-pointer"
            title={showSidebar ? "Hide Archive Sidebar" : "Show Archive Sidebar"}
          >
            {showSidebar ? (
              /* Collapse icon (layout-sidebar-inset-right) */
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" /><path d="M15 3v18" /><path d="m10 9 3 3-3 3" /></svg>
            ) : (
              /* Expand icon (layout-sidebar) */
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" /><path d="M15 3v18" /><path d="m11 15-3-3 3-3" /></svg>
            )}
          </button>
        )}
      </div>

      {showSidebar && (
        <div className="w-full lg:w-80 shrink-0 min-h-0 flex flex-col">
          {asideSection}
        </div>
      )}
    </div>
  );
}
