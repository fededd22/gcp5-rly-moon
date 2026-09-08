#!/bin/sh
set -e

# --- Détection automatique du port d'écoute -------------------------------
# Ordre de priorité :
#   1. Variable d'environnement PORT fournie par la plateforme d'hébergement
#      (Cloud Run, Render, Railway, Fly.io, etc. l'injectent automatiquement)
#   2. Valeur codée en dur trouvée dans server.ts (const PORT = ...)
#   3. Valeur par défaut : 3000
# ---------------------------------------------------------------------------
if [ -z "$PORT" ]; then
  DETECTED_PORT=$(grep -oE "const PORT = [A-Za-z0-9_.() |]*[0-9]+" /app/server.ts 2>/dev/null \
    | grep -oE "[0-9]+" | tail -n1 || true)
  export PORT="${DETECTED_PORT:-3000}"
  echo "[entrypoint] Aucune variable PORT définie -> port détecté automatiquement dans server.ts : $PORT"
else
  echo "[entrypoint] Variable d'environnement PORT détectée : $PORT"
fi

echo "[entrypoint] L'application va écouter sur le port $PORT"

# --- Augmentation de la limite de descripteurs de fichiers ----------------
# Avec potentiellement des milliers d'utilisateurs connectés en même temps
# (chacun ouvrant un socket WebSocket), la limite par défaut (souvent 1024)
# est vite atteinte et de nouvelles connexions échouent silencieusement.
# On relève cette limite au démarrage du conteneur, dans la mesure permise
# par l'hôte Docker (ulimit -n peut échouer sans droits suffisants -- on
# ignore alors l'erreur plutôt que de bloquer le démarrage).
ulimit -n 65536 2>/dev/null || echo "[entrypoint] Impossible d'augmenter ulimit -n (droits insuffisants), valeur actuelle : $(ulimit -n)"

exec "$@"
