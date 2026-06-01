FROM node:24-alpine@sha256:2bdb65ed1dab192432bc31c95f94155ca5ad7fc1392fb7eb7526ab682fa5bf14 AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY web ./web
COPY src ./src
RUN npm run build

FROM node:24-alpine@sha256:2bdb65ed1dab192432bc31c95f94155ca5ad7fc1392fb7eb7526ab682fa5bf14

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
ENV SPORTS_PROJECTOR_LOG_DIR=/data/logs

RUN apk add --no-cache python3 sqlite tzdata

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY python ./python
COPY fixtures ./fixtures

EXPOSE 8080

CMD ["npm", "run", "start:web"]
