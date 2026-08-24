import { FormEvent, useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Seo } from "../components/Seo";
import { SocialAvatar } from "../components/SocialAvatar";
import {
  acceptFriendRequest,
  blockUser,
  cancelFriendRequest,
  createFriendRequest,
  declineFriendRequest,
  fetchFriendRequests,
  fetchFriends,
  personName,
  searchUsers,
  unfriendUser,
  fetchUserSuggestions,
  type Friend,
  type FriendRequest,
  type Relationship,
  type SocialUser,
} from "../lib/api.friends";
import { createConversation } from "../lib/api.messages";
import { useAuth } from "../lib/auth";
import { useSocialUnread } from "../lib/socialUnread";

type Tab = "friends" | "requests" | "find";

function tabFromParam(value: string | null): Tab {
  return value === "requests" || value === "find" ? value : "friends";
}

export function FriendsPage() {
  const { session } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = session?.access_token ?? "";
  const { setFriendsUnread } = useSocialUnread();
  const [tab, setTab] = useState<Tab>(() => tabFromParam(params.get("tab")));
  const [friends, setFriends] = useState<Friend[]>([]);
  const [incoming, setIncoming] = useState<FriendRequest[]>([]);
  const [outgoing, setOutgoing] = useState<FriendRequest[]>([]);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Array<SocialUser & { relationship: Relationship }>>([]);
  const [suggestions, setSuggestions] = useState<Array<SocialUser & { relationship: Relationship }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function reload() {
    const [nextFriends, requests] = await Promise.all([fetchFriends(token), fetchFriendRequests(token)]);
    setFriends(nextFriends);
    setIncoming(requests.incoming);
    setOutgoing(requests.outgoing);
    setFriendsUnread(requests.incoming.length > 0);
  }

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    setLoading(true);
    void reload()
      .catch((caught) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Could not load friends.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(() => {
    setTab(tabFromParam(params.get("tab")));
  }, [params]);

  useEffect(() => {
    if (!token || tab !== "find") return;
    const needle = query.trim();
    if (needle.length < 2) {
      setResults([]);
      return;
    }
    const handle = window.setTimeout(() => {
      void searchUsers(token, needle)
        .then(setResults)
        .catch((caught) => setError(caught instanceof Error ? caught.message : "Could not search people."));
    }, 280);
    return () => window.clearTimeout(handle);
  }, [query, tab, token]);

  useEffect(() => {
    if (!token || tab !== "find") return;
    if (query.trim().length >= 2) return;
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

  async function run(id: string, work: () => Promise<void>) {
    setBusyId(id);
    setError(null);
    try {
      await work();
      await reload();
      if (tab === "find" && query.trim().length >= 2) {
        setResults(await searchUsers(token, query));
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That action failed.");
    } finally {
      setBusyId(null);
    }
  }

  async function openDm(friend: Friend) {
    setBusyId(friend.id);
    setError(null);
    try {
      if (friend.dmId) {
        navigate(`/messages/${friend.dmId}`);
        return;
      }
      const conversation = await createConversation(token, { type: "dm", userId: friend.id });
      navigate(`/messages/${conversation.id}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not open that chat.");
      setBusyId(null);
    }
  }

  return (
    <main className="page social-page">
      <Seo title="Friends — Replayr" description="Add friends, accept requests, and start a DM." robots="noindex" />
      <p className="eyebrow">Mutual friends</p>
      <h1>Friends</h1>
      <p className="lede">Requests have to be accepted both ways. DMs and groups stay between friends.</p>
      {error ? <p className="error">{error}</p> : null}

      <div className="social-tabs" role="tablist" aria-label="Friends sections">
        <TabButton active={tab === "friends"} onClick={() => setTab("friends")}>
          Friends
        </TabButton>
        <TabButton active={tab === "requests"} onClick={() => setTab("requests")}>
          Requests
          {incoming.length > 0 ? <span className="unread-pip" aria-label={`${incoming.length} incoming`} /> : null}
        </TabButton>
        <TabButton active={tab === "find"} onClick={() => setTab("find")}>
          Find
        </TabButton>
      </div>

      {loading ? <p className="muted">Loading…</p> : null}

      {!loading && tab === "friends" ? (
        friends.length === 0 ? (
          <div className="empty-bubble">
            <h2>No friends yet</h2>
            <p className="muted">Search a username in Find. There is no suggested list until you add someone.</p>
            <button className="btn primary" type="button" onClick={() => setTab("find")}>
              Find people
            </button>
          </div>
        ) : (
          <ul className="person-list">
            {friends.map((friend) => (
              <li key={friend.id} className="person-row">
                <PersonLink user={friend} />
                <div className="row">
                  <button className="btn primary" type="button" disabled={busyId === friend.id} onClick={() => void openDm(friend)}>
                    Message
                  </button>
                  <button
                    className="btn"
                    type="button"
                    disabled={busyId === friend.id}
                    onClick={() => {
                      if (!window.confirm(`Remove ${personName(friend)} as a friend?`)) return;
                      void run(friend.id, () => unfriendUser(token, friend.id));
                    }}
                  >
                    Unfriend
                  </button>
                  <button
                    className="btn danger"
                    type="button"
                    disabled={busyId === friend.id}
                    onClick={() => {
                      if (!window.confirm(`Block ${personName(friend)}? They will not be able to find you.`)) return;
                      void run(friend.id, () => blockUser(token, friend.id));
                    }}
                  >
                    Block
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )
      ) : null}

      {!loading && tab === "requests" ? (
        <div className="stack">
          <section>
            <h2 className="section-title">Incoming</h2>
            {incoming.length === 0 ? (
              <p className="muted">No incoming requests.</p>
            ) : (
              <ul className="person-list">
                {incoming.map((request) => (
                  <li key={request.id} className="person-row">
                    <PersonLink user={request.from} />
                    <div className="row">
                      <button
                        className="btn primary"
                        type="button"
                        disabled={busyId === request.id}
                        onClick={() => void run(request.id, async () => {
                          await acceptFriendRequest(token, request.id);
                        })}
                      >
                        Accept
                      </button>
                      <button
                        className="btn"
                        type="button"
                        disabled={busyId === request.id}
                        onClick={() => void run(request.id, () => declineFriendRequest(token, request.id))}
                      >
                        Decline
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section>
            <h2 className="section-title">Outgoing</h2>
            {outgoing.length === 0 ? (
              <p className="muted">You have not sent any requests.</p>
            ) : (
              <ul className="person-list">
                {outgoing.map((request) => (
                  <li key={request.id} className="person-row">
                    <PersonLink user={request.to} />
                    <button
                      className="btn"
                      type="button"
                      disabled={busyId === request.id}
                      onClick={() => void run(request.id, () => cancelFriendRequest(token, request.id))}
                    >
                      Cancel
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      ) : null}

      {tab === "find" ? (
        <section>
          <form className="games-search" role="search" onSubmit={(event: FormEvent) => event.preventDefault()}>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search a username"
              aria-label="Search a username"
              autoComplete="off"
            />
          </form>
          {query.trim().length > 0 && query.trim().length < 2 ? (
            <p className="muted">Type at least two characters.</p>
          ) : null}
          {query.trim().length < 2 && results.length === 0 ? (
            suggestions.length > 0 ? (
              <div className="stack">
                <h2>Plays the same games</h2>
                <ul className="person-list">
                  {suggestions.map((user) => (
                    <li key={user.id} className="person-row">
                      <PersonLink user={user} />
                      <FindActions
                        user={user}
                        busy={busyId === user.id}
                        incoming={incoming}
                        outgoing={outgoing}
                        onAdd={() => void run(user.id, async () => {
                          await createFriendRequest(token, { userId: user.id });
                        })}
                        onAccept={(requestId) => void run(user.id, async () => {
                          await acceptFriendRequest(token, requestId);
                        })}
                        onCancel={(requestId) => void run(user.id, () => cancelFriendRequest(token, requestId))}
                        onMessage={() => {
                          const friend = friends.find((item) => item.id === user.id);
                          if (friend) void openDm(friend);
                        }}
                      />
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <div className="empty-bubble">
                <h2>Find someone you know</h2>
                <p className="muted">Search by username. People who play the same games show up here when we have a match.</p>
              </div>
            )
          ) : null}
          {query.trim().length >= 2 && results.length === 0 ? (
            <p className="muted">No people match that username.</p>
          ) : null}
          {results.length > 0 ? (
            <ul className="person-list">
              {results.map((user) => (
                <li key={user.id} className="person-row">
                  <PersonLink user={user} />
                  <FindActions
                    user={user}
                    busy={busyId === user.id}
                    incoming={incoming}
                    outgoing={outgoing}
                    onAdd={() => void run(user.id, async () => {
                      await createFriendRequest(token, { userId: user.id });
                    })}
                    onAccept={(requestId) => void run(user.id, async () => {
                      await acceptFriendRequest(token, requestId);
                    })}
                    onCancel={(requestId) => void run(user.id, () => cancelFriendRequest(token, requestId))}
                    onMessage={() => {
                      const friend = friends.find((item) => item.id === user.id);
                      if (friend) void openDm(friend);
                      else {
                        setBusyId(user.id);
                        void createConversation(token, { type: "dm", userId: user.id })
                          .then((conversation) => navigate(`/messages/${conversation.id}`))
                          .catch((caught) => {
                            setError(caught instanceof Error ? caught.message : "Could not open that chat.");
                            setBusyId(null);
                          });
                      }
                    }}
                  />
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}
    </main>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button className={`social-tab${active ? " is-active" : ""}`} type="button" role="tab" aria-selected={active} onClick={onClick}>
      {children}
    </button>
  );
}

function PersonLink({ user }: { user: SocialUser }) {
  const name = personName(user);
  const inner = (
    <>
      <SocialAvatar name={name} avatarUrl={user.avatarUrl} />
      <span>
        <strong>
          {name}
          {user.verified ? <span className="verified-mark">Verified</span> : null}
        </strong>
        <span className="muted">{user.username ? `@${user.username}` : "No username"}</span>
      </span>
    </>
  );
  if (!user.username) return <div className="person-identity">{inner}</div>;
  return (
    <Link className="person-identity" to={`/u/${encodeURIComponent(user.username)}`}>
      {inner}
    </Link>
  );
}

function FindActions({
  user,
  busy,
  incoming,
  outgoing,
  onAdd,
  onAccept,
  onCancel,
  onMessage,
}: {
  user: SocialUser & { relationship: Relationship };
  busy: boolean;
  incoming: FriendRequest[];
  outgoing: FriendRequest[];
  onAdd: () => void;
  onAccept: (requestId: string) => void;
  onCancel: (requestId: string) => void;
  onMessage: () => void;
}) {
  if (user.relationship === "friends") {
    return (
      <button className="btn primary" type="button" disabled={busy} onClick={onMessage}>
        Message
      </button>
    );
  }
  if (user.relationship === "outgoing") {
    const request = outgoing.find((item) => item.to.id === user.id);
    return request ? (
      <button className="btn" type="button" disabled={busy} onClick={() => onCancel(request.id)}>
        Cancel request
      </button>
    ) : (
      <span className="muted">Request sent</span>
    );
  }
  if (user.relationship === "incoming") {
    const request = incoming.find((item) => item.from.id === user.id);
    return request ? (
      <button className="btn primary" type="button" disabled={busy} onClick={() => onAccept(request.id)}>
        Accept
      </button>
    ) : (
      <span className="muted">They already sent you a request</span>
    );
  }
  return (
    <button className="btn primary" type="button" disabled={busy} onClick={onAdd}>
      Add friend
    </button>
  );
}
