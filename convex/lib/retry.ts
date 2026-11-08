/**
 * A step that must happen after a non-transactional one (e.g. revoking the
 * other sessions after an action changed the password): run it, retry on an
 * error, and if every attempt fails hand it to the scheduler, which retries
 * internal errors on its own. Throws only when the scheduling itself fails.
 * `run` should be safe to repeat.
 */
export async function runOrSchedule(
  run: () => Promise<unknown>,
  schedule: () => Promise<unknown>,
  attempts = 3,
): Promise<"ran" | "scheduled"> {
  for (let i = 0; i < attempts; i++) {
    try {
      await run();
      return "ran";
    } catch {
      // try again, then fall back to the scheduler
    }
  }
  console.warn("runOrSchedule: step failed, scheduling it");
  await schedule();
  return "scheduled";
}
