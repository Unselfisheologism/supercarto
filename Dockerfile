# Glama (and other MCP registries) run this image and send MCP
# initialize / tools-list requests into the server's stdio. No API key is
# required: map data, terrain, keyless weather and daylight all work
# without one; set SUPERCARTO_OWM_KEY and the GTFS variables for traffic
# and transit.
ARG NODE_VERSION=22-alpine
FROM node:${NODE_VERSION}

ARG SUPERCARTO_VERSION=latest
RUN npm install -g "supercarto@${SUPERCARTO_VERSION}"

# Startup + introspection probe: send an MCP initialize over stdio and
# require a serverInfo reply, so a broken install fails the image build
# instead of the registry's check.
RUN echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"0.0.0"}}}' \
    | supercarto mcp 2>/dev/null | grep -q '"serverInfo"'

ENTRYPOINT ["supercarto", "mcp"]
