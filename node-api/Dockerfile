FROM node:24-alpine AS build
WORKDIR /app/node-api
COPY node-api/package*.json ./
RUN npm ci
COPY node-api/tsconfig.json ./
COPY node-api/src ./src
RUN npm run build && npm prune --omit=dev
FROM node:24-alpine
WORKDIR /app
COPY --from=build /app/node-api/node_modules ./node_modules
COPY --from=build /app/node-api/package.json ./
COPY --from=build /app/node-api/dist ./dist
COPY shared/queries.json ./queries.json
USER node
EXPOSE 8080
CMD ["node", "dist/server.js"]
