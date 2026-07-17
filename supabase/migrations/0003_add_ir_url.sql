-- Radar RI - adiciona o link do site de RI de cada empresa/peer.
-- Rode depois do 0001 e 0002. Idempotente (ALTER ... IF NOT EXISTS + UPDATE).

alter table public.instruments add column if not exists ir_url text;

-- Seed inicial (aba "Site RI" da planilha, gid=435768027). O script de sync
-- (scripts/sync-market-data.mjs) mantem isso atualizado automaticamente depois;
-- isso aqui e so pra ja funcionar antes do primeiro sync rodar.
update public.instruments set ir_url = case ticker
  when 'CASH3' then 'https://ri.meliuz.com.br/'
  when 'BMOB3' then 'https://ri.bemobi.com.br/'
  when 'LWSA3' then 'https://ri.lwsa.tech/'
  when 'TOTS3' then 'https://ri.totvs.com/'
  when 'DOTZ3' then 'https://ri.dotz.com.br/'
  when 'INTB3' then 'https://ri.intelbras.com.br/'
  when 'IBTA'  then 'https://investors.ibotta.com/'
  when 'AMER3' then 'https://ri.americanas.io/'
  when 'MGLU3' then 'https://ri.magazineluiza.com.br/default.aspx?linguagem=pt'
  when 'ALPA4' then 'https://ri.alpargatas.com.br/'
  when 'BHIA3' then 'https://ri.grupocasasbahia.com.br/'
  when 'RADL3' then 'https://ri.rdsaude.com.br/'
  when 'MELI'  then 'https://investor.mercadolibre.com/'
  when 'AZZA3' then 'https://ri.azzas2154.com.br/'
  when 'OBTC3' then 'https://ri.oranjebtc.com/'
  when 'MSTR'  then 'https://www.strategy.com/investor-relations'
  when 'XYZ'   then 'https://investors.block.xyz/overview/default.aspx'
  when 'ALCPB' then 'https://cptlb.com/investors/news-financial-information/'
  when 'MTPLF' then 'https://metaplanet.jp/en/disclosures'
  else ir_url
end
where ticker in ('CASH3','BMOB3','LWSA3','TOTS3','DOTZ3','INTB3','IBTA','AMER3','MGLU3','ALPA4','BHIA3','RADL3','MELI','AZZA3','OBTC3','MSTR','XYZ','ALCPB','MTPLF');
