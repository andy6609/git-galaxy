-- Open-source Galaxy canonical universe ledger.
-- The browser never receives database credentials; FastAPI is the only writer.

create extension if not exists citext;

create table if not exists meta (
  k text primary key,
  v text
);

create table if not exists galaxies (
  id integer primary key,
  name text,
  cx double precision,
  cy double precision,
  cz double precision,
  nx double precision,
  ny double precision,
  nz double precision,
  radius double precision
);

create table if not exists regions (
  id integer primary key,
  galaxy integer,
  name text,
  cx double precision,
  cy double precision,
  cz double precision,
  radius double precision
);

create table if not exists accounts (
  id text primary key,
  login citext unique,
  kind text,
  name text,
  galaxy integer,
  region integer,
  cx double precision,
  cy double precision,
  cz double precision,
  nx double precision,
  ny double precision,
  nz double precision,
  truncated integer,
  src text,
  fetched_at text,
  placed_at text,
  placement_version integer,
  origin text,
  vec bytea
);

create table if not exists repos (
  id text primary key,
  account text references accounts(id) on delete cascade,
  name citext,
  "desc" text,
  topics text,
  lang text,
  stars integer,
  archived integer,
  created text,
  pushed text,
  license text,
  observed text,
  src text,
  packages text,
  ring integer,
  angle double precision,
  x double precision,
  y double precision,
  z double precision,
  placed_at text,
  visible integer default 1
);

create table if not exists edges (
  s text,
  t text,
  kind text,
  via text,
  primary key (s, t)
);

create table if not exists packages (
  eco text,
  name citext,
  repo text,
  primary key (eco, name)
);

create index if not exists repos_account on repos(account);
create index if not exists repos_name on repos(name);
create index if not exists accounts_placed on accounts(placed_at, id);
create index if not exists repos_placed on repos(placed_at, id);

-- Direct Postgres access is server-only. Keep the generated Data API closed
-- until a deliberate public/authenticated policy is designed.
alter table meta enable row level security;
alter table galaxies enable row level security;
alter table regions enable row level security;
alter table accounts enable row level security;
alter table repos enable row level security;
alter table edges enable row level security;
alter table packages enable row level security;

revoke all on table meta, galaxies, regions, accounts, repos, edges, packages
  from anon, authenticated;
