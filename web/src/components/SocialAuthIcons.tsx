type SocialProvider = "google" | "apple" | "discord" | "twitter";

const PROVIDERS: { id: SocialProvider; label: string }[] = [
  { id: "google", label: "Continue with Google" },
  { id: "apple", label: "Continue with Apple" },
  { id: "discord", label: "Continue with Discord" },
  { id: "twitter", label: "Continue with X" },
];

export function SocialAuthIcons({
  disabled,
  onProvider,
}: {
  disabled?: boolean;
  onProvider: (provider: SocialProvider) => void;
}) {
  return (
    <div className="auth-social-icons">
      {PROVIDERS.map((provider) => (
        <button
          key={provider.id}
          className="auth-social-icon"
          type="button"
          disabled={disabled}
          aria-label={provider.label}
          onClick={() => onProvider(provider.id)}
        >
          <SocialMark provider={provider.id} />
        </button>
      ))}
    </div>
  );
}

function SocialMark({ provider }: { provider: SocialProvider }) {
  if (provider === "google") {
    return (
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
        <path
          fill="currentColor"
          d="M12 11.2v2.4h5.4A5.6 5.6 0 1 1 12 6.4a5.4 5.4 0 0 1 3.8 1.5l1.7-1.7A8 8 0 1 0 12 20a7.7 7.7 0 0 0 7.6-6 8 8 0 0 0 .2-1.8z"
        />
      </svg>
    );
  }
  if (provider === "apple") {
    return (
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
        <path
          fill="currentColor"
          d="M16.2 8.6c-.9 0-2 .6-2.6.6-.7 0-1.7-.6-2.8-.6-2.3.1-4.4 2-4.4 5.1 0 2 .7 4.1 1.7 5.5.8 1.1 1.6 2.2 2.8 2.2 1.1 0 1.5-.7 2.8-.7s1.6.7 2.8.7c1.2 0 1.9-1.1 2.7-2.2.8-1.2 1.1-2.4 1.1-2.5 0 0-2.2-.8-2.2-3.3 0-2.1 1.7-3 1.8-3.1-1-.1-2.2.6-2.7.6z"
        />
      </svg>
    );
  }
  if (provider === "discord") {
    return (
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
        <path
          fill="currentColor"
          d="M8.2 8.8c1.6-.8 3.1-1.1 3.8-1.2l.4 1c1 .1 2 .4 3 .9 1.4 2 1.9 4.1 1.7 6.1-1.1.5-2.2.9-3.4 1.1l-.6-1.1c.4-.1.8-.3 1.1-.5-.3-.2-.6-.4-.9-.6-.9.4-1.9.6-2.9.6s-2-.2-2.9-.6c-.3.2-.6.4-.9.6.3.2.7.4 1.1.5l-.6 1.1c-1.2-.2-2.3-.6-3.4-1.1-.3-2.1.2-4.3 1.7-6.2.9-.4 1.8-.7 2.8-.8l.4-1c.7.1 2.2.4 3.8 1.2z"
        />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path
        fill="currentColor"
        d="M5 5.5 10.8 12 5.2 18.5h2.2L12 13.4l4.4 5.1h2.4L12.8 11.8 18.8 5.5h-2.2L12 10.4 7.4 5.5z"
      />
    </svg>
  );
}
