FROM node:22-alpine3.21 AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build


FROM node:22-alpine3.21 AS runtime

WORKDIR /app

ENV NODE_ENV=production

RUN apk upgrade --no-cache # Upgrade all packages to their latest versions - this is important for security

COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY --from=builder /app/dist ./dist

EXPOSE 3000

CMD ["node", "dist/api/index.js"]
