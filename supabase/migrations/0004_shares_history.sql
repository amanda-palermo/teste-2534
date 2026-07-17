-- Radar RI - historico de quantidade de acoes em circulacao (CASH3)
-- A qtde de acoes muda ao longo do tempo (novas emissoes, recompras etc.) e o
-- site precisa mostrar o valor vigente na data selecionada, nao so o mais recente.
-- shares_outstanding (0001) continua existindo como snapshot atual, usado para
-- os demais peers que nao tem historico.

create table if not exists public.shares_outstanding_history (
  ticker         text not null references public.instruments(ticker),
  effective_date date not null,
  shares         bigint not null,
  primary key (ticker, effective_date)
);
create index if not exists idx_shares_outstanding_history_date
  on public.shares_outstanding_history (ticker, effective_date desc);

alter table public.shares_outstanding_history enable row level security;

drop policy if exists "public read shares_outstanding_history" on public.shares_outstanding_history;
create policy "public read shares_outstanding_history" on public.shares_outstanding_history
  for select using (true);
