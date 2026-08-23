import { useToastStore } from "../../stores/toastStore";

export function ToastRegion() {
  const toasts = useToastStore((state) => state.toasts);
  return (
    <div className="toast-region" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className="toast">
          <div>{toast.message}</div>
          {toast.actions?.length ? (
            <div className="toast-actions">
              {toast.actions.map((action) => (
                <button key={action.label} type="button" className="btn" onClick={action.onClick}>
                  {action.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}
