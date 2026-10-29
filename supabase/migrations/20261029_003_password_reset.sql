-- BizTrack: password reset with the recovery code.
-- Safe to re-run.
--
-- Business data is encrypted with a data key, and the data key is stored
-- "wrapped" (encrypted) by the password and, separately, by the recovery code.
-- After a password reset the app unwraps the data key with the recovery code
-- and wraps it again with the new password. This function saves that new
-- wrapper. It changes nothing else, and only on the caller's own workspace,
-- so it also works for read-only (expired) accounts. The encrypted business
-- data itself is untouched.

create or replace function public.biztrack_set_password_key(p_wrapped text)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if auth.uid() is null then
    raise exception 'Not signed in';
  end if;
  if p_wrapped is null or length(p_wrapped) > 2000 or p_wrapped !~ '^\{.*"iv".*"data".*\}$' then
    raise exception 'Invalid key';
  end if;
  update public.biztrack_workspaces
  set data_key_wrapped = p_wrapped,
      updated_at = now()
  where user_id = auth.uid()
    and data_key_wrapped is not null;
  return found;
end;
$$;

revoke all on function public.biztrack_set_password_key(text) from public, anon;
grant execute on function public.biztrack_set_password_key(text) to authenticated;
