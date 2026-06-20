FROM node:20-slim AS build

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc

FROM node:20-slim

WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY --from=build /app/dist/ ./dist/
RUN mkdir -p data

ENV NODE_ENV=production

CMD ["node", "dist/index.js"]
