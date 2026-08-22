import { useToastStore } from "../../stores/toastStore";

export function ToastRegion() {
  const toasts = useToastStore((state) => state.toasts);
  return (
    <div className="toast-region" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className="toast">
          {toast.message}
        </div>
      ))}
    </div>
  );
}
