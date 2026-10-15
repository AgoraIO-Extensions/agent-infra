FROM node:24-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
USER 10001:10001
EXPOSE 8080
CMD ["node", "server.js"]
