export interface Env {
  CLIPS?: R2Bucket;
  ASSETS?: { fetch: (request: Request) => Promise<Response> };
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  R2_ACCOUNT_ID: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_BUCKET_NAME: string;
  PUBLIC_APP_URL: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_PRICE_PREMIUM_MONTHLY?: string;
  STRIPE_PRICE_PREMIUM_YEARLY?: string;
  /** Bunny Stream library id (Worker secret / .dev.vars only). */
  BUNNY_STREAM_LIBRARY_ID?: string;
  /** Bunny Stream AccessKey with write access. */
  BUNNY_STREAM_API_KEY?: string;
  /** Pull-zone hostname, e.g. vz-xxxx.b-cdn.net */
  BUNNY_STREAM_CDN_HOSTNAME?: string;
  /** Library Read-Only API key — webhook HMAC secret per Bunny docs. */
  BUNNY_STREAM_READONLY_API_KEY?: string;
  /** Optional CDN token authentication key for signed play_Np.mp4 URLs. */
  BUNNY_STREAM_TOKEN_AUTH_KEY?: string;
  /** Optional override for Bunny remote-fetch origin (defaults to https://www.replayr.tv). */
  BUNNY_INGEST_PUBLIC_ORIGIN?: string;
}

export interface AuthUser {
  id: string;
  token: string;
}
