# Hub: supervisor + agents (pi SDK) + dashboard statics.
FROM node:22-slim

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev && rm -rf ~/.npm
COPY tsconfig.json ./
COPY src ./src
COPY public ./public

EXPOSE 8080
CMD ["npx", "tsx", "src/index.ts"]
