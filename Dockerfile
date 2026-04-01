# Production image: compiled JS only (run `npm run build` before deploy).
FROM node:20-alpine
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY dist ./dist
COPY public ./public

EXPOSE 3000
CMD ["node", "dist/src/server.js"]
