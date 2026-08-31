import { create } from "zustand";
import {
  acceptFolderInvite,
  addFolderClips,
  createFolder,
  createFolderInvite,
  deleteFolder,
  deleteFolderInvite,
  disableFolderPublicLink,
  enableFolderPublicLink,
  getFolder,
  leaveFolder,
  listFolderInvites,
  listFolderMembers,
  listFolders,
  listIncomingFolderInvites,
  listSharedFolders,
  playFolderClip,
  regenerateFolderPublicLink,
  removeFolderClip,
  removeFolderMember,
  transferFolderOwnership,
  updateFolder,
  updateFolderMemberRole,
  updateFolderPublicDownloads,
  createFolderEdit,
  deleteFolderEdit,
  duplicateFolderEdit,
  getFolderEdit,
  listFolderEdits,
  renderFolderEdit,
  updateFolderEdit,
} from "../services/api.folders";
import type {
  CreateFolderEditBody,
  CreateFolderInviteBody,
  Folder,
  FolderDetail,
  FolderEdit,
  FolderInvite,
  FolderMember,
  FolderMemberRole,
  FolderPermissions,
  FolderPublicShare,
  SocialUser,
  UpdateFolderEditBody,
} from "../services/social-types";
import { useAuthStore } from "./authStore";
import { useToastStore } from "./toastStore";

interface FolderShareState {
  owner: SocialUser | null;
  members: FolderMember[];
  invites: FolderInvite[];
  inviteRoles: FolderMemberRole[];
  permissions: FolderPermissions | null;
  publicShare: FolderPublicShare | null;
}

interface FolderState {
  folders: Folder[];
  sharedFolders: Folder[];
  incomingInvites: FolderInvite[];
  activeFolder: FolderDetail | null;
  share: FolderShareState;
  loading: boolean;
  detailLoading: boolean;
  shareLoading: boolean;
  error: string | null;
  initialize: () => Promise<void>;
  refresh: () => Promise<void>;
  open: (folderId: string) => Promise<void>;
  close: () => void;
  create: (name: string, description?: string) => Promise<FolderDetail | null>;
  rename: (folderId: string, name: string) => Promise<void>;
  updateDescription: (folderId: string, description: string | null) => Promise<void>;
  remove: (folderId: string) => Promise<void>;
  addClips: (folderId: string, clipIds: string[]) => Promise<void>;
  removeClip: (folderId: string, clipId: string) => Promise<void>;
  playClip: (folderId: string, clipId: string) => Promise<string | null>;
  loadShare: (folderId: string) => Promise<void>;
  invite: (folderId: string, payload: CreateFolderInviteBody) => Promise<boolean>;
  acceptInvite: (folderId: string, inviteId: string) => Promise<FolderDetail | null>;
  declineInvite: (folderId: string, inviteId: string) => Promise<void>;
  revokeInvite: (folderId: string, inviteId: string) => Promise<void>;
  changeRole: (folderId: string, userId: string, role: FolderMemberRole) => Promise<void>;
  removeMember: (folderId: string, userId: string) => Promise<void>;
  leave: (folderId: string) => Promise<boolean>;
  transferOwnership: (folderId: string, userId: string) => Promise<boolean>;
  enablePublicLink: (folderId: string) => Promise<void>;
  disablePublicLink: (folderId: string) => Promise<void>;
  regeneratePublicLink: (folderId: string) => Promise<void>;
  setPublicDownloads: (folderId: string, allowDownloads: boolean) => Promise<void>;
  editsByClip: Record<string, FolderEdit[]>;
  editsLoading: boolean;
  loadEdits: (folderId: string, clipId: string) => Promise<FolderEdit[]>;
  createEdit: (folderId: string, clipId: string, payload?: CreateFolderEditBody) => Promise<FolderEdit | null>;
  saveEdit: (folderId: string, clipId: string, editId: string, payload: UpdateFolderEditBody) => Promise<FolderEdit | null>;
  getEdit: (folderId: string, clipId: string, editId: string) => Promise<FolderEdit | null>;
  removeEdit: (folderId: string, clipId: string, editId: string) => Promise<void>;
  duplicateEdit: (folderId: string, clipId: string, editId: string) => Promise<FolderEdit | null>;
  attachRender: (folderId: string, clipId: string, editId: string, renderedClipId: string) => Promise<FolderEdit | null>;
}

const emptyShare = (): FolderShareState => ({
  owner: null,
  members: [],
  invites: [],
  inviteRoles: [],
  permissions: null,
  publicShare: null,
});

function token(): string | null {
  return useAuthStore.getState().session?.access_token ?? null;
}

export const useFolderStore = create<FolderState>((set, get) => ({
  folders: [],
  sharedFolders: [],
  incomingInvites: [],
  activeFolder: null,
  share: emptyShare(),
  loading: false,
  detailLoading: false,
  shareLoading: false,
  editsByClip: {},
  editsLoading: false,
  error: null,
  initialize: async () => {
    await get().refresh();
  },
  refresh: async () => {
    const access = token();
    if (!access) {
      set({
        folders: [],
        sharedFolders: [],
        incomingInvites: [],
        activeFolder: null,
        share: emptyShare(),
        loading: false,
        error: null,
      });
      return;
    }
    set({ loading: true, error: null });
    try {
      const [folders, sharedFolders, incomingInvites] = await Promise.all([
        listFolders(access),
        listSharedFolders(access),
        listIncomingFolderInvites(access),
      ]);
      set({ folders, sharedFolders, incomingInvites, loading: false, error: null });
    } catch (caught) {
      set({
        folders: [],
        sharedFolders: [],
        incomingInvites: [],
        loading: false,
        error: caught instanceof Error ? caught.message : "Could not load folders.",
      });
    }
  },
  open: async (folderId) => {
    const access = token();
    if (!access) {
      set({ activeFolder: null, error: "Sign in to open folders." });
      return;
    }
    set({ detailLoading: true, error: null });
    try {
      const activeFolder = await getFolder(access, folderId);
      set({ activeFolder, detailLoading: false, error: null });
    } catch (caught) {
      set({
        activeFolder: null,
        detailLoading: false,
        error: caught instanceof Error ? caught.message : "Could not load that folder.",
      });
    }
  },
  close: () => set({ activeFolder: null, share: emptyShare() }),
  create: async (name, description) => {
    const access = token();
    if (!access) {
      useToastStore.getState().show("Sign in to create a folder.");
      return null;
    }
    try {
      const folder = await createFolder(access, { name, description });
      set({
        folders: [folder, ...get().folders.filter((item) => item.id !== folder.id)],
        activeFolder: folder,
      });
      return folder;
    } catch (caught) {
      useToastStore.getState().show(caught instanceof Error ? caught.message : "Could not create that folder.");
      return null;
    }
  },
  rename: async (folderId, name) => {
    const access = token();
    if (!access) return;
    try {
      const folder = await updateFolder(access, folderId, { name });
      set({
        folders: get().folders.map((item) => (item.id === folderId ? { ...item, ...folder } : item)),
        activeFolder: get().activeFolder?.id === folderId ? folder : get().activeFolder,
      });
    } catch (caught) {
      useToastStore.getState().show(caught instanceof Error ? caught.message : "Could not rename that folder.");
    }
  },
  updateDescription: async (folderId, description) => {
    const access = token();
    if (!access) return;
    try {
      const folder = await updateFolder(access, folderId, { description });
      set({
        folders: get().folders.map((item) => (item.id === folderId ? { ...item, ...folder } : item)),
        activeFolder: get().activeFolder?.id === folderId ? folder : get().activeFolder,
      });
    } catch (caught) {
      useToastStore.getState().show(caught instanceof Error ? caught.message : "Could not update that folder.");
    }
  },
  remove: async (folderId) => {
    const access = token();
    if (!access) return;
    try {
      await deleteFolder(access, folderId);
      set({
        folders: get().folders.filter((item) => item.id !== folderId),
        activeFolder: get().activeFolder?.id === folderId ? null : get().activeFolder,
      });
    } catch (caught) {
      useToastStore.getState().show(caught instanceof Error ? caught.message : "Could not delete that folder.");
      throw caught;
    }
  },
  addClips: async (folderId, clipIds) => {
    const access = token();
    if (!access) return;
    try {
      const folder = await addFolderClips(access, folderId, { clipIds });
      set({
        folders: get().folders.map((item) => (item.id === folderId ? { ...item, ...folder } : item)),
        sharedFolders: get().sharedFolders.map((item) => (item.id === folderId ? { ...item, ...folder } : item)),
        activeFolder: get().activeFolder?.id === folderId ? folder : get().activeFolder,
      });
    } catch (caught) {
      useToastStore.getState().show(caught instanceof Error ? caught.message : "Could not add those clips.");
      throw caught;
    }
  },
  removeClip: async (folderId, clipId) => {
    const access = token();
    if (!access) return;
    try {
      await removeFolderClip(access, folderId, clipId);
      const current = get().activeFolder;
      if (current?.id === folderId) {
        const clips = current.clips.filter((clip) => clip.id !== clipId);
        const next = { ...current, clips, clipCount: clips.length, coverThumbnailUrl: clips[0]?.thumbnailUrl ?? null };
        set({
          activeFolder: next,
          folders: get().folders.map((item) =>
            item.id === folderId ? { ...item, clipCount: next.clipCount, coverThumbnailUrl: next.coverThumbnailUrl } : item,
          ),
          sharedFolders: get().sharedFolders.map((item) =>
            item.id === folderId ? { ...item, clipCount: next.clipCount, coverThumbnailUrl: next.coverThumbnailUrl } : item,
          ),
        });
      } else {
        await get().refresh();
      }
    } catch (caught) {
      useToastStore.getState().show(caught instanceof Error ? caught.message : "Could not remove that clip from the folder.");
    }
  },
  playClip: async (folderId, clipId) => {
    const access = token();
    if (!access) {
      useToastStore.getState().show("Sign in to play a clip.");
      return null;
    }
    try {
      return await playFolderClip(access, folderId, clipId);
    } catch (caught) {
      useToastStore.getState().show(caught instanceof Error ? caught.message : "Could not play that clip.");
      return null;
    }
  },
  loadShare: async (folderId) => {
    const access = token();
    if (!access) return;
    set({ shareLoading: true });
    try {
      const people = await listFolderMembers(access, folderId);
      const invites = people.permissions.manageMembers ? await listFolderInvites(access, folderId) : [];
      const current = get().activeFolder;
      const detail = current?.id === folderId ? current : await getFolder(access, folderId);
      set({
        share: {
          owner: people.owner,
          members: people.members,
          invites,
          inviteRoles: people.inviteRoles,
          permissions: people.permissions,
          publicShare: detail.publicShare ?? null,
        },
        shareLoading: false,
      });
    } catch (caught) {
      set({ shareLoading: false });
      useToastStore.getState().show(caught instanceof Error ? caught.message : "Could not load sharing.");
    }
  },
  invite: async (folderId, payload) => {
    const access = token();
    if (!access) return false;
    try {
      const result = await createFolderInvite(access, folderId, payload);
      if (result.alreadyMember) {
        useToastStore.getState().show("That person already has access.");
        await get().loadShare(folderId);
        return false;
      }
      if (result.invite) {
        set({
          share: {
            ...get().share,
            invites: [result.invite, ...get().share.invites.filter((item) => item.id !== result.invite?.id)],
          },
        });
      }
      useToastStore.getState().show("Invite sent.");
      return true;
    } catch (caught) {
      useToastStore.getState().show(caught instanceof Error ? caught.message : "Could not send that invite.");
      return false;
    }
  },
  acceptInvite: async (folderId, inviteId) => {
    const access = token();
    if (!access) return null;
    try {
      const folder = await acceptFolderInvite(access, folderId, inviteId);
      set({
        incomingInvites: get().incomingInvites.filter((item) => item.id !== inviteId),
        sharedFolders: [folder, ...get().sharedFolders.filter((item) => item.id !== folder.id)],
        activeFolder: folder,
      });
      return folder;
    } catch (caught) {
      useToastStore.getState().show(caught instanceof Error ? caught.message : "Could not accept that invite.");
      return null;
    }
  },
  declineInvite: async (folderId, inviteId) => {
    const access = token();
    if (!access) return;
    try {
      await deleteFolderInvite(access, folderId, inviteId);
      set({ incomingInvites: get().incomingInvites.filter((item) => item.id !== inviteId) });
    } catch (caught) {
      useToastStore.getState().show(caught instanceof Error ? caught.message : "Could not decline that invite.");
    }
  },
  revokeInvite: async (folderId, inviteId) => {
    const access = token();
    if (!access) return;
    try {
      await deleteFolderInvite(access, folderId, inviteId);
      set({ share: { ...get().share, invites: get().share.invites.filter((item) => item.id !== inviteId) } });
    } catch (caught) {
      useToastStore.getState().show(caught instanceof Error ? caught.message : "Could not revoke that invite.");
    }
  },
  changeRole: async (folderId, userId, role) => {
    const access = token();
    if (!access) return;
    try {
      const member = await updateFolderMemberRole(access, folderId, userId, { role });
      set({
        share: {
          ...get().share,
          members: get().share.members.map((item) => (item.user.id === userId ? member : item)),
        },
      });
    } catch (caught) {
      useToastStore.getState().show(caught instanceof Error ? caught.message : "Could not change that role.");
    }
  },
  removeMember: async (folderId, userId) => {
    const access = token();
    if (!access) return;
    try {
      await removeFolderMember(access, folderId, userId);
      set({
        share: {
          ...get().share,
          members: get().share.members.filter((item) => item.user.id !== userId),
        },
      });
    } catch (caught) {
      useToastStore.getState().show(caught instanceof Error ? caught.message : "Could not remove that person.");
    }
  },
  leave: async (folderId) => {
    const access = token();
    if (!access) return false;
    try {
      await leaveFolder(access, folderId);
      set({
        sharedFolders: get().sharedFolders.filter((item) => item.id !== folderId),
        activeFolder: get().activeFolder?.id === folderId ? null : get().activeFolder,
        share: emptyShare(),
      });
      return true;
    } catch (caught) {
      useToastStore.getState().show(caught instanceof Error ? caught.message : "Could not leave that folder.");
      return false;
    }
  },
  transferOwnership: async (folderId, userId) => {
    const access = token();
    if (!access) return false;
    try {
      const folder = await transferFolderOwnership(access, folderId, { userId });
      set({
        folders: get().folders.filter((item) => item.id !== folderId),
        sharedFolders: [folder, ...get().sharedFolders.filter((item) => item.id !== folderId)],
        activeFolder: get().activeFolder?.id === folderId ? folder : get().activeFolder,
      });
      await get().loadShare(folderId);
      useToastStore.getState().show("Ownership transferred. You are now a Manager.");
      return true;
    } catch (caught) {
      useToastStore.getState().show(caught instanceof Error ? caught.message : "Could not transfer ownership.");
      return false;
    }
  },
  enablePublicLink: async (folderId) => {
    const access = token();
    if (!access) return;
    try {
      applyPublicShare(get, set, folderId, await enableFolderPublicLink(access, folderId));
      useToastStore.getState().show("Public link enabled.");
    } catch (caught) {
      useToastStore.getState().show(caught instanceof Error ? caught.message : "Could not enable the public link.");
    }
  },
  disablePublicLink: async (folderId) => {
    const access = token();
    if (!access) return;
    try {
      applyPublicShare(get, set, folderId, await disableFolderPublicLink(access, folderId));
      useToastStore.getState().show("Public link disabled.");
    } catch (caught) {
      useToastStore.getState().show(caught instanceof Error ? caught.message : "Could not disable the public link.");
    }
  },
  regeneratePublicLink: async (folderId) => {
    const access = token();
    if (!access) return;
    try {
      applyPublicShare(get, set, folderId, await regenerateFolderPublicLink(access, folderId));
      useToastStore.getState().show("Public link regenerated.");
    } catch (caught) {
      useToastStore.getState().show(caught instanceof Error ? caught.message : "Could not regenerate that link.");
    }
  },
  loadEdits: async (folderId, clipId) => {
    const access = token();
    if (!access) return [];
    set({ editsLoading: true });
    try {
      const edits = await listFolderEdits(access, folderId, clipId);
      set({
        editsByClip: { ...get().editsByClip, [clipId]: edits },
        editsLoading: false,
      });
      return edits;
    } catch (caught) {
      set({ editsLoading: false });
      useToastStore.getState().show(caught instanceof Error ? caught.message : "Could not load folder edits.");
      return [];
    }
  },
  createEdit: async (folderId, clipId, payload) => {
    const access = token();
    if (!access) return null;
    try {
      const edit = await createFolderEdit(access, folderId, clipId, payload);
      set({
        editsByClip: {
          ...get().editsByClip,
          [clipId]: [edit, ...(get().editsByClip[clipId] ?? []).filter((item) => item.id !== edit.id)],
        },
      });
      return edit;
    } catch (caught) {
      useToastStore.getState().show(caught instanceof Error ? caught.message : "Could not create that edit.");
      return null;
    }
  },
  saveEdit: async (folderId, clipId, editId, payload) => {
    const access = token();
    if (!access) return null;
    try {
      const edit = await updateFolderEdit(access, folderId, clipId, editId, payload);
      set({
        editsByClip: {
          ...get().editsByClip,
          [clipId]: (get().editsByClip[clipId] ?? []).map((item) => (item.id === editId ? edit : item)),
        },
      });
      return edit;
    } catch (caught) {
      useToastStore.getState().show(caught instanceof Error ? caught.message : "Could not save that edit.");
      return null;
    }
  },
  getEdit: async (folderId, clipId, editId) => {
    const access = token();
    if (!access) return null;
    try {
      return await getFolderEdit(access, folderId, clipId, editId);
    } catch (caught) {
      useToastStore.getState().show(caught instanceof Error ? caught.message : "Could not load that edit.");
      return null;
    }
  },
  removeEdit: async (folderId, clipId, editId) => {
    const access = token();
    if (!access) return;
    try {
      await deleteFolderEdit(access, folderId, clipId, editId);
      set({
        editsByClip: {
          ...get().editsByClip,
          [clipId]: (get().editsByClip[clipId] ?? []).filter((item) => item.id !== editId),
        },
      });
    } catch (caught) {
      useToastStore.getState().show(caught instanceof Error ? caught.message : "Could not delete that edit.");
    }
  },
  duplicateEdit: async (folderId, clipId, editId) => {
    const access = token();
    if (!access) return null;
    try {
      const edit = await duplicateFolderEdit(access, folderId, clipId, editId);
      set({
        editsByClip: {
          ...get().editsByClip,
          [clipId]: [edit, ...(get().editsByClip[clipId] ?? [])],
        },
      });
      return edit;
    } catch (caught) {
      useToastStore.getState().show(caught instanceof Error ? caught.message : "Could not duplicate that edit.");
      return null;
    }
  },
  attachRender: async (folderId, clipId, editId, renderedClipId) => {
    const access = token();
    if (!access) return null;
    try {
      const edit = await renderFolderEdit(access, folderId, clipId, editId, { clipId: renderedClipId });
      set({
        editsByClip: {
          ...get().editsByClip,
          [clipId]: (get().editsByClip[clipId] ?? []).map((item) => (item.id === editId ? edit : item)),
        },
      });
      await get().open(folderId);
      return edit;
    } catch (caught) {
      useToastStore.getState().show(caught instanceof Error ? caught.message : "Could not save that rendered copy.");
      return null;
    }
  },
  setPublicDownloads: async (folderId, allowDownloads) => {
    const access = token();
    if (!access) return;
    try {
      applyPublicShare(get, set, folderId, await updateFolderPublicDownloads(access, folderId, allowDownloads));
    } catch (caught) {
      useToastStore.getState().show(caught instanceof Error ? caught.message : "Could not update download access.");
    }
  },
}));

function applyPublicShare(
  get: () => FolderState,
  set: (partial: Partial<FolderState>) => void,
  folderId: string,
  publicShare: FolderPublicShare,
) {
  const visibility = publicShare.enabled ? "public_link" : "private";
  const patchFolder = <T extends Folder>(item: T): T =>
    item.id === folderId ? { ...item, visibility, publicShare } : item;
  const active = get().activeFolder;
  set({
    folders: get().folders.map(patchFolder),
    sharedFolders: get().sharedFolders.map(patchFolder),
    activeFolder: active?.id === folderId ? { ...active, visibility, publicShare } : active,
    share: { ...get().share, publicShare },
  });
}
