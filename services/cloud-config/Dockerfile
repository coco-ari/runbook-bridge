FROM node:24-bookworm-slim
WORKDIR /app
COPY src/cloud-config-crypto.mjs src/errors.mjs ./src/
COPY services/cloud-config/server.mjs ./services/cloud-config/
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 3000
CMD ["node", "services/cloud-config/server.mjs"]
