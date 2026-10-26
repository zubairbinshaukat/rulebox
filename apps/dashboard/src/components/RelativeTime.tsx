import { formatDateTimeLong, formatRelative } from "../lib/format";
import { useNow } from "../lib/useNow";

/** "3 minutes ago" that keeps ticking, with the full date and time zone on hover. */
export function RelativeTime({ ms }: { ms: number }) {
  const now = useNow(30_000);
  return (
    <time dateTime={new Date(ms).toISOString()} title={formatDateTimeLong(ms)}>
      {formatRelative(ms, now)}
    </time>
  );
}
