import { formatTime } from "@/lib/utils";

/**
 * In-app timestamp: clicking seeks the Bilibili <video> in the current tab instead of opening
 * a new tab. Export still writes normal markdown links with shareable URLs.
 */
export function TimeLink({
  ms,
  onSeek,
  className = "timestamp",
  title,
}: {
  ms: number;
  onSeek: (ms: number) => void;
  className?: string;
  title?: string;
}) {
  return (
    <button
      type="button"
      className={className}
      title={title ?? `跳到 ${formatTime(ms)}`}
      data-time-ms={ms}
      onClick={() => onSeek(ms)}
    >
      {formatTime(ms)}
    </button>
  );
}
