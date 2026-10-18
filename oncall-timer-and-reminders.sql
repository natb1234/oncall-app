-- Applied 17 Oct 2026 via Supabase (migration names: auto_release_timer, approval_reminder_column).
-- The real Vault secret value is NOT stored here. To recreate: generate a new random secret,
-- put it in Vault as 'oncall_cron_secret', and the cron job below will send it.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- select vault.create_secret('<random secret>', 'oncall_cron_secret', 'Shared secret the auto-release timer sends to the oncall function');

create or replace function public.check_cron_secret(s text)
returns boolean language sql security definer set search_path = '' as $$
  select exists (select 1 from vault.decrypted_secrets where name = 'oncall_cron_secret' and decrypted_secret = s);
$$;
revoke all on function public.check_cron_secret(text) from public, anon, authenticated;
grant execute on function public.check_cron_secret(text) to service_role;

select cron.schedule('oncall-auto-release', '*/15 * * * *', $$
  select net.http_post(
    url := 'https://vwezewdobyyqrbflllmg.supabase.co/functions/v1/oncall',
    headers := jsonb_build_object('Content-Type','application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'oncall_cron_secret')),
    body := '{"action":"auto_release_sweep"}'::jsonb);
$$);

alter table public.tasks add column if not exists reminder_sent_at timestamptz;
