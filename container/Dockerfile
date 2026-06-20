# Bastion cloud-proxy container image — tiny Node server that proxies device API
# calls with TLS verification disabled (for self-signed firewall mgmt planes).
FROM node:22-alpine

WORKDIR /app
COPY server.mjs ./

# The Container class connects to defaultPort (8080).
ENV PORT=8080
EXPOSE 8080

# No dependencies — uses Node's built-in http + global fetch.
CMD ["node", "server.mjs"]
