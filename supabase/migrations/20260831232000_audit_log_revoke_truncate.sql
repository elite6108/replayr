-- Align audit_log with append-only SELECT/INSERT for service_role.
-- Default table create also granted REFERENCES/TRIGGER/TRUNCATE.
revoke update, delete, truncate, references, trigger on table public.audit_log from public, anon, authenticated, service_role;
grant insert, select on table public.audit_log to service_role;
