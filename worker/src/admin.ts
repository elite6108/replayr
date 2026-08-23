import { AwsClient } from "aws4fetch";
import { listAdminErrors, openErrorCount, resolveAdminError } from "./errors";
import { ownedObjectKey, type Env } from "./index";
import { HttpError, json } from "./http";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLAN_SLUGS = new Set(["free", "pro", "pro_plus"]);
const CLIP_STATUSES = new Set(["uploading", "processing", "ready", "failed", "deleted"]);
const VISIBILITIES = new Set(["public", "unlisted", "private"]);
const APP_STATUSES = new Set(["pending", "approved", "rejected"]);

interface AdminActor {
  id: string;
  serviceKey: string;
}

interface AuthAdminUser {
  id: string;
  email?: string | null;
  created_at?: string | null;
  last_sign_in_at?: string | null;
  app_metadata?: { role?: unknown };
}

interface AdminAuthStats {
  users: number;
  active1d: number;
  active7d: number;
  active30d: number;
  storage_used_bytes: number;
}

interface ProfileRow {
  id: string;
  username: string | null;
  display_name: string | null;
  is_verified: boolean;
}

interface StorageRow {
  user_id: string;
  plan_id: string;
  storage_used_bytes: number;
  storage_limit_bytes: number;
  plans: { slug: string } | { slug: string }[] | null;
}

interface PlanRow {
  id: string;
  slug: string;
  storage_limit_bytes: number;
}

interface ClipRow {
  id: string;
  user_id: string;
  title: string | null;
  slug: string;
  status: string;
  visibility: string;
  duration_ms: number | null;
  file_size_bytes: number | null;
  created_at: string;
  storage_key: string | null;
  thumbnail_key: string | null;
  games: { name: string; slug: string } | { name: string; slug: string }[] | null;
}

interface ApplicationRow {
  id: string;
  user_id: string;
  display_name: string;
  channel_url: string;
  game: string | null;
  note: string | null;
  status: string;
  created_at: string;
  reviewed_at: string | null;
  review_note: string | null;
}

export async function handleAdmin(request: Request, env: Env, url: URL): Promise<Response> {
  const actor = await requireAdmin(request, env);
  const path = url.pathname;

  if (request.method === "GET" && path === "/v1/admin/overview") {
    return overview(env, actor);
  }
  if (request.method === "GET" && path === "/v1/admin/plans") {
    return listPlans(env, actor);
  }
  if (request.method === "GET" && path === "/v1/admin/users") {
    return listUsers(env, actor, url);
  }
  const userItem = path.match(/^\/v1\/admin\/users\/([^/]+)$/);
  if (request.method === "PATCH" && userItem?.[1]) {
    return patchUser(request, env, actor, userItem[1]);
  }
  if (request.method === "GET" && path === "/v1/admin/clips") {
    return listClips(env, actor, url);
  }
  const clipItem = path.match(/^\/v1\/admin\/clips\/([^/]+)$/);
  if (request.method === "DELETE" && clipItem?.[1]) {
    return deleteClip(env, actor, clipItem[1]);
  }
  if (request.method === "GET" && path === "/v1/admin/storage") {
    return listStorage(env, actor);
  }
  if (request.method === "GET" && path === "/v1/admin/errors") {
    return listAdminErrors(env, actor.serviceKey, url);
  }
  const errorItem = path.match(/^\/v1\/admin\/errors\/([^/]+)$/);
  if (request.method === "PATCH" && errorItem?.[1]) {
    const payload = (await request.json().catch(() => ({}))) as { resolved?: unknown };
    return resolveAdminError(env, actor.serviceKey, errorItem[1], payload.resolved !== false);
  }
  if (request.method === "GET" && path === "/v1/admin/creators") {
    return listCreators(env, actor, url);
  }
  const review = path.match(/^\/v1\/admin\/creators\/([^/]+)\/review$/);
  if (request.method === "POST" && review?.[1]) {
    return reviewCreator(request, env, actor, review[1]);
  }

  throw new HttpError(404, "Not found.");
}

async function requireAdmin(request: Request, env: Env): Promise<AdminActor> {
  const header = request.headers.get("authorization") || "";
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7) : "";
  if (!token) throw new HttpError(401, "Sign in required.");

  const response = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: {
      authorization: `Bearer ${token}`,
      apikey: env.SUPABASE_ANON_KEY,
    },
  });
  if (!response.ok) throw new HttpError(401, "Session expired. Sign in again.");

  const user = (await response.json()) as {
    id?: string;
    app_metadata?: { role?: unknown };
  };
  if (!user.id) throw new HttpError(401, "Session expired. Sign in again.");
  if (user.app_metadata?.role !== "admin") {
    throw new HttpError(403, "Admin access required.");
  }
  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new HttpError(
      503,
      "Admin API is not configured. Add SUPABASE_SERVICE_ROLE_KEY to .env (not VITE_), then restart the Worker.",
    );
  }
  return { id: user.id, serviceKey: env.SUPABASE_SERVICE_ROLE_KEY };
}

async function overview(env: Env, actor: AdminActor): Promise<Response> {
  const startOfToday = new Date();
  startOfToday.setUTCHours(0, 0, 0, 0);

  const [statsRows, readyClips, clipsToday, pendingApps, errors] = await Promise.all([
    serviceRest<AdminAuthStats[]>(env, actor, "POST", "/rpc/admin_auth_stats", {}),
    restCount(env, actor, "/clips?status=eq.ready&select=id"),
    restCount(
      env,
      actor,
      `/clips?status=neq.deleted&created_at=gte.${startOfToday.toISOString()}&select=id`,
    ),
    restCount(env, actor, "/creator_applications?status=eq.pending&select=id"),
    openErrorCount(env, actor.serviceKey),
  ]);
  const stats = statsRows[0];

  return json({
    users: Number(stats?.users ?? 0),
    active1d: Number(stats?.active1d ?? 0),
    active7d: Number(stats?.active7d ?? 0),
    active30d: Number(stats?.active30d ?? 0),
    readyClips,
    clipsToday,
    storageUsedBytes: Number(stats?.storage_used_bytes ?? 0),
    pendingCreatorApps: pendingApps,
    openErrors: errors.open,
    errors24h: errors.last24h,
  });
}

async function listPlans(env: Env, actor: AdminActor): Promise<Response> {
  const plans = await serviceRest<PlanRow[]>(
    env,
    actor,
    "GET",
    "/plans?select=slug,storage_limit_bytes&order=storage_limit_bytes.asc",
  );
  return json({
    plans: plans.map((plan) => ({
      slug: plan.slug,
      storageLimitBytes: plan.storage_limit_bytes,
    })),
  });
}

async function listUsers(env: Env, actor: AdminActor, url: URL): Promise<Response> {
  const query = sanitizeSearch(url.searchParams.get("q") || "");
  const plan = (url.searchParams.get("plan") || "").trim();
  if (plan && !PLAN_SLUGS.has(plan)) throw new HttpError(400, "Unknown plan.");
  const { page, limit } = pagination(url);

  if (!query && !plan) {
    const [authPage, statsRows] = await Promise.all([
      listAuthUsersPage(env, actor, page, limit),
      serviceRest<AdminAuthStats[]>(env, actor, "POST", "/rpc/admin_auth_stats", {}),
    ]);
    const users = await hydrateUsers(env, actor, authPage.users);
    return json({
      users,
      total: Number(statsRows[0]?.users ?? authPage.users.length),
      page,
      limit,
    });
  }

  const candidateIds = await resolveUserSearchIds(env, actor, query, plan, page, limit);
  const fetchAll = candidateIds.length <= 200;
  const pageIds = fetchAll
    ? candidateIds
    : candidateIds.slice((page - 1) * limit, page * limit);
  const authUsers = await getAuthUsersByIds(env, actor, pageIds);
  let users = await hydrateUsers(env, actor, authUsers);
  if (plan) users = users.filter((row) => row.planSlug === plan);
  if (query) {
    const needle = query.toLowerCase();
    users = users.filter((row) =>
      [row.email, row.username, row.displayName, row.id]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle)),
    );
  }
  users.sort((a, b) => Date.parse(b.createdAt || "") - Date.parse(a.createdAt || ""));
  const total = fetchAll ? users.length : candidateIds.length;
  return json({
    users: fetchAll ? users.slice((page - 1) * limit, page * limit) : users,
    total,
    page,
    limit,
  });
}

async function patchUser(request: Request, env: Env, actor: AdminActor, userId: string): Promise<Response> {
  if (!UUID.test(userId)) throw new HttpError(400, "User id is invalid.");
  const body = (await request.json()) as { planSlug?: string; storageLimitBytes?: number };
  const storageRows = await serviceRest<StorageRow[]>(
    env,
    actor,
    "GET",
    `/user_storage?user_id=eq.${userId}&select=user_id,plan_id,storage_used_bytes,storage_limit_bytes,plans(slug)`,
  );
  const current = storageRows[0];
  if (!current) throw new HttpError(404, "That account has no storage row yet.");

  const patch: { plan_id?: string; storage_limit_bytes?: number; updated_at: string } = {
    updated_at: new Date().toISOString(),
  };

  if (body.planSlug) {
    if (!PLAN_SLUGS.has(body.planSlug)) throw new HttpError(400, "Unknown plan.");
    const plans = await serviceRest<PlanRow[]>(
      env,
      actor,
      "GET",
      `/plans?slug=eq.${encodeURIComponent(body.planSlug)}&select=id,slug,storage_limit_bytes`,
    );
    const plan = plans[0];
    if (!plan) throw new HttpError(400, "Unknown plan.");
    patch.plan_id = plan.id;
    patch.storage_limit_bytes = plan.storage_limit_bytes;
  }

  if (body.storageLimitBytes != null) {
    const limit = Number(body.storageLimitBytes);
    if (!Number.isFinite(limit) || limit < 0 || limit > 5 * 1024 ** 4) {
      throw new HttpError(400, "Storage limit is invalid.");
    }
    patch.storage_limit_bytes = Math.floor(limit);
  }

  if (!patch.plan_id && patch.storage_limit_bytes == null) {
    throw new HttpError(400, "Nothing to update.");
  }

  await serviceRest(env, actor, "PATCH", `/user_storage?user_id=eq.${userId}`, patch);
  return json({ userId, ok: true });
}

async function listClips(env: Env, actor: AdminActor, url: URL): Promise<Response> {
  const query = sanitizeSearch(url.searchParams.get("q") || "");
  const status = (url.searchParams.get("status") || "").trim();
  const visibility = (url.searchParams.get("visibility") || "").trim();
  const game = (url.searchParams.get("game") || "").trim();
  if (status && !CLIP_STATUSES.has(status)) throw new HttpError(400, "Unknown clip status.");
  if (visibility && !VISIBILITIES.has(visibility)) throw new HttpError(400, "Unknown visibility.");
  if (game && !/^[a-z0-9-]+$/i.test(game)) throw new HttpError(400, "Unknown game.");
  const { page, limit } = pagination(url);

  const filters = ["select=id,user_id,title,slug,status,visibility,duration_ms,file_size_bytes,created_at,games(name,slug)"];
  if (status) filters.push(`status=eq.${status}`);
  else filters.push("status=neq.deleted");
  if (visibility) filters.push(`visibility=eq.${visibility}`);
  if (game) {
    const games = await serviceRest<{ id: string }[]>(
      env,
      actor,
      "GET",
      `/games?slug=eq.${encodeURIComponent(game)}&select=id`,
    );
    if (!games[0]) return json({ clips: [], total: 0, page, limit });
    filters.push(`game_id=eq.${games[0].id}`);
  }

  if (query) {
    const or: string[] = [`title.ilike.*${query}*`, `slug.ilike.*${query}*`];
    const ids = await resolveClipOwnerSearchIds(env, actor, query, page, limit);
    if (ids.size) or.push(`user_id.in.(${[...ids].join(",")})`);
    filters.push(`or=(${or.join(",")})`);
  }

  const from = (page - 1) * limit;
  const { data, count } = await serviceRestPage<ClipRow[]>(
    env,
    actor,
    `/clips?${filters.join("&")}&order=created_at.desc`,
    from,
    from + limit - 1,
  );

  const ownerIds = [...new Set(data.map((row) => row.user_id))];
  const [profiles, authUsers] = await Promise.all([
    ownerIds.length
      ? serviceRest<ProfileRow[]>(
          env,
          actor,
          "GET",
          `/profiles?id=in.(${ownerIds.join(",")})&select=id,username,display_name,is_verified`,
        )
      : Promise.resolve([] as ProfileRow[]),
    getAuthUsersByIds(env, actor, ownerIds),
  ]);
  const profileById = new Map(profiles.map((row) => [row.id, row]));
  const emailById = new Map(authUsers.map((user) => [user.id, user.email ?? null]));

  return json({
    clips: data.map((row) => {
      const gameInfo = Array.isArray(row.games) ? row.games[0] : row.games;
      return {
        id: row.id,
        slug: row.slug,
        title: row.title,
        status: row.status,
        visibility: row.visibility,
        fileSizeBytes: row.file_size_bytes,
        durationMs: row.duration_ms,
        createdAt: row.created_at,
        userId: row.user_id,
        ownerEmail: emailById.get(row.user_id) ?? null,
        ownerUsername: profileById.get(row.user_id)?.username ?? null,
        gameName: gameInfo?.name ?? null,
        gameSlug: gameInfo?.slug ?? null,
        sharePath: `/c/${row.slug}`,
      };
    }),
    total: count ?? data.length,
    page,
    limit,
  });
}

async function deleteClip(env: Env, actor: AdminActor, clipId: string): Promise<Response> {
  if (!UUID.test(clipId)) throw new HttpError(400, "Clip id is invalid.");
  const clips = await serviceRest<ClipRow[]>(
    env,
    actor,
    "GET",
    `/clips?id=eq.${clipId}&select=id,user_id,slug,status,file_size_bytes,storage_key,thumbnail_key`,
  );
  const clip = clips[0];
  if (!clip || clip.status === "deleted") {
    throw new HttpError(404, "That cloud clip was not found.");
  }

  if (clip.storage_key || clip.thumbnail_key) requireR2(env);
  if (ownedObjectKey(clip.user_id, clip.storage_key)) await deleteObject(env, clip.storage_key);
  if (ownedObjectKey(clip.user_id, clip.thumbnail_key)) await deleteObject(env, clip.thumbnail_key);

  if (clip.status === "ready" && clip.file_size_bytes && clip.file_size_bytes > 0) {
    const rows = await serviceRest<StorageRow[]>(
      env,
      actor,
      "GET",
      `/user_storage?user_id=eq.${clip.user_id}&select=user_id,plan_id,storage_used_bytes,storage_limit_bytes,plans(slug)`,
    );
    const used = Number(rows[0]?.storage_used_bytes ?? 0);
    await serviceRest(env, actor, "PATCH", `/user_storage?user_id=eq.${clip.user_id}`, {
      storage_used_bytes: Math.max(0, used - clip.file_size_bytes),
      updated_at: new Date().toISOString(),
    });
  }

  await serviceRest(env, actor, "PATCH", `/clips?id=eq.${clipId}`, {
    status: "deleted",
    storage_key: null,
    thumbnail_key: null,
  });
  await serviceRest(env, actor, "DELETE", `/upload_sessions?clip_id=eq.${clipId}`);
  return json({ clipId, status: "deleted" });
}

async function listStorage(env: Env, actor: AdminActor): Promise<Response> {
  const storageRows = await serviceRest<StorageRow[]>(
    env,
    actor,
    "GET",
    "/user_storage?select=user_id,plan_id,storage_used_bytes,storage_limit_bytes,plans(slug)&order=storage_used_bytes.desc&limit=200",
  );
  const userIds = storageRows.map((row) => row.user_id);
  const [profiles, authUsers, clipCountById] = await Promise.all([
    userIds.length
      ? serviceRest<ProfileRow[]>(
          env,
          actor,
          "GET",
          `/profiles?id=in.(${userIds.join(",")})&select=id,username,display_name,is_verified`,
        )
      : Promise.resolve([] as ProfileRow[]),
    getAuthUsersByIds(env, actor, userIds),
    clipCountsForUsers(env, actor, userIds),
  ]);
  const profileById = new Map(profiles.map((row) => [row.id, row]));
  const emailById = new Map(authUsers.map((user) => [user.id, user.email ?? null]));

  const accounts = storageRows.map((row) => {
    const used = Number(row.storage_used_bytes || 0);
    const limit = Number(row.storage_limit_bytes || 0);
    return {
      userId: row.user_id,
      email: emailById.get(row.user_id) ?? null,
      username: profileById.get(row.user_id)?.username ?? null,
      planSlug: planSlugOf(row),
      storageUsedBytes: used,
      storageLimitBytes: limit,
      percent: limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0,
      clipCount: clipCountById.get(row.user_id) ?? 0,
    };
  });

  return json({
    accounts,
    approaching: accounts.filter((row) => row.percent >= 80),
  });
}

async function listCreators(env: Env, actor: AdminActor, url: URL): Promise<Response> {
  const status = (url.searchParams.get("status") || "pending").trim();
  if (status !== "all" && !APP_STATUSES.has(status)) throw new HttpError(400, "Unknown application status.");
  const filter = status === "all" ? "" : `&status=eq.${status}`;
  const rows = await serviceRest<ApplicationRow[]>(
    env,
    actor,
    "GET",
    `/creator_applications?select=id,user_id,display_name,channel_url,game,note,status,created_at,reviewed_at,review_note${filter}&order=created_at.desc`,
  );
  const userIds = [...new Set(rows.map((row) => row.user_id))];
  const [profiles, authUsers] = await Promise.all([
    userIds.length
      ? serviceRest<ProfileRow[]>(
          env,
          actor,
          "GET",
          `/profiles?id=in.(${userIds.join(",")})&select=id,username,display_name,is_verified`,
        )
      : Promise.resolve([] as ProfileRow[]),
    getAuthUsersByIds(env, actor, userIds),
  ]);
  const profileById = new Map(profiles.map((row) => [row.id, row]));
  const emailById = new Map(authUsers.map((user) => [user.id, user.email ?? null]));
  return json({
    applications: rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      displayName: row.display_name,
      channelUrl: row.channel_url,
      game: row.game,
      note: row.note,
      status: row.status,
      createdAt: row.created_at,
      reviewedAt: row.reviewed_at,
      reviewNote: row.review_note,
      email: emailById.get(row.user_id) ?? null,
      username: profileById.get(row.user_id)?.username ?? null,
    })),
  });
}

async function reviewCreator(
  request: Request,
  env: Env,
  actor: AdminActor,
  applicationId: string,
): Promise<Response> {
  if (!UUID.test(applicationId)) throw new HttpError(400, "Application id is invalid.");
  const body = (await request.json()) as { status?: string; note?: string };
  if (body.status !== "approved" && body.status !== "rejected") {
    throw new HttpError(400, "Review must approve or reject.");
  }
  const note = typeof body.note === "string" ? body.note.trim().slice(0, 1000) : "";
  const rows = await serviceRest<ApplicationRow[]>(
    env,
    actor,
    "GET",
    `/creator_applications?id=eq.${applicationId}&select=id,user_id,status`,
  );
  const row = rows[0];
  if (!row) throw new HttpError(404, "That application was not found.");
  if (row.status !== "pending") throw new HttpError(409, "That application was already reviewed.");

  await serviceRest(env, actor, "PATCH", `/creator_applications?id=eq.${applicationId}`, {
    status: body.status,
    reviewed_at: new Date().toISOString(),
    review_note: note || null,
  });
  if (body.status === "approved") {
    await serviceRest(env, actor, "PATCH", `/profiles?id=eq.${row.user_id}`, { is_verified: true });
  }
  return json({ applicationId, status: body.status });
}

async function getAuthUser(env: Env, actor: AdminActor, id: string): Promise<AuthAdminUser | null> {
  const response = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users/${id}`, {
    headers: {
      apikey: actor.serviceKey,
      authorization: `Bearer ${actor.serviceKey}`,
    },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new HttpError(502, "Could not load account.");
  return (await response.json()) as AuthAdminUser;
}

async function getAuthUsersByIds(env: Env, actor: AdminActor, ids: string[]): Promise<AuthAdminUser[]> {
  const unique = [...new Set(ids.filter((id) => UUID.test(id)))];
  const users = await Promise.all(unique.map((id) => getAuthUser(env, actor, id)));
  return users.filter((user): user is AuthAdminUser => Boolean(user));
}

async function listAuthUsersPage(
  env: Env,
  actor: AdminActor,
  page: number,
  perPage: number,
): Promise<{ users: AuthAdminUser[] }> {
  const response = await fetch(
    `${env.SUPABASE_URL}/auth/v1/admin/users?page=${page}&per_page=${perPage}`,
    {
      headers: {
        apikey: actor.serviceKey,
        authorization: `Bearer ${actor.serviceKey}`,
      },
    },
  );
  if (!response.ok) throw new HttpError(502, "Could not load accounts.");
  const body = (await response.json()) as { users?: AuthAdminUser[] };
  return { users: body.users ?? [] };
}

async function resolveUserSearchIds(
  env: Env,
  actor: AdminActor,
  query: string,
  plan: string,
  page: number,
  limit: number,
): Promise<string[]> {
  const ids = new Set<string>();
  if (plan) {
    const storageRows = await serviceRest<Pick<StorageRow, "user_id" | "plans">[]>(
      env,
      actor,
      "GET",
      `/user_storage?select=user_id,plans!inner(slug)&plans.slug=eq.${encodeURIComponent(plan)}`,
    );
    for (const row of storageRows) ids.add(row.user_id);
  }
  if (!query) return [...ids];

  const [profiles, authPage] = await Promise.all([
    serviceRest<ProfileRow[]>(
      env,
      actor,
      "GET",
      `/profiles?or=(username.ilike.*${query}*,display_name.ilike.*${query}*)&select=id,username,display_name,is_verified`,
    ),
    listAuthUsersPage(env, actor, page, limit),
  ]);
  const matched = new Set(profiles.map((row) => row.id));
  if (UUID.test(query)) matched.add(query);
  const needle = query.toLowerCase();
  for (const user of authPage.users) {
    if (user.email?.toLowerCase().includes(needle) || user.id.toLowerCase().includes(needle)) {
      matched.add(user.id);
    }
  }
  if (plan) return [...ids].filter((id) => matched.has(id));
  return [...matched];
}

async function resolveClipOwnerSearchIds(
  env: Env,
  actor: AdminActor,
  query: string,
  page: number,
  limit: number,
): Promise<Set<string>> {
  const [profiles, authPage] = await Promise.all([
    serviceRest<ProfileRow[]>(
      env,
      actor,
      "GET",
      `/profiles?or=(username.ilike.*${query}*,display_name.ilike.*${query}*)&select=id,username,display_name,is_verified`,
    ),
    listAuthUsersPage(env, actor, page, limit),
  ]);
  const ids = new Set(profiles.map((row) => row.id));
  if (UUID.test(query)) ids.add(query);
  const needle = query.toLowerCase();
  for (const user of authPage.users) {
    if (user.email?.toLowerCase().includes(needle) || user.id.toLowerCase().includes(needle)) {
      ids.add(user.id);
    }
  }
  return ids;
}

type AdminUserRow = {
  id: string;
  email: string | null;
  username: string | null;
  displayName: string | null;
  planSlug: string;
  storageUsedBytes: number;
  storageLimitBytes: number;
  clipCount: number;
  lastSignInAt: string | null;
  createdAt: string | null;
  isVerified: boolean;
  role: "admin" | null;
};

async function hydrateUsers(env: Env, actor: AdminActor, authUsers: AuthAdminUser[]): Promise<AdminUserRow[]> {
  const ids = authUsers.map((user) => user.id);
  const [profiles, storageRows, clipCountById] = await Promise.all([
    ids.length
      ? serviceRest<ProfileRow[]>(
          env,
          actor,
          "GET",
          `/profiles?id=in.(${ids.join(",")})&select=id,username,display_name,is_verified`,
        )
      : Promise.resolve([] as ProfileRow[]),
    ids.length
      ? serviceRest<StorageRow[]>(
          env,
          actor,
          "GET",
          `/user_storage?user_id=in.(${ids.join(",")})&select=user_id,plan_id,storage_used_bytes,storage_limit_bytes,plans(slug)`,
        )
      : Promise.resolve([] as StorageRow[]),
    clipCountsForUsers(env, actor, ids),
  ]);
  const profileById = new Map(profiles.map((row) => [row.id, row]));
  const storageById = new Map(storageRows.map((row) => [row.user_id, row]));
  return authUsers.map((user) => {
    const profile = profileById.get(user.id);
    const storage = storageById.get(user.id);
    return {
      id: user.id,
      email: user.email ?? null,
      username: profile?.username ?? null,
      displayName: profile?.display_name ?? null,
      planSlug: planSlugOf(storage),
      storageUsedBytes: Number(storage?.storage_used_bytes ?? 0),
      storageLimitBytes: Number(storage?.storage_limit_bytes ?? 0),
      clipCount: clipCountById.get(user.id) ?? 0,
      lastSignInAt: user.last_sign_in_at ?? null,
      createdAt: user.created_at ?? null,
      isVerified: Boolean(profile?.is_verified),
      role: user.app_metadata?.role === "admin" ? "admin" : null,
    };
  });
}

async function clipCountsForUsers(
  env: Env,
  actor: AdminActor,
  ids: string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (!ids.length) return counts;
  await Promise.all(
    ids.map(async (id) => {
      counts.set(
        id,
        await restCount(env, actor, `/clips?user_id=eq.${id}&status=neq.deleted&select=id`),
      );
    }),
  );
  return counts;
}

async function serviceRest<T>(
  env: Env,
  actor: AdminActor,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const { data } = await serviceRestPage<T>(env, actor, path, undefined, undefined, method, body);
  return data;
}

async function serviceRestPage<T>(
  env: Env,
  actor: AdminActor,
  path: string,
  from?: number,
  to?: number,
  method = "GET",
  body?: unknown,
): Promise<{ data: T; count: number | null }> {
  const headers: Record<string, string> = {
    apikey: actor.serviceKey,
    authorization: `Bearer ${actor.serviceKey}`,
    "content-type": "application/json",
    prefer:
      method === "GET"
        ? "count=exact"
        : method === "DELETE"
          ? "return=minimal"
          : "return=representation",
  };
  if (from != null && to != null) headers.range = `${from}-${to}`;
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new HttpError(response.status === 409 ? 409 : 502, restError(text) || "Admin query failed.");
  }
  const range = response.headers.get("content-range");
  const total = range?.split("/")[1];
  const count = total && total !== "*" ? Number(total) : null;
  if (!text) return { data: [] as T, count };
  return { data: JSON.parse(text) as T, count };
}

async function restCount(env: Env, actor: AdminActor, path: string): Promise<number> {
  const { count, data } = await serviceRestPage<unknown[]>(env, actor, path, 0, 0);
  if (count != null) return count;
  return Array.isArray(data) ? data.length : 0;
}

function requireR2(env: Env) {
  if (!env.R2_ACCOUNT_ID || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY || !env.R2_BUCKET_NAME) {
    throw new HttpError(503, "Cloud storage is not configured on the Worker.");
  }
}

async function deleteObject(env: Env, key: string) {
  if (env.CLIPS) {
    await env.CLIPS.delete(key);
    return;
  }
  await new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: "s3",
    region: "auto",
  }).fetch(`https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET_NAME}/${key}`, {
    method: "DELETE",
  });
}

function planSlugOf(row: StorageRow | undefined): string {
  if (!row?.plans) return "free";
  const plan = Array.isArray(row.plans) ? row.plans[0] : row.plans;
  return plan?.slug || "free";
}

function pagination(url: URL) {
  const page = Math.max(1, Math.floor(Number(url.searchParams.get("page") || 1)) || 1);
  const limit = Math.min(100, Math.max(1, Math.floor(Number(url.searchParams.get("limit") || 50)) || 50));
  return { page, limit };
}

function sanitizeSearch(value: string) {
  return value.replace(/[,()*]/g, "").trim().slice(0, 80);
}

function restError(body: string): string {
  try {
    const value = JSON.parse(body) as { message?: string; hint?: string; details?: string };
    return value.message || value.hint || value.details || "";
  } catch {
    return "";
  }
}
