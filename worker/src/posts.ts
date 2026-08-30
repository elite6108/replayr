import type { Env } from "./env";
import { HttpError, json } from "./http";
import { presentPublicClips, PUBLIC_CLIP_SELECT, requireUser, serviceRest, type PublicClipRow } from "./shared";
import { resolveUserProfileAccess, toSocialUser, type ProfileRow } from "./social";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type PostRow = {
  id: string;
  user_id: string;
  body: string;
  clip_id: string | null;
  created_at: string;
};

function pageLimit(url: URL) {
  const rawPage = Number(url.searchParams.get("page"));
  const rawLimit = Number(url.searchParams.get("limit"));
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? Math.floor(rawPage) : 1;
  const limit = Number.isFinite(rawLimit) && rawLimit >= 1 ? Math.min(48, Math.floor(rawLimit)) : 24;
  return { page, limit, offset: (page - 1) * limit };
}

export async function handlePosts(request: Request, env: Env, url: URL): Promise<Response | null> {
  const list = url.pathname.match(/^\/v1\/users\/([^/]+)\/posts$/);
  if (list?.[1] && request.method === "GET") return listUserPosts(request, env, url, list[1]);
  if (url.pathname === "/v1/posts" && request.method === "POST") return createPost(request, env);
  const remove = url.pathname.match(/^\/v1\/posts\/([^/]+)$/);
  if (remove?.[1] && request.method === "DELETE") return deletePost(request, env, remove[1]);
  return null;
}

export async function presentProfilePosts(
  request: Request,
  env: Env,
  profile: ProfileRow,
  page: number,
  limit: number,
) {
  const offset = (page - 1) * limit;
  const rows = await serviceRest<PostRow[]>(
    env,
    "GET",
    `/posts?user_id=eq.${profile.id}&select=id,user_id,body,clip_id,created_at&order=created_at.desc&limit=${limit}&offset=${offset}`,
  );
  const clipIds = [...new Set(rows.map((row) => row.clip_id).filter((id): id is string => Boolean(id)))];
  const clipRows = clipIds.length
    ? await serviceRest<PublicClipRow[]>(
        env,
        "GET",
        `/clips?id=in.(${clipIds.join(",")})&user_id=eq.${profile.id}&visibility=eq.public&status=eq.ready&${PUBLIC_CLIP_SELECT}`,
      )
    : [];
  const cards = await presentPublicClips(request, env, clipRows);
  const byId = new Map(cards.map((clip) => [clip.id, clip]));
  const author = toSocialUser(profile);
  return rows.map((row) => ({
    id: row.id,
    body: row.body,
    createdAt: row.created_at,
    clip: row.clip_id ? byId.get(row.clip_id) ?? null : null,
    author,
  }));
}

async function listUserPosts(request: Request, env: Env, url: URL, username: string): Promise<Response> {
  const access = await resolveUserProfileAccess(request, env, username);
  const { page, limit } = pageLimit(url);
  if (access.locked) return json({ posts: [], page, limit });
  const posts = await presentProfilePosts(request, env, access.profile, page, limit);
  return json({ posts, page, limit });
}

async function createPost(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  const body = (await request.json()) as { body?: string; clipId?: string };
  const text = typeof body.body === "string" ? body.body.trim() : "";
  if (text.length < 1 || text.length > 500) throw new HttpError(400, "Write a post between 1 and 500 characters.");
  let clipId: string | null = null;
  if (typeof body.clipId === "string" && body.clipId) {
    if (!UUID.test(body.clipId)) throw new HttpError(400, "That clip could not be attached.");
    const clips = await serviceRest<{ id: string }[]>(
      env,
      "GET",
      `/clips?id=eq.${body.clipId}&user_id=eq.${user.id}&visibility=eq.public&status=eq.ready&select=id`,
    );
    if (!clips[0]) throw new HttpError(400, "Attach one of your public ready clips.");
    clipId = clips[0].id;
  }
  const inserted = await serviceRest<PostRow[]>(
    env,
    "POST",
    "/posts?select=id,user_id,body,clip_id,created_at",
    { user_id: user.id, body: text, clip_id: clipId },
    "return=representation",
  );
  const row = inserted[0];
  if (!row) throw new HttpError(502, "Could not create that post.");
  const profiles = await serviceRest<ProfileRow[]>(
    env,
    "GET",
    `/profiles?id=eq.${user.id}&select=id,username,display_name,avatar_url,is_verified,bio,clip_count,created_at,is_private`,
  );
  const authorRow = profiles[0];
  if (!authorRow) throw new HttpError(502, "Could not load your profile.");
  const posts = await presentProfilePosts(request, env, authorRow, 1, 1);
  const created = posts.find((item) => item.id === row.id) ?? {
    id: row.id,
    body: row.body,
    createdAt: row.created_at,
    clip: null,
    author: toSocialUser(authorRow),
  };
  return json({ post: created });
}

async function deletePost(request: Request, env: Env, postId: string): Promise<Response> {
  const user = await requireUser(request, env);
  if (!UUID.test(postId)) throw new HttpError(404, "That post was not found.");
  const rows = await serviceRest<PostRow[]>(
    env,
    "GET",
    `/posts?id=eq.${postId}&user_id=eq.${user.id}&select=id,user_id,body,clip_id,created_at`,
  );
  if (!rows[0]) throw new HttpError(404, "That post was not found.");
  await serviceRest(env, "DELETE", `/posts?id=eq.${postId}&user_id=eq.${user.id}`);
  return json({ ok: true });
}
