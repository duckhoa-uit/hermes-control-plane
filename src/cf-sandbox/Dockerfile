# Hermes Control Plane — CF Sandbox container image
# Extends the default sandbox image with everything an agent needs.
FROM docker.io/cloudflare/sandbox:0.7.0

# Default image already includes:
#   Ubuntu 22.04, Node.js 20 LTS, npm, Bun 1.x,
#   curl, wget, git, jq, zip, unzip

# Install any additional system packages here if needed:
# RUN apt-get update && apt-get install -y <pkg> && rm -rf /var/lib/apt/lists/*

# Set working directory — sandbox commands default here
WORKDIR /workspace

# Bun and Node are already available.
# The agent uses sandbox.gitCheckout to clone repos,
# sandbox.exec to run npm install / npm test, and
# sandbox.readFile/writeFile for file operations.
# Pi harness runs in the DO, not in this sandbox.
