// The SDK's outbound option builder does not infer workspace roots from cfg.
// Supply only roots resolved for this authenticated agent, never the input path.
export function createTaskMediaLoader({ cfg, agentId, getRoots, buildOptions, media }) {
  const roots = getRoots(cfg, agentId);
  const options = buildOptions({ mediaLocalRoots: roots, maxBytes: 10 * 1024 * 1024, optimizeImages: false });
  return async (url) => {
    try {
      return await media.loadWebMedia(url, options);
    } catch (error) {
      if (String(error?.message).includes("not under an allowed directory")) {
        throw new Error("PM evidence must be inside your configured agent workspace or OpenClaw media directory. Copy the deliverable there, then retry pm_attach_file; renaming a worktree directory does not grant access.");
      }
      throw error;
    }
  };
}
