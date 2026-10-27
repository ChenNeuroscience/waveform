import { X } from "lucide-react";

/** The error (or else notice) banner, dismissible. */
export function Notice({
  error,
  notice,
  onDismiss,
}: {
  error: string;
  notice: string;
  onDismiss: () => void;
}) {
  if (!error && !notice) {
    return null;
  }
  return (
    <div className={`desktop-notice ${error ? "error" : ""}`} role={error ? "alert" : "status"}>
      <span>{error || notice}</span>
      <button aria-label={error ? "Dismiss error" : "Dismiss notification"} onClick={onDismiss}>
        <X size={13} />
      </button>
    </div>
  );
}
