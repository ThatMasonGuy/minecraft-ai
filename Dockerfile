FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json webpack.viewer.cjs ./
COPY src ./src
COPY viewer ./viewer
RUN npm run build

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/viewer ./viewer
RUN mkdir -p /app/data
VOLUME ["/app/data"]
CMD ["node", "dist/src/main.js"]
