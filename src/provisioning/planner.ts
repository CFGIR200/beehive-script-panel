/**
 * Job planner: turns a requested operation into an ordered, named step list.
 *
 * The plan is persisted as `deployment_steps` rows at job creation, so a job's
 * shape is immutable once started — exactly what resumability needs.
 */

import type { JobKind } from "../database/repositories/jobs";

export interface PlanStep {
  name: string;
  /** Which job status the step belongs to (drives progress labels in the UI). */
  phase: "validating" | "provisioning" | "configuring" | "deploying" | "verifying";
}

export interface Plan {
  kind: JobKind;
  steps: PlanStep[];
}

export function planFor(kind: JobKind): Plan {
  switch (kind) {
    case "install":
      return {
        kind,
        steps: [
          { name: "validate_account", phase: "validating" },
          { name: "ensure_subdomain", phase: "provisioning" },
          { name: "create_database", phase: "provisioning" },
          { name: "upload_worker", phase: "deploying" },
          { name: "enable_workers_dev", phase: "configuring" },
          { name: "configure_schedule", phase: "configuring" },
          { name: "verify_endpoint", phase: "verifying" },
          { name: "finalize", phase: "verifying" },
        ],
      };
    case "update":
    case "redeploy":
      return {
        kind,
        steps: [
          { name: "validate_account", phase: "validating" },
          { name: "ensure_subdomain", phase: "provisioning" },
          { name: "upload_worker", phase: "deploying" },
          { name: "verify_endpoint", phase: "verifying" },
          { name: "finalize", phase: "verifying" },
        ],
      };
    case "delete":
      return {
        kind,
        steps: [
          { name: "preflight", phase: "validating" },
          { name: "delete_worker", phase: "deploying" },
          { name: "delete_database", phase: "deploying" },
          { name: "mark_deleted", phase: "verifying" },
        ],
      };
    case "backup":
      return {
        kind,
        steps: [
          { name: "preflight", phase: "validating" },
          { name: "export_database", phase: "provisioning" },
          { name: "store_backup", phase: "configuring" },
        ],
      };
    case "restore":
      return {
        kind,
        steps: [
          { name: "preflight", phase: "validating" },
          { name: "restore_database", phase: "provisioning" },
          { name: "verify_endpoint", phase: "verifying" },
        ],
      };
    case "health":
      return { kind, steps: [{ name: "health_check", phase: "verifying" }] };
    default:
      return { kind, steps: [] };
  }
}

export function stepNames(kind: JobKind): string[] {
  return planFor(kind).steps.map((step) => step.name);
}

/** Steps that mutate the customer account and therefore need rollback on failure. */
export const MUTATING_STEPS = new Set([
  "create_database",
  "upload_worker",
  "enable_workers_dev",
  "configure_schedule",
  "restore_database",
]);

/** For each step, the steps that must be undone (in reverse order) if it fails. */
export function rollbackPlanFor(kind: JobKind, failedStep: string): string[] {
  if (kind === "install") {
    if (["upload_worker", "enable_workers_dev", "configure_schedule", "verify_endpoint", "finalize"].includes(failedStep)) {
      return ["delete_worker", "delete_database"];
    }
    if (failedStep === "create_database") return ["delete_database"];
    return [];
  }
  return [];
}
