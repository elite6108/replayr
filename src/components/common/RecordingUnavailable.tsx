export function UnavailableControl({ label }: { label: string }) {
  return (
    <button type="button" className="btn" disabled title="This control arrives in a later phase">
      {label}
    </button>
  );
}
