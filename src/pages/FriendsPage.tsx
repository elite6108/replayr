import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { AuthCard } from "../components/common/AuthCard";
import { EmptyState } from "../components/common/EmptyState";
import { PageHeader } from "../components/common/PageHeader";
import { SocialAvatar } from "../components/common/SocialAvatar";
import { IconFriends, IconSearch } from "../components/icons";
import {
  acceptFriendRequest,
  blockUser,
  cancelFriendRequest,
  createFriendRequest,
  declineFriendRequest,
  fetchFriendRequests,
  fetchFriends,
  searchUsers,
  unfriendUser,
  fetchUserSuggestions,
} from "../services/api.friends";
import { createConversation } from "../services/api.messages";
import type { Friend, FriendRequest, Relationship, SocialUser } from "../services/social-types";
import { useAuthStore } from "../stores/authStore";
import { useSocialUnreadStore } from "../stores/socialUnreadStore";
import { useToastStore } from "../stores/toastStore";
import { formatClipDate, formatHandle } from "../utils/format";

type FriendsTab = "friends" | "requests" | "find";
type SearchHit = SocialUser & { relationship: Relationship };

function tabFromParam(value: string | null): FriendsTab {
  return value === "requests" || value === "find" ? value : "friends";
}

export function FriendsPage() {
  const configured = useAuthStore((state) => state.configured);
  const user = useAuthStore((state) => state.user);
  const token = useAuthStore((state) => state.session?.access_token);
  const showToast = useToastStore((state) => state.show);
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [tab, setTab] = useState<FriendsTab>(() => tabFromParam(params.get("tab")));
  const [friends, setFriends] = useState<Friend[]>([]);
  const [incoming, setIncoming] = useState<FriendRequest[]>([]);
  const [outgoing, setOutgoing] = useState<FriendRequest[]>([]);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [suggestions, setSuggestions] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const [nextFriends, requests] = await Promise.all([fetchFriends(token), fetchFriendRequests(token)]);
      setFriends(nextFriends);
      setIncoming(requests.incoming);
      setOutgoing(requests.outgoing);
      setError(null);
      useSocialUnreadStore.getState().setFriendsUnread(requests.incoming.length > 0);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load friends.");
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setTab(tabFromParam(params.get("tab")));
  }, [params]);

  useEffect(() => {
    if (!token || tab !== "find") return;
    const needle = query.replace(/^@/, "").trim();
    if (needle.length < 2) {
      setHits([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const handle = window.setTimeout(() => {
      void searchUsers(token, needle)
        .then((users) => setHits(users))
        .catch((caught) => showToast(caught instanceof Error ? caught.message : "Could not search accounts."))
        .finally(() => setSearching(false));
    }, 280);
    return () => window.clearTimeout(handle);
  }, [query, tab, token, showToast]);

  useEffect(() => {
    if (!token || tab !== "find") return;
    const needle = query.replace(/^@/, "").trim();
    if (needle.length >= 2) return;
    let cancelled = false;
    void fetchUserSuggestions(token)
      .then((users) => {
        if (!cancelled) setSuggestions(users);
      })
      .catch(() => {
        if (!cancelled) setSuggestions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [tab, token, query]);

  async function run(id: string, action: () => Promise<void>, success?: string) {
    setBusyId(id);
    try {
      await action();
      if (success) showToast(success);
      await load();
      const needle = query.replace(/^@/, "").trim();
      if (tab === "find" && token && needle.length >= 2) {
        setHits(await searchUsers(token, needle));
      }
    } catch (caught) {
      showToast(caught instanceof Error ? caught.message : "That action failed.");
    } finally {
      setBusyId(null);
    }
  }

  async function messageFriend(friend: Friend) {
    if (!token) return;
    setBusyId(friend.id);
    try {
      if (friend.dmId) {
        navigate(`/messages/${friend.dmId}`);
        return;
      }
      const conversation = await createConversation(token, { type: "dm", userId: friend.id });
      navigate(`/messages/${conversation.id}`);
    } catch (caught) {
      showToast(caught instanceof Error ? caught.message : "Could not open that chat.");
    } finally {
      setBusyId(null);
    }
  }

  const outgoingByUser = useMemo(() => new Map(outgoing.map((item) => [item.to.id, item])), [outgoing]);
  const incomingByUser = useMemo(() => new Map(incoming.map((item) => [item.from.id, item])), [incoming]);

  if (!configured) {
    return (
      <>
        <PageHeader title="Friends" subtitle="Cloud accounts are not configured on this PC." />
        <section className="panel">
          <p>
            Copy <code>.env.example</code> to <code>.env</code> and set <code>VITE_SUPABASE_URL</code> and{" "}
            <code>VITE_SUPABASE_ANON_KEY</code>.
          </p>
        </section>
      </>
    );
  }

  if (!user || !token) {
    return (
      <>
        <PageHeader title="Friends" subtitle="Sign in to add friends and send messages." />
        <AuthCard />
      </>
    );
  }

  return (
    <div className="social-page">
      <PageHeader title="Friends" subtitle="Mutual friends only. Search a username to send a request.">
        <nav className="tabs" aria-label="Friends view">
          <button className={tab === "friends" ? "active" : undefined} type="button" onClick={() => setTab("friends")}>
            Friends
          </button>
          <button className={tab === "requests" ? "active" : undefined} type="button" onClick={() => setTab("requests")}>
            Requests{incoming.length > 0 ? ` · ${incoming.length}` : ""}
          </button>
          <button className={tab === "find" ? "active" : undefined} type="button" onClick={() => setTab("find")}>
            Find
          </button>
        </nav>
      </PageHeader>

      {error ? <p className="error-text">{error}</p> : null}

      {tab === "friends" ? (
        friends.length === 0 ? (
          <section className="panel">
            <EmptyState
              icon={<IconFriends size={26} />}
              title="No friends yet"
              body="Nobody is on your list until you send a request and they accept. Search a username in Find."
            >
              <button className="btn primary" type="button" onClick={() => setTab("find")}>
                Find people
              </button>
            </EmptyState>
          </section>
        ) : (
          <section className="panel">
            <ul className="person-list">
              {friends.map((friend) => (
                <li key={friend.id} className="person-row">
                  <SocialAvatar person={friend} size="md" />
                  <div className="person-copy">
                    <strong>
                      {friend.displayName}
                      {friend.verified ? <span className="verified-dot" title="Verified" /> : null}
                    </strong>
                    <PersonHandle person={friend} />
                    <span className="muted">Friends since {formatClipDate(friend.since)}</span>
                  </div>
                  <div className="person-actions">
                    <button className="btn primary sm" type="button" disabled={busyId === friend.id} onClick={() => void messageFriend(friend)}>
                      Message
                    </button>
                    <button
                      className="btn sm"
                      type="button"
                      disabled={busyId === friend.id}
                      onClick={() => {
                        if (!window.confirm(`Unfriend ${friend.displayName}? You can send a new request later.`)) return;
                        void run(friend.id, () => unfriendUser(token, friend.id), "Unfriended");
                      }}
                    >
                      Unfriend
                    </button>
                    <button
                      className="btn sm danger"
                      type="button"
                      disabled={busyId === friend.id}
                      onClick={() => {
                        if (!window.confirm(`Block ${friend.displayName}? They will not be able to request you again.`)) return;
                        void run(friend.id, () => blockUser(token, friend.id), "Blocked");
                      }}
                    >
                      Block
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )
      ) : null}

      {tab === "requests" ? (
        <div className="social-split">
          <section className="panel stack">
            <div className="panel-head">
              <h2>Incoming</h2>
            </div>
            {incoming.length === 0 ? (
              <p className="muted">No incoming requests. When someone adds you, they show up here.</p>
            ) : (
              <ul className="person-list">
                {incoming.map((item) => (
                  <li key={item.id} className="person-row">
                    <SocialAvatar person={item.from} size="md" />
                    <div className="person-copy">
                      <strong>{item.from.displayName}</strong>
                      <PersonHandle person={item.from} />
                    </div>
                    <div className="person-actions">
                      <button
                        className="btn primary sm"
                        type="button"
                        disabled={busyId === item.id}
                        onClick={() => void run(item.id, async () => { await acceptFriendRequest(token, item.id); }, "Accepted")}
                      >
                        Accept
                      </button>
                      <button
                        className="btn sm"
                        type="button"
                        disabled={busyId === item.id}
                        onClick={() => void run(item.id, () => declineFriendRequest(token, item.id))}
                      >
                        Decline
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="panel stack">
            <div className="panel-head">
              <h2>Outgoing</h2>
            </div>
            {outgoing.length === 0 ? (
              <p className="muted">You have not sent any requests. Find a username to add someone.</p>
            ) : (
              <ul className="person-list">
                {outgoing.map((item) => (
                  <li key={item.id} className="person-row">
                    <SocialAvatar person={item.to} size="md" />
                    <div className="person-copy">
                      <strong>{item.to.displayName}</strong>
                      <PersonHandle person={item.to} />
                    </div>
                    <div className="person-actions">
                      <button
                        className="btn sm"
                        type="button"
                        disabled={busyId === item.id}
                        onClick={() => void run(item.id, () => cancelFriendRequest(token, item.id), "Request canceled")}
                      >
                        Cancel
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      ) : null}

      {tab === "find" ? (
        <section className="panel stack">
          <form className="find-search" onSubmit={(event: FormEvent) => event.preventDefault()} role="search">
            <IconSearch size={16} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search by username"
              aria-label="Search by username"
              autoFocus
            />
          </form>
          {query.replace(/^@/, "").trim().length < 2 ? (
            suggestions.length > 0 ? (
              <>
                <p className="muted">Plays the same games</p>
                <ul className="person-list">
                  {suggestions.map((hit) => (
                    <li key={hit.id} className="person-row">
                      <SocialAvatar person={hit} size="md" />
                      <div className="person-copy">
                        <strong>{hit.displayName}</strong>
                        <PersonHandle person={hit} />
                      </div>
                      <div className="person-actions">
                        <button
                          className="btn primary sm"
                          type="button"
                          disabled={busyId === hit.id}
                          onClick={() =>
                            void run(hit.id, async () => {
                              await createFriendRequest(token, hit.username ? { username: hit.username } : { userId: hit.id });
                            }, "Request sent")
                          }
                        >
                          Add
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <EmptyState
                icon={<IconSearch size={26} />}
                title="Search a username"
                body="Type at least two characters, or add someone who plays the same games when suggestions appear."
              />
            )
          ) : searching ? (
            <p className="muted">Searching…</p>
          ) : hits.length === 0 ? (
            <EmptyState
              icon={<IconFriends size={26} />}
              title="No accounts match"
              body="That username is not on Replayr, or they blocked you. Try the exact handle."
            />
          ) : (
            <ul className="person-list">
              {hits.map((hit) => {
                const incomingReq = incomingByUser.get(hit.id);
                const outgoingReq = outgoingByUser.get(hit.id);
                return (
                  <li key={hit.id} className="person-row">
                    <SocialAvatar person={hit} size="md" />
                    <div className="person-copy">
                      <strong>{hit.displayName}</strong>
                      <PersonHandle person={hit} />
                    </div>
                    <div className="person-actions">
                      {hit.relationship === "friends" ? (
                        <button
                          className="btn primary sm"
                          type="button"
                          onClick={() => {
                            const friend = friends.find((item) => item.id === hit.id);
                            if (friend) void messageFriend(friend);
                            else navigate("/messages");
                          }}
                        >
                          Message
                        </button>
                      ) : null}
                      {hit.relationship === "none" ? (
                        <button
                          className="btn primary sm"
                          type="button"
                          disabled={busyId === hit.id}
                          onClick={() =>
                            void run(hit.id, async () => {
                              await createFriendRequest(token, hit.username ? { username: hit.username } : { userId: hit.id });
                            }, "Request sent")
                          }
                        >
                          Add
                        </button>
                      ) : null}
                      {hit.relationship === "incoming" && incomingReq ? (
                        <button
                          className="btn primary sm"
                          type="button"
                          disabled={busyId === incomingReq.id}
                          onClick={() => void run(incomingReq.id, async () => { await acceptFriendRequest(token, incomingReq.id); }, "Accepted")}
                        >
                          Accept
                        </button>
                      ) : null}
                      {hit.relationship === "outgoing" && outgoingReq ? (
                        <button
                          className="btn sm"
                          type="button"
                          disabled={busyId === outgoingReq.id}
                          onClick={() => void run(outgoingReq.id, () => cancelFriendRequest(token, outgoingReq.id), "Request canceled")}
                        >
                          Cancel
                        </button>
                      ) : null}
                      {hit.relationship !== "friends" ? (
                        <button
                          className="btn sm danger"
                          type="button"
                          disabled={busyId === hit.id}
                          onClick={() => {
                            if (!window.confirm(`Block ${hit.displayName}?`)) return;
                            void run(hit.id, () => blockUser(token, hit.id), "Blocked");
                          }}
                        >
                          Block
                        </button>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      ) : null}
    </div>
  );
}

function PersonHandle({ person }: { person: SocialUser }) {
  if (!person.username) return <span className="muted">No username</span>;
  return (
    <Link className="muted person-handle" to={`/u/${person.username}`}>
      {formatHandle(person)}
    </Link>
  );
}
