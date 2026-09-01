export function AnalyticsAvailabilityNotice({ message }: { message?: string | null }) {
  if (!message) return null;
  return <p className="analytics-notice">{message}</p>;
}
