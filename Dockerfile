FROM node:22-bookworm-slim
WORKDIR /app
# Copy the whole project before npm ci because postinstall runs
# scripts/patch-pathfinder.js from the project root.
COPY . .
RUN npm ci --no-audit --no-fund
RUN npm test
EXPOSE 5000
CMD ["npm", "start"]
