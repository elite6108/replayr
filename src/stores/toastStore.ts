import { create } from "zustand";

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface Toast {
  id: number;
  message: string;
  actions?: ToastAction[];
}

interface ToastState {
  toasts: Toast[];
  show: (message: string) => void;
  showSticky: (message: string, actions: ToastAction[]) => void;
  dismiss: (id: number) => void;
}

let nextId = 1;

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  show: (message) => {
    if (useToastStore.getState().toasts.some((toast) => toast.message === message)) return;
    const id = nextId++;
    set((state) => ({ toasts: [...state.toasts, { id, message }] }));
    window.setTimeout(() => {
      set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) }));
    }, 2800);
  },
  showSticky: (message, actions) => {
    const id = nextId++;
    set((state) => ({
      toasts: [
        ...state.toasts.filter((toast) => toast.actions == null),
        {
          id,
          message,
          actions: actions.map((action) => ({
            ...action,
            onClick: () => {
              action.onClick();
              useToastStore.getState().dismiss(id);
            },
          })),
        },
      ],
    }));
  },
  dismiss: (id) => set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) })),
}));
