import { create } from "zustand";
import type { FolderEditDocument, FolderPermissions } from "../services/social-types";

export type FolderEditorContext = {
  kind: "folderEdit";
  folderId: string;
  folderName: string;
  sourceClipId: string;
  sourceTitle: string;
  editId: string;
  editName: string;
  revision: number;
  permissions: FolderPermissions;
  playbackUrl: string;
  localId: string | null;
  editData: FolderEditDocument;
};

export type EditorContext = { kind: "personal" } | FolderEditorContext;

interface EditorContextState {
  context: EditorContext;
  setPersonal: () => void;
  setFolderEdit: (context: FolderEditorContext) => void;
  patchFolderEdit: (patch: Partial<Omit<FolderEditorContext, "kind">>) => void;
}

export const useEditorContextStore = create<EditorContextState>((set, get) => ({
  context: { kind: "personal" },
  setPersonal: () => set({ context: { kind: "personal" } }),
  setFolderEdit: (context) => set({ context }),
  patchFolderEdit: (patch) => {
    const current = get().context;
    if (current.kind !== "folderEdit") return;
    set({ context: { ...current, ...patch } });
  },
}));
