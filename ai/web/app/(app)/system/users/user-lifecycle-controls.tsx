"use client";

import { useActionState, useEffect, useRef } from "react";
import {
  removeHumanUser,
  setHumanUserStatus,
  updateHumanPassword,
  type UserManagementActionState,
} from "@/lib/users/actions";
import type { UserRemovalBlocker } from "@/lib/users/removal";

const INITIAL_STATE: UserManagementActionState = {
  ok: false,
  error: null,
  message: null,
};

export default function UserLifecycleControls({
  userId,
  username,
  status,
  protectedAccount,
  removable,
  removalBlockers,
}: {
  userId: string;
  username: string;
  status: string;
  protectedAccount: boolean;
  removable: boolean;
  removalBlockers: UserRemovalBlocker[];
}) {
  const passwordFormRef = useRef<HTMLFormElement>(null);
  const [passwordState, passwordAction, passwordPending] = useActionState(updateHumanPassword, INITIAL_STATE);
  const [statusState, statusAction, statusPending] = useActionState(setHumanUserStatus, INITIAL_STATE);
  const [removeState, removeAction, removePending] = useActionState(removeHumanUser, INITIAL_STATE);
  const isDeactivated = status === "deactivated";
  const statusActionName = isDeactivated ? "activate" : "deactivate";
  const statusButtonLabel = isDeactivated ? "Enable account" : "Disable account";
  const removalReason = protectedAccount
    ? "The Mission Control owner cannot be removed."
    : removalBlockers.length > 0
      ? `Removal is unavailable because this account has ${describeBlockers(removalBlockers)}.`
      : "";

  useEffect(() => {
    if (passwordState.ok) passwordFormRef.current?.reset();
  }, [passwordState.ok]);

  return (
    <section className="mt-5 border-t border-line pt-5" aria-label={`Account controls for @${username}`}>
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)]">
        <form ref={passwordFormRef} action={passwordAction} className="space-y-3">
          <input type="hidden" name="userId" value={userId} />
          <div>
            <h4 className="text-body font-semibold">Set password</h4>
            <p className="mt-1 text-caption text-text-muted">
              Sets a temporary password and requires the user to choose a new one after sign-in.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block space-y-1">
              <span className="block text-nano font-semibold uppercase tracking-wider text-text-muted">Temporary password</span>
              <input
                name="password"
                type="password"
                minLength={12}
                maxLength={256}
                required
                autoComplete="new-password"
                disabled={passwordPending}
                className={inputClass}
              />
            </label>
            <label className="block space-y-1">
              <span className="block text-nano font-semibold uppercase tracking-wider text-text-muted">Confirm password</span>
              <input
                name="passwordConfirmation"
                type="password"
                minLength={12}
                maxLength={256}
                required
                autoComplete="new-password"
                disabled={passwordPending}
                className={inputClass}
              />
            </label>
          </div>
          <ActionMessage state={passwordState} />
          <button
            type="submit"
            disabled={passwordPending}
            className="rounded-lg border border-line bg-bg px-control-x py-control-y text-body font-medium hover:border-accent hover:text-accent disabled:cursor-wait disabled:opacity-50"
          >
            {passwordPending ? "Updating password..." : "Update password"}
          </button>
        </form>

        <div className="space-y-4 border-t border-line pt-5 xl:border-l xl:border-t-0 xl:pl-5 xl:pt-0">
          <div>
            <h4 className="text-body font-semibold">Account access</h4>
            <p className="mt-1 text-caption text-text-muted">
              Disabled accounts cannot sign in. Password reset links are invalidated when an account is disabled.
            </p>
          </div>
          {protectedAccount ? (
            <p className="rounded-lg border border-line bg-panel-soft px-3 py-2 text-caption text-text-muted">
              The Mission Control owner cannot be disabled or removed.
            </p>
          ) : (
            <form action={statusAction} className="space-y-3">
              <input type="hidden" name="userId" value={userId} />
              <input type="hidden" name="accountAction" value={statusActionName} />
              <ActionMessage state={statusState} />
              <button
                type="submit"
                disabled={statusPending}
                className={`rounded-lg border px-control-x py-control-y text-body font-medium disabled:cursor-wait disabled:opacity-50 ${
                  isDeactivated
                    ? "border-ok/50 bg-ok/10 text-ok hover:border-ok"
                    : "border-amber-500/50 bg-amber-500/10 text-amber-700 hover:border-amber-500"
                }`}
              >
                {statusPending ? "Updating account..." : statusButtonLabel}
              </button>
            </form>
          )}

          <div className="border-t border-line pt-4">
            <h4 className="text-body font-semibold text-crit">Remove account</h4>
            <p className="mt-1 text-caption text-text-muted">
              Removal is permanent and only available while the account has no work, review, management, or conversation history.
            </p>
            {removalReason ? (
              <p className="mt-2 rounded-lg border border-line bg-panel-soft px-3 py-2 text-caption text-text-muted">
                {removalReason}
              </p>
            ) : null}
            <form
              action={removeAction}
              className="mt-3 space-y-3"
              onSubmit={(event) => {
                if (!removable || protectedAccount) return;
                if (!window.confirm(`Remove @${username}? This cannot be undone.`)) event.preventDefault();
              }}
            >
              <input type="hidden" name="userId" value={userId} />
              <ActionMessage state={removeState} />
              <button
                type="submit"
                disabled={!removable || protectedAccount || removePending}
                title={removalReason || "Remove this history-free account"}
                className="rounded-lg border border-crit/50 bg-crit/10 px-control-x py-control-y text-body font-medium text-crit hover:border-crit disabled:cursor-not-allowed disabled:opacity-45"
              >
                {removePending ? "Removing account..." : "Remove account"}
              </button>
            </form>
          </div>
        </div>
      </div>
    </section>
  );
}

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

function describeBlockers(blockers: UserRemovalBlocker[]): string {
  const visible = blockers.slice(0, 3).map(({ count, label }) => `${count} ${label}`);
  return blockers.length > visible.length ? `${visible.join(", ")}, and more history` : visible.join(", ");
}

const inputClass = "w-full rounded-lg border border-line bg-bg px-control-x py-control-y text-body outline-none focus:border-accent disabled:cursor-wait disabled:opacity-50";
