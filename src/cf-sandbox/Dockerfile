# Control Plan — CF Sandbox container image
FROM docker.io/cloudflare/sandbox:0.12.3

# Default image: Ubuntu 22.04, Node.js 20, npm, Bun, curl, wget, git, jq, zip, unzip
# git in this base uses libcurl-gnutls. We update CA certs and set conservative
# HTTP timeouts to make gnutls TLS more reliable with GitHub.
RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates && \
    rm -rf /var/lib/apt/lists/* && \
    update-ca-certificates && \
    git config --system http.postBuffer 524288000 && \
    git config --system http.lowSpeedLimit 1000 && \
    git config --system http.lowSpeedTime 60

WORKDIR /workspace
