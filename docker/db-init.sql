-- Runs once, when the Postgres volume is first created. The main database comes from
-- POSTGRES_DB; this adds a separate one for the integration tests.
CREATE DATABASE competitorpulse_test;
