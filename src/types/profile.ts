export interface Profile {
  id: string;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
  bio: string | null;
  created_at: string;
  updated_at: string;
  is_verified: boolean;
  is_private: boolean;
  followers_count: number;
  following_count: number;
  clip_count: number;
}

export interface UserStorage {
  user_id: string;
  storage_used_bytes: number;
  storage_limit_bytes: number;
  updated_at: string;
}
