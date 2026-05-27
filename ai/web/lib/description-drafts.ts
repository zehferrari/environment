import fs from "node:fs";
import path from "node:path";

let draftsDir = path.join(process.cwd(), ".data", "drafts");
if (process.cwd().includes(".next")) {
  draftsDir = path.join(process.cwd().split(".next")[0], ".data", "drafts");
}

function ensureDir() {
  if (!fs.existsSync(draftsDir)) {
    fs.mkdirSync(draftsDir, { recursive: true });
  }
}

export function saveDescriptionDraft(id: string, scope: "task" | "epic", content: string) {
  ensureDir();
  const filePath = path.join(draftsDir, `${scope}-${id}.txt`);
  fs.writeFileSync(filePath, content, "utf8");
}

export function getDescriptionDraft(id: string, scope: "task" | "epic"): string | null {
  const filePath = path.join(draftsDir, `${scope}-${id}.txt`);
  if (fs.existsSync(filePath)) {
    return fs.readFileSync(filePath, "utf8");
  }
  return null;
}

export function deleteDescriptionDraft(id: string, scope: "task" | "epic") {
  const filePath = path.join(draftsDir, `${scope}-${id}.txt`);
  if (fs.existsSync(filePath)) {
    try {
      fs.unlinkSync(filePath);
    } catch (e) {
      console.error(`Failed to delete draft file ${filePath}:`, e);
    }
  }
}
