-- Execute este script no Supabase: Dashboard > SQL Editor > New query > Run

-- Tabela única que guarda tanto anotações quanto itens com checkbox e marcador
create table board_items (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('note', 'checkbox')) default 'checkbox',
  content text not null default '',
  checked boolean not null default false,
  marker text,                -- ex: 'red', 'yellow', 'green', 'blue' ou null
  position integer not null default 0,
  updated_by_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Liga a segurança em nível de linha (RLS)
alter table board_items enable row level security;

-- Qualquer usuário logado pode ler tudo (quadro compartilhado)
create policy "authenticated can read board_items"
  on board_items for select
  to authenticated
  using (true);

-- Qualquer usuário logado pode criar itens
create policy "authenticated can insert board_items"
  on board_items for insert
  to authenticated
  with check (true);

-- Qualquer usuário logado pode editar qualquer item (checkbox, texto, marcador)
create policy "authenticated can update board_items"
  on board_items for update
  to authenticated
  using (true);

-- Qualquer usuário logado pode apagar itens
create policy "authenticated can delete board_items"
  on board_items for delete
  to authenticated
  using (true);

-- Habilita atualização em tempo real (opcional, mas recomendado):
-- para que outro usuário logado veja a mudança sem precisar recarregar a página
alter publication supabase_realtime add table board_items;
