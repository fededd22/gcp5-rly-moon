# syntax=docker/dockerfile:1

# =============================================================================
# Étape 1 : build (bundle du bot/serveur Express+Telegram avec esbuild)
# -----------------------------------------------------------------------------
# Il n'y a plus de frontend (React/Vite) à compiler : toute l'administration se
# fait désormais via le bot Telegram. Cette étape ne fait que bundler server.ts.
# =============================================================================
FROM node:22-slim AS builder

WORKDIR /app

# Installe les dépendances. Pas de package-lock.json fourni (les dépendances
# frontend ont été retirées) -> npm install régénère un lockfile cohérent.
# Pour des builds reproductibles, exécutez `npm install` localement une fois,
# committez le package-lock.json généré, puis remplacez cette ligne par `npm ci`.
COPY package.json ./
RUN npm install

# Copie le reste des sources et build (serveur -> dist/server.cjs)
COPY . .
RUN npm run build

# =============================================================================
# Étape 2 : image d'exécution (image finale, allégée)
# =============================================================================
FROM node:22-slim AS runtime

WORKDIR /app

# curl + unzip + ca-certificates sont nécessaires car server.ts télécharge
# automatiquement le binaire V2Ray/Xray (depuis GitHub) au premier démarrage.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl unzip ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production

# Dépendances de production uniquement
COPY package.json ./
RUN npm install --omit=dev

# Artefact buildé (bot/serveur bundlé) et fichiers de config nécessaires au
# runtime (server.ts les lit via process.cwd()).
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/server.ts ./server.ts
COPY config.json ./config.json
COPY .env.example ./.env.example

# Script d'entrée : détecte automatiquement le port d'écoute
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Le port réel est déterminé dynamiquement (variable PORT ou valeur détectée
# dans server.ts). 3000 sert uniquement au health-check HTTP ; les autres
# sont les ports V2Ray/VLESS/VMess/Trojan des slots A et B définis dans server.ts.
EXPOSE 3000 10080 10081 10082 10090 10091 10092

# Vérifie que le serveur répond sur le port réellement utilisé (auto-détecté)
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD sh -c 'curl -fsS "http://127.0.0.1:${PORT:-3000}/" || exit 1'

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/server.cjs"]
