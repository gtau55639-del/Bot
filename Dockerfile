FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
# devDependencies are needed for the build (tsc, vite); pruned afterwards.
RUN npm install --include=dev
COPY . .
RUN npm run build && npm prune --omit=dev
ENV NODE_ENV=production PORT=4000 BOTLAUNCH_STORAGE=/app/storage
RUN mkdir -p /app/storage && chown -R node:node /app
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s CMD wget -qO- http://127.0.0.1:4000/api/health || exit 1
CMD ["npm", "start"]
