-- Correcting the currency an upload was labelled with.
--
-- Transactions have no UPDATE policy on purpose: the event store is written
-- once, and only deleted. A founder who labels a rand export as dollars
-- still needs to fix the label without deleting and re-uploading, so this
-- function changes exactly one thing, the currency of one upload and the
-- transactions it added, and only for the caller's own upload. Amounts are
-- never touched, and nothing is converted.
--
-- A transaction that was already on file from an earlier upload belongs to
-- that earlier upload, so it is not relabelled here.

create or replace function public.relabel_upload_currency(p_batch_id uuid, p_currency text)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare v_count integer;
begin
  if auth.uid() is null then
    raise exception 'not signed in';
  end if;
  if p_currency is null or p_currency !~ '^[A-Z]{3}$' then
    raise exception 'invalid currency code';
  end if;
  update public.upload_batches set currency = p_currency
    where id = p_batch_id and user_id = auth.uid();
  if not found then
    raise exception 'upload not found';
  end if;
  update public.transactions set currency = p_currency
    where source_batch_id = p_batch_id and user_id = auth.uid();
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.relabel_upload_currency(uuid, text) from public, anon;
grant execute on function public.relabel_upload_currency(uuid, text) to authenticated;

notify pgrst, 'reload schema';
