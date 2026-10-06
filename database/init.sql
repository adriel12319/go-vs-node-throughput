\set ON_ERROR_STOP on
\timing on
CREATE EXTENSION pg_stat_statements;
CREATE EXTENSION pg_prewarm;
CREATE TABLE products (
    id integer NOT NULL,
    tenant_id integer NOT NULL,
    category_id integer NOT NULL,
    name text NOT NULL,
    price_cents integer NOT NULL CHECK (price_cents >= 0),
    stock integer NOT NULL CHECK (stock >= 0),
    active boolean NOT NULL
);
-- Bulk generation inside PostgreSQL: no application loops or network traffic.
-- Build every index after loading the 5.1 million rows.
INSERT INTO products
SELECT i, ((i-1) % 1000)+1, (((i-1)/1000) % 100)+1,
       'Product ' || lpad(i::text, 7, '0'),
       ((i::bigint * 37) % 100000)::integer + 100,
       (i % 500), (((i-1)/100000) % 10) <> 0
FROM generate_series(1, 5100000) AS s(i);
ALTER TABLE products ADD PRIMARY KEY (id);
CREATE INDEX products_tenant_category_page ON products (tenant_id, category_id, id)
    INCLUDE (name, price_cents, stock) WHERE active = true;
CREATE TABLE inventory (
    product_id integer PRIMARY KEY REFERENCES products(id),
    available integer NOT NULL CHECK (available >= 0)
) WITH (fillfactor=80, autovacuum_vacuum_scale_factor=0.02);
INSERT INTO inventory SELECT i, 1000000 FROM generate_series(1, 100000) AS s(i);
VACUUM (ANALYZE, FREEZE) products;
VACUUM (ANALYZE, FREEZE) inventory;
CREATE TABLE benchmark_meta (
    id integer PRIMARY KEY CHECK (id = 1),
    ready boolean NOT NULL,
    product_count integer NOT NULL,
    inventory_count integer NOT NULL,
    seeded_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO benchmark_meta (id, ready, product_count, inventory_count)
SELECT 1, true, (SELECT count(*) FROM products), (SELECT count(*) FROM inventory);
