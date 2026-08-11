-- Generalize the legacy one-blocker Task field into a many-prerequisite graph.
-- blocked_by remains in place for backwards compatibility. Graph-aware readers
-- consume the union of blocked_by and this table, so mutable legacy selections
-- are not copied into a second source that could become stale.
CREATE TABLE "task_dependencies" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "task_id" TEXT NOT NULL,
    "prerequisite_task_id" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "task_dependencies_task_id_fkey"
      FOREIGN KEY ("task_id") REFERENCES "Task" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "task_dependencies_prerequisite_task_id_fkey"
      FOREIGN KEY ("prerequisite_task_id") REFERENCES "Task" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "task_dependencies_task_id_prerequisite_task_id_key"
  ON "task_dependencies"("task_id", "prerequisite_task_id");
CREATE INDEX "task_dependencies_prerequisite_task_id_idx"
  ON "task_dependencies"("prerequisite_task_id");
