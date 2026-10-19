# The fake-service container: Node for the server, openssl for the sandbox certificate authority.
FROM node:24-alpine
RUN apk add --no-cache openssl ca-certificates
