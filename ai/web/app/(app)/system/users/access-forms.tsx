"use client";

// ENV-164 — combined role + project-access invitation/edit flow. Role
// selection and project grants live in ONE form per user. The server
// (lib/users/access-management.ts) still makes every decision; this UI only
// explains, confirms, and submits. High-impact changes (role change or any
// revocation) require an explicit confirmation summary before submit.

import React, { useActionState, useState } from "react";
import {
  inviteHumanUser,
  updateHumanProjectAccess,
  type UserManagementActionState,
} from "@/lib/users/actions";

const INITIAL_STATE: UserManagementActionState = {
  ok: false,
  error: null,
  message: null,
};

export type ProjectOption = {
  id: string;
  name: string;
  slug: string;
  archivedAt: Date | string | null;
};

const ROLE_COPY: Record<"admin" | "customer", string> = {
  admin:
    "Admins manage Customers and project access inside their own projects. They cannot change roles, edit other Admins, or manage the Owner.",
  customer:
    "Customers see only the projects they are granted and the work inside them. Roles and access are managed by the Owner or an Admin.",
};

const inputClass =
  "w-full rounded-lg border border-line bg-bg px-control-x py-control-y text-body outline-none focus:border-accent disabled:cursor-wait disabled:opacity-50";

function ActionMessage({ state }: { state: UserManagementActionState }) {
  if (state.error) {
    return (
      <p role="alert" className="rounded-lg border border-crit/40 bg-crit/10 px-3 py-2 text-caption text-crit">
        {state.error}
      </p>
    );
  }
  if (state.ok && state.message) {
    return (
      <p aria-live="polite" className="rounded-lg border border-ok/40 bg-ok/10 px-3 py-2 text-caption text-ok">
        {state.message}
      </p>
    );
  }
  return null;
}

function InviteProjectGrid({ projects, disabled }: { projects: ProjectOption[]; disabled?: boolean }) {
  return (
    <fieldset>
      <legend className="text-nano font-semibold uppercase tracking-wider text-text-muted">Visible projects</legend>
      {projects.length === 0 ? (
        <p className="mt-2 text-caption text-text-muted">No projects are available.</p>
      ) : (
        <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((project) => (
            <label key={project.id} className="flex min-w-0 items-center gap-3 rounded-lg border border-line bg-bg px-3 py-2 text-body hover:border-accent">
              <input type="checkbox" name="projectId" value={project.id} defaultChecked={false} disabled={disabled} className="h-4 w-4 shrink-0 accent-accent" />
              <span className="min-w-0">
                <span className="block truncate font-medium">{project.name}</span>
                <span className="block truncate text-caption text-text-muted">/{project.slug}{project.archivedAt ? " · archived" : ""}</span>
              </span>
            </label>
          ))}
        </div>
      )}
    </fieldset>
  );
}

export default function InviteUsersForm({
  projects,
  canAssignRoles,
}: {
  projects: ProjectOption[];
  canAssignRoles: boolean;
}) {
  const [state, action, pending] = useActionState(inviteHumanUser, INITIAL_STATE);
  return (
    <form action={action} className="space-y-5">
      <div className="grid gap-card md:grid-cols-3">
        <label className="block space-y-1">
          <span className="block text-nano font-semibold uppercase tracking-wider text-text-muted">Display name</span>
          <input name="name" maxLength={120} placeholder="Rachael Smith" disabled={pending} className={inputClass} />
        </label>
        <label className="block space-y-1">
          <span className="block text-nano font-semibold uppercase tracking-wider text-text-muted">Username</span>
          <input name="username" minLength={3} maxLength={64} pattern="[a-z0-9][a-z0-9._-]{1,62}[a-z0-9]" required placeholder="rachael" autoComplete="off" disabled={pending} className={inputClass} />
        </label>
        <label className="block space-y-1">
          <span className="block text-nano font-semibold uppercase tracking-wider text-text-muted">Email</span>
          <input name="email" type="email" maxLength={254} required placeholder="rachael@example.com" autoComplete="off" disabled={pending} className={inputClass} />
        </label>
      </div>
      {canAssignRoles ? (
        <fieldset className="space-y-2">
          <legend className="text-nano font-semibold uppercase tracking-wider text-text-muted">Starting role</legend>
          <div className="flex flex-wrap gap-4">
            <label className="flex items-center gap-2 text-body">
              <input type="radio" name="role" value="customer" defaultChecked disabled={pending} className="h-4 w-4 accent-accent" />
              <span className="font-medium">Customer</span>
            </label>
            <label className="flex items-center gap-2 text-body">
              <input type="radio" name="role" value="admin" disabled={pending} className="h-4 w-4 accent-accent" />
              <span className="font-medium">Admin</span>
            </label>
          </div>
          <p className="text-caption text-text-muted">Customer: {ROLE_COPY.customer}</p>
          <p className="text-caption text-text-muted">Admin: {ROLE_COPY.admin}</p>
        </fieldset>
      ) : (
        <div className="rounded-lg border border-dashed border-line px-4 py-3 text-caption text-text-muted">
          New users join as <span className="font-semibold">Customers</span> with access to the projects you pick. Only the Mission Control owner can grant the Admin role.
        </div>
      )}
      <InviteProjectGrid projects={projects} disabled={pending} />
      <ActionMessage state={state} />
      <div className="flex justify-end">
        <button type="submit" disabled={pending} className="rounded-lg bg-accent px-control-x py-control-y text-body font-semibold text-bg shadow-sm hover:opacity-90 disabled:cursor-wait disabled:opacity-50">
          {pending ? "Creating invitation..." : "Create invitation"}
        </button>
      </div>
    </form>
  );
}

export function AccessChangeSummary({
  username,
  role,
  addedProjectNames,
  removedProjectNames,
}: {
  username: string;
  role: { from: string; to: string } | null;
  addedProjectNames: string[];
  removedProjectNames: string[];
}) {
  return (
    <div role="alert" className="rounded-lg border border-amber-500/50 bg-amber-500/10 px-4 py-3">
      <h4 className="text-body font-semibold text-amber-700">Confirm this high-impact change for @{username}</h4>
      <ul className="mt-2 space-y-1 text-caption text-text-muted">
        {role ? (
          <li>
            Role: <span className="font-semibold">{role.from} → {role.to}</span>
          </li>
        ) : null}
        {removedProjectNames.length > 0 ? (
          <li>
            Revokes access to: <span className="font-semibold">{removedProjectNames.join(", ")}</span>
          </li>
        ) : null}
        {addedProjectNames.length > 0 ? (
          <li>
            Grants access to: <span className="font-semibold">{addedProjectNames.join(", ")}</span>
          </li>
        ) : null}
      </ul>
      <p className="mt-2 text-caption text-text-muted">Check the summary, then confirm to apply.</p>
    </div>
  );
}

export function EditAccessForm({
  user,
  projects,
  canAssignRoles,
}: {
  user: {
    id: string;
    username: string;
    displayName: string | null;
    role: "admin" | "customer";
    projectIds: string[];
  };
  projects: ProjectOption[];
  canAssignRoles: boolean;
}) {
  const [state, action, pending] = useActionState(updateHumanProjectAccess, INITIAL_STATE);
  const [selectedProjectIds, setSelectedProjectIds] = useState<string[]>(user.projectIds);
  const [selectedRole, setSelectedRole] = useState<"admin" | "customer">(user.role);
  const [confirming, setConfirming] = useState(false);

  const addedProjectIds = selectedProjectIds.filter((id) => !user.projectIds.includes(id));
  const removedProjectIds = user.projectIds.filter((id) => !selectedProjectIds.includes(id));
  const roleChanges = canAssignRoles && selectedRole !== user.role;
  const highImpact = roleChanges || removedProjectIds.length > 0;
  const projectName = (projectId: string) => projects.find((project) => project.id === projectId)?.name ?? projectId;

  function toggleProject(projectId: string, checked: boolean) {
    setSelectedProjectIds((previous) =>
      checked ? [...previous, projectId] : previous.filter((id) => id !== projectId),
    );
  }

  return (
    <form
      action={action}
      className="space-y-3"
      onSubmit={(event) => {
        if (highImpact && !confirming) {
          event.preventDefault();
          setConfirming(true);
        } else {
          setConfirming(false);
        }
      }}
    >
      <input type="hidden" name="userId" value={user.id} />
      {canAssignRoles ? (
        <fieldset className="space-y-2">
          <legend className="text-nano font-semibold uppercase tracking-wider text-text-muted">Role</legend>
          <div className="flex flex-wrap gap-4">
            <label className="flex items-center gap-2 text-body">
              <input
                type="radio"
                name="role"
                value="customer"
                checked={selectedRole === "customer"}
                onChange={() => setSelectedRole("customer")}
                disabled={pending}
                className="h-4 w-4 accent-accent"
              />
              <span className="font-medium">Customer</span>
            </label>
            <label className="flex items-center gap-2 text-body">
              <input
                type="radio"
                name="role"
                value="admin"
                checked={selectedRole === "admin"}
                onChange={() => setSelectedRole("admin")}
                disabled={pending}
                className="h-4 w-4 accent-accent"
              />
              <span className="font-medium">Admin</span>
            </label>
          </div>
          <p className="text-caption text-text-muted">{ROLE_COPY[selectedRole]}</p>
        </fieldset>
      ) : null}
      <fieldset>
        <legend className="text-nano font-semibold uppercase tracking-wider text-text-muted">Visible projects</legend>
        {projects.length === 0 ? (
          <p className="mt-2 text-caption text-text-muted">No projects are available.</p>
        ) : (
          <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {projects.map((project) => (
              <label key={project.id} className="flex min-w-0 items-center gap-3 rounded-lg border border-line bg-bg px-3 py-2 text-body hover:border-accent">
                <input
                  type="checkbox"
                  name="projectId"
                  value={project.id}
                  checked={selectedProjectIds.includes(project.id)}
                  onChange={(event) => toggleProject(project.id, event.target.checked)}
                  disabled={pending}
                  className="h-4 w-4 shrink-0 accent-accent"
                />
                <span className="min-w-0">
                  <span className="block truncate font-medium">{project.name}</span>
                  <span className="block truncate text-caption text-text-muted">/{project.slug}{project.archivedAt ? " · archived" : ""}</span>
                </span>
              </label>
            ))}
          </div>
        )}
      </fieldset>
      {highImpact && confirming ? (
        <AccessChangeSummary
          username={user.username}
          role={roleChanges ? { from: user.role, to: selectedRole } : null}
          addedProjectNames={addedProjectIds.map(projectName)}
          removedProjectNames={removedProjectIds.map(projectName)}
        />
      ) : null}
      <ActionMessage state={state} />
      <div className="flex justify-end gap-2">
        {highImpact && confirming ? (
          <>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="rounded-lg border border-line bg-bg px-control-x py-control-y text-body font-medium hover:border-accent hover:text-accent"
            >
              Cancel
            </button>
            <button type="submit" disabled={pending} className="rounded-lg bg-accent px-control-x py-control-y text-body font-semibold text-bg shadow-sm hover:opacity-90 disabled:cursor-wait disabled:opacity-50">
              {pending ? "Saving..." : "Confirm changes"}
            </button>
          </>
        ) : (
          <button type="submit" disabled={pending} className="rounded-lg border border-line bg-bg px-control-x py-control-y text-body font-medium hover:border-accent hover:text-accent disabled:cursor-wait disabled:opacity-50">
            {pending ? "Saving..." : "Save access"}
          </button>
        )}
      </div>
    </form>
  );
}
