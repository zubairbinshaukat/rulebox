import { n } from "../strings";

export const installStrings = {
  retry: "Retry",
  retried: "Retry requested. The PCs try again soon.",
  retryConfirmTitle: (app: string) => `Retry ${app} on every PC?`,
  retryConfirmBody: (app: string) => `This restarts the failed installs of ${app} on every PC that has it, not only this one.`,
  retryConfirmAction: "Retry on all PCs",
  retryUnavailable: "This app is archived or has no installer, so it can't be retried.",
  attempts: (count: number) => n(count, "attempt", "attempts"),
  exitCode: (code: number) => `Exit code ${code}`,
  details: {
    hash_mismatch: "The downloaded file didn't match its SHA-256. Check the URL and hash.",
    low_disk: "Not enough free disk space on the PC.",
    timeout: "The installer ran for more than 30 minutes and was stopped.",
    exe_missing_after_install: "The installer finished but the program wasn't found at its path.",
    download_failed: "The installer couldn't be downloaded.",
    exit_code: "The installer reported an error.",
  } as Record<string, string>,
  detailFallback: "The install failed.",
} as const;
