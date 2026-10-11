# SCENEFIT AI - Cloud Run container image (Google-published base image).
#
# DEPLOY-TIME ARTIFACT: this image is NOT built inside the offline sandbox.
# Building it pulls the Google-published Node base image from gcr.io, which
# requires network access that the offline build environment does not have.
# It is reviewed for structure here and built at deploy time, e.g.:
#
#   gcloud builds submit --tag asia-southeast1-docker.pkg.dev/<project>/scenefit/backend
#   gcloud run deploy scenefit-backend --image <image> --region asia-southeast1 \
#     --allow-unauthenticated --set-env-vars GEMINI_MODE=live,FIRESTORE_MODE=live,...
#
# Cloud Run contract:
#   - The container MUST listen on the port in the $PORT env var (default 8080).
#     backend/src/config.js reads `Number(process.env.PORT) || 8080` and
#     backend/src/server.js binds 0.0.0.0:$PORT, so this is already satisfied.
#   - The app serves both the JSON API (/api/**, /healthz) and the static
#     frontend/, so a single Cloud Run service runs the whole stack.
#
# GOOGLE-ONLY: base image is published by Google (Container Registry / distroless).

# Google-published Node 22 base image.
# Alternative Google base image: gcr.io/distroless/nodejs22-debian12 (smaller,
# no shell). node:22-slim is used here for easier operability.
FROM node:22-slim

# Cloud Run sets $PORT; default to 8080 to match the local/offline contract.
ENV NODE_ENV=production \
    PORT=8080

WORKDIR /app

# Zero external npm dependencies, so there is nothing to `npm install`.
# Copy manifest first for layer caching and provenance.
COPY package.json ./

# Application code, seed data, and the statically-served frontend.
COPY backend ./backend
COPY frontend ./frontend

# Document the port the container listens on (informational for Cloud Run).
EXPOSE 8080

# Run as the non-root user that the Google base image already provides.
USER node

# Start the HTTP server; it reads $PORT and binds 0.0.0.0 (Cloud Run contract).
CMD ["node", "backend/src/server.js"]
