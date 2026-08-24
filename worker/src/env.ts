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
}

export interface AuthUser {
  id: string;
  token: string;
}
