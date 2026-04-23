FROM node:25-alpine

WORKDIR /app

COPY package.json ./
COPY backend ./backend
COPY shared ./shared

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8080
ENV DATABASE_PATH=/data/randompick.db

EXPOSE 8080

CMD ["node", "backend/server.js"]
