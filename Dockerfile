# Optional container build. The native binary + system TeX Live is lighter;
# use this if you prefer containers.

FROM node:22-bookworm-slim AS web
WORKDIR /src/web
COPY web/package.json ./
RUN npm install --no-audit --no-fund
COPY web/ ./
RUN npm run build

FROM rust:1-bookworm AS server
WORKDIR /src
COPY Cargo.toml ./
COPY src ./src
COPY --from=web /src/web/static ./web/static
RUN cargo build --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
        latexmk texlive-latex-recommended texlive-latex-extra texlive-fonts-recommended \
        texlive-science texlive-pictures texlive-bibtex-extra biber \
        texlive-xetex texlive-luatex lmodern ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --home /data underleaf && mkdir -p /data && chown underleaf /data
COPY --from=server /src/target/release/underleaf /usr/local/bin/underleaf
USER underleaf
ENV UNDERLEAF_DATA=/data UNDERLEAF_BIND=0.0.0.0:8080
VOLUME /data
EXPOSE 8080
CMD ["underleaf"]
