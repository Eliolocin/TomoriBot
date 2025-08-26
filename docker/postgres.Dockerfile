# PostgreSQL with pg_cron extension for TomoriBot
FROM postgres:15

# Install pg_cron extension
RUN apt-get update && apt-get install -y \
    postgresql-15-cron \
    && rm -rf /var/lib/apt/lists/*

# Set shared_preload_libraries to include pg_cron
RUN echo "shared_preload_libraries = 'pg_cron'" >> /usr/share/postgresql/postgresql.conf.sample
RUN echo "cron.database_name = 'tomodb'" >> /usr/share/postgresql/postgresql.conf.sample